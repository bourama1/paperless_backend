import axios from "axios";
import { getDb } from "../config/database";
import { handleLabelPrinting } from "./labelPrintingService";
import { DOCUMENT_TYPES } from "../config/documentTypes";

const WORKSTATIONS_API_URL =
    process.env.WORKSTATIONS_API_URL ||
    "http://10.110.60.21:40000/api/p2l/services/workstations_process";

export const DOC_MANAGER_URL =
    process.env.DOC_MANAGER_URL || "http://10.110.60.21:40000";

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

async function printDocumentsForOrder(order: OrderUpdate["order"]) {
    console.log(
        `Order ${order._id} (${order.productOrder}) at ${order.workplace}. Fetching documents...`,
    );

    if (!order.projectNumber || !order.position) {
        console.log(
            `[DOCS] projectNumber or position empty — skipping document fetch for order ${order.productOrder}`,
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
            const docs = await fetchDocumentsByType(order, typeId);
            docsToPrint.push(...docs);
            console.log(`Found ${docs.length} documents of type ${typeId}`);
        }

        await triggerPrinting(docsToPrint, order);
    } catch (error) {
        console.error("Error in printDocumentsForOrder:", error);
    }
}

async function fetchDocumentsByType(
    order: OrderUpdate["order"],
    documentType: number,
): Promise<string[]> {
    try {
        const url = `${DOC_MANAGER_URL}/api/documents/fetch`;
        const response = await axios.get<{ file_path: string }[]>(url, {
            params: {
                order_code: order.projectNumber,
                position_code: order.position,
                document_type: documentType,
            },
            timeout: 10000,
        });

        if (Array.isArray(response.data)) {
            return response.data.map((d) => d.file_path);
        }
        return [];
    } catch (error) {
        console.error(
            `Error fetching documents type ${documentType} for order ${order.projectNumber}/${order.position}:`,
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
    documentType?: number;
}

export interface PbomSearchResult {
    customer_code: number;
    order_code: number;
    position_code: number;
}

export const importDocument = async (req: PbomImportRequest) => {
    const docType = req.documentType || DOCUMENT_TYPES.PBOM_HARDWARE;

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
                await axios.get(`${DOC_MANAGER_URL}/api/documents/fetch`, {
                    params: {
                        order_code: matchingOrder,
                        position_code: pos,
                        document_type: DOCUMENT_TYPES.PBOM_HARDWARE,
                    },
                    timeout: 5000,
                });
                results.push({
                    customer_code: CUSTOMER_PRODUCTION,
                    order_code:
                        typeof matchingOrder === "number"
                            ? matchingOrder
                            : Number(matchingOrder),
                    position_code: typeof pos === "number" ? pos : Number(pos),
                });
            } catch {
                // no PBOM doc for this position
            }
        }
    } catch (error) {
        console.error("Error searching PBOM:", error);
    }

    return results;
};

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

    const printerName = process.env.DOCUMENTS_PRINTER_NAME || "";

    if (!printerName) {
        console.log(
            `[PRINT] No printer configured — would print ${filePaths.length} documents for order ${order.productOrder} (${order.salesOrder}/${order.position}):`,
        );
        for (const fp of filePaths) {
            console.log(`  - ${fp}`);
        }
        return;
    }

    console.log(
        `[PRINT] Printing ${filePaths.length} documents for order ${order.productOrder} (${order.salesOrder}/${order.position}) to "${printerName}":`,
    );

    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    for (const fp of filePaths) {
        const psCommand = `Start-Process -FilePath "${fp}" -Verb Print -WindowStyle Hidden`;
        console.log(`  - ${fp}`);
        await execFileAsync("powershell.exe", [
            "-NoProfile",
            "-Command",
            psCommand,
        ]);
    }
}
