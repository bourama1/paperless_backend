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

        // Keep the workstations table's cycle_index/total_cycles current so
        // GET /workstations can show live cycle progress (e.g. "2/6")
        // instead of just quantity. These columns already existed in the
        // schema but were never actually written — the external
        // WORKSTATIONS_API_URL poll doesn't carry cycle info, only these
        // order-update webhook calls do.
        await db("workstations").where({ name: update.order.workplace }).update({
            cycle_index: update.cycleIndex,
            total_cycles: update.totalCycles,
        });

        if (update.action === "FINISHED") {
            await db("workstations")
                .where({ name: update.order.workplace })
                .update({ current_order_id: null, current_order_data: null });

            // Queue this order for retention archival (see services/archivalService.ts).
            // We only have projectNumber/position to look the document(s) back up in
            // doc_manager later, same as printDocumentsForOrder does on STARTED — so
            // skip logging if those aren't present, there'd be nothing to fetch.
            if (update.order.projectNumber && update.order.position) {
                await db("order_archive_log")
                    .insert({
                        order_id: update.order._id,
                        project_number: update.order.projectNumber,
                        position: update.order.position,
                        sales_order: update.order.salesOrder,
                        product_order: update.order.productOrder,
                        finished_at: update.datetime
                            ? new Date(update.datetime)
                            : db.fn.now(),
                    })
                    .onConflict("order_id")
                    .ignore();
            } else {
                console.log(
                    `[ARCHIVE] Order ${update.order._id} FINISHED with no projectNumber/position — skipping archival queue`,
                );
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
            io.emit("workstation-order-update", update);
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
    const [docId] = await db("documents")
        .insert({ name: originalName })
        .returning("id");
    const resolvedDocId = typeof docId === "object" ? docId.id : docId;

    await db("revisions").insert({
        document_id: resolvedDocId,
        filename: docRef,
        version: 1,
    });

    const newDoc = await db("documents").where({ id: resolvedDocId }).first();
    const revisions = await db("revisions")
        .where({ document_id: resolvedDocId })
        .orderBy("version", "desc");

    return { ...newDoc, revisions };
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
