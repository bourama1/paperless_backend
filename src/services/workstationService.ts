import axios from "axios";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import { getDb } from "../config/database";
import { handleLabelPrinting, normalizeWorkplace } from "./labelPrintingService";
import {
    DOCUMENT_TYPES,
    BOM_DOCUMENT_TYPES,
    documentTypeName,
    resolvePbomTypeForWorkplace,
} from "../config/documentTypes";
import {
    DOCUMENTS_PRINTER_HOST,
    DOCUMENTS_PRINTER_PORT,
    printPdfFile,
} from "./documentPrinterService";

const WORKSTATIONS_API_URL =
    process.env.WORKSTATIONS_API_URL ||
    "http://10.110.60.21:40000/api/p2l/services/workstations_process";

export const DOC_MANAGER_URL =
    process.env.DOC_MANAGER_URL || "http://tocz-app4:5200";

export interface WorkstationProcess {
    workstation: string;
    order: {
        _id: string;
        position: string;
        productOrder: string;
        projectNumber: string;
        salesOrder: string;
        schedule: string;
        type: string;
        __v: number;
        createdAt: string;
        customer: string;
        customerDesc: string;
        filename: string;
        maxCycle: number;
        productDesc: string;
        quantity: number;
        updatedAt: string;
        workplace: string;
    } | null;
}

export interface OrderUpdate {
    order: {
        _id: string;
        position: string;
        productOrder: string;
        projectNumber: string;
        salesOrder: string;
        schedule: string;
        type: string;
        createdAt: string;
        customer: string;
        customerDesc: string;
        filename: string;
        maxCycle: number;
        productDesc: string;
        quantity: number;
        updatedAt: string;
        workplace: string;
    };
    cycleIndex: number;
    totalCycles: number;
    _id: string;
    datetime: string;
    action: "STARTED" | "FINISHED";
}

/**
 * Extracts the pipeline-sequence number from a station name following the
 * "WS_<number>" convention (WS_01, WS_02, ... — leading zeros fine), so
 * FINISHED handling can tell which of several matching stations is
 * furthest along the line. Returns null for anything that doesn't match,
 * so callers can fall back to a safer default instead of guessing.
 */
export function parseWorkstationSequence(name: string): number | null {
    const match = /^WS_(\d+)$/i.exec(name.trim());
    if (!match) return null;
    return parseInt(match[1]!, 10);
}

/**
 * Returns every cycle of an order that has STARTED but not yet FINISHED,
 * ascending by cycle_index, derived from workstation_log (which records
 * every event with its exact cycle_index — see handleOrderUpdate).
 *
 * STARTED is only ever emitted when a unit enters the first station, and
 * FINISHED only when it exits the last one (never at the stations in
 * between). So when N physical stations are concurrently occupied by the
 * same order, this returns exactly those N cycle numbers: the unit that's
 * been in the line longest (closest to the last station) has the lowest
 * in-flight cycle_index, and the one that entered most recently (still at
 * the first station) has the highest — see resolveStationCycles, which
 * pairs these up with actual station positions.
 */
export async function getInFlightCyclesForOrder(
    orderId: string,
): Promise<{ cycleIndex: number; totalCycles: number }[]> {
    const db = await getDb();
    const rows: { cycle_index: number; total_cycles: number; action: string }[] =
        await db("workstation_log")
            .select("cycle_index", "total_cycles", "action")
            .where({ order_id: orderId })
            .orderBy([
                { column: "created_at", order: "asc" },
                { column: "id", order: "asc" },
            ]);

    const inFlight = new Map<number, number>(); // cycle_index -> total_cycles
    for (const row of rows) {
        if (row.action === "STARTED") {
            inFlight.set(row.cycle_index, row.total_cycles);
        } else if (row.action === "FINISHED") {
            inFlight.delete(row.cycle_index);
        }
    }

    return Array.from(inFlight.entries())
        .map(([cycleIndex, totalCycles]) => ({ cycleIndex, totalCycles }))
        .sort((a, b) => a.cycleIndex - b.cycleIndex);
}

export const pollWorkstations = async () => {
    try {
        const response = await axios.get<WorkstationProcess[]>(
            WORKSTATIONS_API_URL,
            {
                timeout: 10000,
            },
        );
        const workstations = response.data;
        const db = await getDb();

        for (const ws of workstations) {
            const orderId = ws.order?._id || null;
            const orderData = ws.order ? JSON.stringify(ws.order) : null;

            const existing = await db("workstations")
                .where({ name: ws.workstation })
                .first();

            if (existing) {
                await db("workstations")
                    .where({ name: ws.workstation })
                    .update({
                        current_order_id: orderId,
                        current_order_data: orderData,
                        last_polled_at: db.fn.now(),
                    });
            } else {
                await db("workstations").insert({
                    name: ws.workstation,
                    current_order_id: orderId,
                    current_order_data: orderData,
                    last_polled_at: db.fn.now(),
                });
            }
        }

        const { io } = require("../index");
        if (io) {
            io.emit("workstations-updated", workstations);
        }
    } catch (error) {
        console.error("Error polling workstations:", error);
    }
};

export const handleOrderUpdate = async (update: OrderUpdate) => {
    try {
        const db = await getDb();

        await db("workstation_log").insert({
            workstation_name: update.order.workplace,
            order_id: update.order._id,
            action: update.action,
            order_snapshot: JSON.stringify(update.order),
            cycle_index: update.cycleIndex,
            total_cycles: update.totalCycles,
        });

        // Persist cycle_index/total_cycles keyed directly by order_id — this
        // is the authoritative record GET /workstations reads from (see
        // getWorkstations). Written unconditionally on the first event for
        // an order, but MONOTONIC after that — see below.
        const orderId = update.order._id;

        try {
            const existingCycleState = await db("order_cycle_state")
                .where({ order_id: orderId })
                .first();

            // A batch order (quantity > 1) can have more than one cycle
            // actively in progress at once — different physical stations
            // working different units of the same order/position
            // concurrently. Events for those cycles don't necessarily
            // arrive in cycle-number order (e.g. a FINISHED for an older,
            // still-in-flight cycle can land after a STARTED for a newer
            // one that's already further along). Since cycle numbers only
            // ever increase for a given order, only accept an update whose
            // cycle_index is >= what's already recorded — this keeps the
            // tracked value pinned to whichever cycle is furthest along,
            // and ignores a late-arriving update for a cycle that's
            // already been superseded, rather than regressing it.
            if (
                !existingCycleState ||
                update.cycleIndex >= existingCycleState.cycle_index
            ) {
                await db("order_cycle_state")
                    .insert({
                        order_id: orderId,
                        cycle_index: update.cycleIndex,
                        total_cycles: update.totalCycles,
                        updated_at: db.fn.now(),
                    })
                    .onConflict("order_id")
                    .merge({
                        cycle_index: update.cycleIndex,
                        total_cycles: update.totalCycles,
                        updated_at: db.fn.now(),
                    });

                console.log(
                    `[WORKSTATIONS] Saved cycle state for order ${orderId}: ${update.cycleIndex}/${update.totalCycles}`,
                );
            } else {
                console.log(
                    `[WORKSTATIONS] Ignoring stale cycle update for order ${orderId}: ` +
                        `${update.action} cycle ${update.cycleIndex} arrived after cycle ${existingCycleState.cycle_index} was already recorded — ` +
                        `a newer cycle of this order is still in progress elsewhere`,
                );
            }
        } catch (err: any) {
            console.error(`[WORKSTATIONS] Failed to save cycle state for order ${orderId}:`, err);
        }

        if (update.action === "FINISHED") {
            try {
                // A FINISHED event doesn't identify which physical
                // workstation sent it — only the order_id. Normally that's
                // fine (one workstation row matches), but for a batch order
                // with multiple physical stations concurrently mid-cycle on
                // the SAME order_id, several rows can match at once.
                //
                // FINISHED is only ever emitted by the LAST workstation in
                // the line (STARTED is emitted by the first, on entry) — so
                // when several stations match, we don't need to guess: pick
                // the one that's furthest along the line and clear only
                // that one. Station names follow a "WS_<number>" pipeline-
                // sequence convention (WS_01 = first, WS_05 = last, etc.),
                // so the highest-numbered matching station is the one that
                // just finished. If any matching name doesn't parse as
                // WS_<number>, we can't trust the ordering — fall back to
                // skipping the eager clear and let the next
                // pollWorkstations() tick resolve it safely instead.
                const matchingById = await db("workstations").where({
                    current_order_id: orderId,
                });
                const matchingByJson = await db("workstations").whereRaw(
                    "current_order_data LIKE ?",
                    [`%\"_id\":\"${orderId}\"%`],
                );
                const matchingRows = new Map<number, { id: number; name: string }>();
                for (const row of [...matchingById, ...matchingByJson]) {
                    matchingRows.set(row.id, { id: row.id, name: row.name });
                }
                const matches = Array.from(matchingRows.values());

                if (matches.length === 1) {
                    await db("workstations")
                        .where({ id: matches[0]!.id })
                        .update({ current_order_id: null, current_order_data: null });
                    console.log(
                        `[WORKSTATIONS] Cleared order ${orderId} from workstation ${matches[0]!.name} (unambiguous match)`,
                    );
                } else if (matches.length > 1) {
                    const parsed = matches.map((m) => ({
                        ...m,
                        seq: parseWorkstationSequence(m.name),
                    }));
                    const lastStation =
                        parsed.every((m) => m.seq !== null) ?
                            parsed.reduce((a, b) => ((b.seq as number) > (a.seq as number) ? b : a))
                        :   null;

                    if (lastStation) {
                        await db("workstations")
                            .where({ id: lastStation.id })
                            .update({ current_order_id: null, current_order_data: null });
                        console.log(
                            `[WORKSTATIONS] Order ${orderId} matched ${matches.length} workstations ` +
                                `(${matches.map((m) => m.name).join(", ")}) — cleared ${lastStation.name} as the last ` +
                                `station in the line (FINISHED is only ever emitted there)`,
                        );
                    } else {
                        console.log(
                            `[WORKSTATIONS] Order ${orderId} matches ${matches.length} workstation rows ` +
                                `(${matches.map((m) => m.name).join(", ")}) but at least one name doesn't parse as ` +
                                `WS_<number> — can't determine which is last, skipping eager clear; next poll will resolve it`,
                        );
                    }
                }
            } catch (err: any) {
                console.error(`[WORKSTATIONS] Failed to clear finished order ${orderId}:`, err);
            }
        }

        if (update.action === "STARTED") {
            // Print documents (PBOM, declarations, confirmations) on STARTED
            printDocumentsForOrder(update.order).catch((err) =>
                console.error("Error printing documents:", err),
            );
        }

        // Trigger label printing (filtered by LABEL_PRINT_TRIGGER inside)
        handleLabelPrinting(update).catch((err) =>
            console.error("[LABELS] Error in handleLabelPrinting:", err),
        );

        const { io } = require("../index");
        if (io) {
            // Emit the specific order update event (for listeners that want the payload)
            io.emit("workstation-order-update", update);
            // Also emit a generic workstations-updated event so clients that only
            // listen for the polling update trigger will refetch their /workstations
            // view (this ensures STARTED events also refresh all clients immediately).
            io.emit("workstations-updated");
        }
    } catch (error) {
        console.error("Error handling order update:", error);
        throw error;
    }
};

/**
 * Resolves which order identifier to query doc_manager with. Prefers
 * projectNumber, falling back to salesOrder, then productOrder, since not
 * every order payload carries all three.
 */
function resolveOrderCode(order: OrderUpdate["order"]): string {
    return order.projectNumber || order.salesOrder || order.productOrder || "";
}

/** Document printing (PBOM/declarations/confirmation) only applies to Hardware. */
function isDocumentPrintWorkplace(workplace: string): boolean {
    return normalizeWorkplace(workplace || "") === "hardware";
}

/** Has this projectNumber/position combo already had its documents printed? */
async function hasAlreadyPrintedDocuments(
    orderCode: string,
    position: string,
): Promise<boolean> {
    const db = await getDb();
    const hit = await db("document_print_log")
        .where({ project_number: orderCode, position })
        .first();
    return !!hit;
}

async function recordDocumentPrint(
    orderCode: string,
    position: string,
    orderId: string,
) {
    const db = await getDb();
    await db("document_print_log")
        .insert({ project_number: orderCode, position, order_id: orderId })
        .onConflict(["project_number", "position"])
        .ignore();
}

async function printDocumentsForOrder(order: OrderUpdate["order"]) {
    if (!isDocumentPrintWorkplace(order.workplace)) {
        console.log(
            `[DOCS] workplace="${order.workplace}" is not Hardware — skipping document print for order ${order.productOrder}`,
        );
        return;
    }

    console.log(
        `Order ${order._id} (${order.productOrder}) at ${order.workplace}. Fetching documents...`,
    );

    const orderCode = resolveOrderCode(order);

    if (!orderCode || !order.position) {
        console.log(
            `[DOCS] No projectNumber/salesOrder/productOrder or position — skipping document fetch for order ${order.productOrder}`,
        );
        return;
    }

    if (await hasAlreadyPrintedDocuments(orderCode, order.position)) {
        console.log(
            `[DOCS] Already printed documents for ${orderCode}/${order.position} — skipping (order ${order.productOrder})`,
        );
        return;
    }

    try {
        const docsToPrint: string[] = [];

        const typesCsv = process.env.DOCUMENTS_TYPES || "14,4,5,21";
        const typeIds = typesCsv
            .split(",")
            .map((s) => parseInt(s.trim(), 10))
            .filter((n) => !isNaN(n));

        for (const typeId of typeIds) {
            const docs = await fetchDocumentsByType(order, orderCode, typeId);
            docsToPrint.push(...docs);
            console.log(`Found ${docs.length} documents of type ${typeId}`);
        }

        if (docsToPrint.length === 0) {
            // Nothing found yet (documents may not be generated at this
            // point in the order lifecycle) — don't record a "printed"
            // marker, so a later cycle can still pick this up and try again.
            return;
        }

        await triggerPrinting(docsToPrint, order);
        await recordDocumentPrint(orderCode, order.position, order._id);
    } catch (error) {
        console.error("Error in printDocumentsForOrder:", error);
    }
}

async function fetchDocumentsByType(
    order: OrderUpdate["order"],
    orderCode: string,
    documentType: number,
): Promise<string[]> {
    const url = `${DOC_MANAGER_URL}/api/documents/fetch`;

    try {
        const response = await axios.get(url, {
            params: {
                order_code: orderCode,
                position_code: order.position,
                document_type: documentType,
            },
            responseType: "arraybuffer",
            timeout: 10000,
            validateStatus: (status) => status === 200 || status === 404,
        });

        if (response.status === 404) {
            return []; // no document of this type for this order/position
        }

        const cd = response.headers["content-disposition"] || "";
        const fileNameMatch = cd.match(/filename="?(.+?)"?$/);
        const fileName = fileNameMatch
            ? fileNameMatch[1]!.trim()
            : `${orderCode}_${order.position}_${documentType}.pdf`;

        const tmpPath = path.join(
            os.tmpdir(),
            `docprint-${crypto.randomBytes(6).toString("hex")}-${fileName}`,
        );
        fs.writeFileSync(tmpPath, Buffer.from(response.data));

        return [tmpPath];
    } catch (error) {
        console.error(
            `Error fetching documents type ${documentType} for order ${orderCode}/${order.position}:`,
            error,
        );
        return [];
    }
}

export interface PbomImportRequest {
    projectNumber: string;
    position: string;
    customer: string;
    productOrder?: string;
    productDesc?: string;
    workplace?: string; // used to pick the right BOM type when documentType isn't given explicitly
    documentType?: number;
}

export interface PbomSearchResult {
    customer_code: number;
    order_code: number;
    position_code: number;
}

export const importDocument = async (req: PbomImportRequest) => {
    // Explicit documentType wins (e.g. the search screen letting someone
    // pick a specific BOM). Otherwise resolve from workplace — "Motor"
    // opens the Motor BOM, "Hardware" the Hardware BOM, etc. Falls back to
    // PBOM_HARDWARE if workplace is missing/unrecognized.
    const docType =
        req.documentType || resolvePbomTypeForWorkplace(req.workplace || "");

    const fetchUrl = `${DOC_MANAGER_URL}/api/documents/fetch`;

    // Fetch headers to get the real filename from doc_manager (without downloading body)
    const headRes = await axios.get(fetchUrl, {
        params: {
            order_code: req.projectNumber,
            position_code: req.position,
            document_type: docType,
        },
        responseType: "stream",
        timeout: 10000,
    });
    const cd = headRes.headers["content-disposition"] || "";
    const fileNameMatch = cd.match(/filename="?(.+?)"?$/);
    const originalName = fileNameMatch
        ? fileNameMatch[1]!.trim()
        : `P${req.projectNumber}_${req.position}_Hardware.pdf`;
    headRes.data.destroy();

    const docRef = `docmgr://${req.projectNumber}/${req.position}/${docType}`;

    const db = await getDb();

    // Find-or-create: re-opening the same projectNumber/position/documentType
    // should reuse the same documents row rather than creating a fresh
    // duplicate every time it's tapped — otherwise the documents overview
    // (see filesController.getDocumentsOverview) would show one row per
    // *open*, not one row per actual document.
    let doc = await db("documents")
        .where({
            project_number: req.projectNumber,
            position: req.position,
            document_type: docType,
        })
        .first();

    if (!doc) {
        const [docId] = await db("documents")
            .insert({
                name: originalName,
                project_number: req.projectNumber,
                position: req.position,
                document_type: docType,
            })
            .returning("id");
        const resolvedDocId = typeof docId === "object" ? docId.id : docId;

        await db("revisions").insert({
            document_id: resolvedDocId,
            filename: docRef,
            version: 1,
        });

        doc = await db("documents").where({ id: resolvedDocId }).first();
    } else if (doc.name !== originalName) {
        // doc_manager's filename changed since we last saw it (e.g. a new
        // revision was generated there) — keep our display name current.
        await db("documents")
            .where({ id: doc.id })
            .update({ name: originalName, updated_at: db.fn.now() });
        doc = await db("documents").where({ id: doc.id }).first();
    }

    const revisions = await db("revisions")
        .where({ document_id: doc.id })
        .orderBy("version", "desc");

    return { ...doc, revisions };
};

const CUSTOMER_PRODUCTION = 0;

export const searchPbom = async (
    orderCode: string,
): Promise<PbomSearchResult[]> => {
    const results: PbomSearchResult[] = [];
    const searchStr = String(orderCode);

    try {
        const ordersRes = await axios.get<unknown>(
            `${DOC_MANAGER_URL}/api/customers/${CUSTOMER_PRODUCTION}/orders`,
            {
                timeout: 10000,
            },
        );
        const orders = Array.isArray(ordersRes.data) ? ordersRes.data : [];

        const matchingOrder = orders.find((o: unknown) =>
            String(o).includes(searchStr),
        );
        if (matchingOrder === undefined) return results;

        const positionsRes = await axios.get<unknown>(
            `${DOC_MANAGER_URL}/api/orders/${CUSTOMER_PRODUCTION}/${matchingOrder}/positions`,
            { timeout: 5000 },
        );
        const positions = Array.isArray(positionsRes.data)
            ? positionsRes.data
            : [];

        for (const pos of positions) {
            try {
                // A position belongs in search results if it has ANY BOM
                // type available — not just Hardware specifically, or a
                // position whose only BOM is e.g. Motor would silently
                // never show up in search.
                const types = await listAvailablePbomTypes(
                    String(matchingOrder),
                    String(pos),
                );
                if (types.length > 0) {
                    results.push({
                        customer_code: CUSTOMER_PRODUCTION,
                        order_code:
                            typeof matchingOrder === "number"
                                ? matchingOrder
                                : Number(matchingOrder),
                        position_code:
                            typeof pos === "number" ? pos : Number(pos),
                    });
                }
            } catch {
                // no BOM doc for this position
            }
        }
    } catch (error) {
        console.error("Error searching PBOM:", error);
    }

    return results;
};

export interface PbomTypeOption {
    document_type: number;
    name: string;
}

/**
 * Lists which BOM document types actually exist for a given order/position,
 * by probing doc_manager for each candidate type (HEAD-style: we only read
 * headers/status, never the file body, so this stays cheap even though
 * it's one request per candidate type). Used by the search screen so
 * someone can pick any BOM that's actually there, instead of assuming
 * Hardware.
 */
export const listAvailablePbomTypes = async (
    orderCode: string,
    position: string,
): Promise<PbomTypeOption[]> => {
    const fetchUrl = `${DOC_MANAGER_URL}/api/documents/fetch`;
    const available: PbomTypeOption[] = [];

    await Promise.all(
        BOM_DOCUMENT_TYPES.map(async (documentType) => {
            try {
                const res = await axios.get(fetchUrl, {
                    params: {
                        order_code: orderCode,
                        position_code: position,
                        document_type: documentType,
                    },
                    responseType: "stream",
                    timeout: 8000,
                    validateStatus: (status) => status === 200 || status === 404,
                });
                if (res.status === 200) {
                    res.data.destroy(); // we only need to know it exists, not its content
                    available.push({
                        document_type: documentType,
                        name: documentTypeName(documentType),
                    });
                } else {
                    res.data.destroy();
                }
            } catch {
                // connection issue / timeout — treat as "not available"
            }
        }),
    );

    // Stable, predictable order matching BOM_DOCUMENT_TYPES rather than
    // whatever order the parallel requests happened to resolve in.
    available.sort(
        (a, b) =>
            BOM_DOCUMENT_TYPES.indexOf(a.document_type) -
            BOM_DOCUMENT_TYPES.indexOf(b.document_type),
    );

    return available;
};

// ── standard document printing (PBOM, declarations, confirmations) ─────────
//
// Prints to DOCUMENTS_PRINTER_HOST via documentPrinterService (Ghostscript
// render → raw TCP to the printer's JetDirect/raw port). QR stickers use
// the exact same pipeline and the same printer — see
// labelPrintingService.ts's handleQrSticker/printQrPng.
//
// NOTE: Godex label printing is unrelated and keeps its own UNC print-share
// config (LABEL_PRINTER_UNC_PATH) in labelPrintingService.ts.

async function triggerPrinting(
    filePaths: string[],
    order: OrderUpdate["order"],
) {
    if (filePaths.length === 0) {
        console.log(
            `[PRINT] No documents to print for order ${order.productOrder}`,
        );
        return;
    }

    // filePaths are temp files downloaded by fetchDocumentsByType — always
    // clean them up once we're done with them, print or dry-run either way.
    const cleanup = () => {
        for (const fp of filePaths) {
            fs.unlink(fp, () => {});
        }
    };

    if (!DOCUMENTS_PRINTER_HOST) {
        console.log(
            `[PRINT] No printer configured (DOCUMENTS_PRINTER_HOST empty) — would print ${filePaths.length} documents for order ${order.productOrder} (${order.salesOrder}/${order.position}):`,
        );
        for (const fp of filePaths) {
            console.log(`  - ${fp}`);
        }
        cleanup();
        return;
    }

    console.log(
        `[PRINT] Printing ${filePaths.length} documents for order ${order.productOrder} (${order.salesOrder}/${order.position}) to ${DOCUMENTS_PRINTER_HOST}:${DOCUMENTS_PRINTER_PORT}:`,
    );

    for (const fp of filePaths) {
        try {
            await printPdfFile(fp);
            console.log(`  - printed ${fp}`);
        } catch (err: any) {
            console.error(`[PRINT] Failed to print ${fp}: ${err.message}`);
        }
    }
    cleanup();
}
