import axios from "axios";
import { getDb, insertGetId } from "../config/database";
import { handleLabelPrinting } from "./labelPrintingService";

const WORKSTATIONS_API_URL =
    process.env.WORKSTATIONS_API_URL || "http://10.110.60.21:40000/api/p2l/services/workstations_process";

const DOC_MANAGER_URL = process.env.DOC_MANAGER_URL || "http://10.110.60.21:40000";

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
        const response = await axios.get<WorkstationProcess[]>(WORKSTATIONS_API_URL, {
            timeout: 10000,
        });
        const workstations = response.data;
        const db = await getDb();

        for (const ws of workstations) {
            const orderId = ws.order?._id || null;
            const orderData = ws.order ? JSON.stringify(ws.order) : null;

            const existing = await db("workstations").where("name", ws.workstation).first();

            if (existing) {
                await db("workstations").where("name", ws.workstation).update({
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
                .where("name", update.order.workplace)
                .update({ current_order_id: null, current_order_data: null });

            handleOrderFinished(update.order).catch((err) => console.error("Error handling finished order:", err));
        }

        handleLabelPrinting(update).catch((err) => console.error("[LABELS] Error in handleLabelPrinting:", err));

        const { io } = require("../index");
        if (io) {
            io.emit("workstation-order-update", update);
        }
    } catch (error) {
        console.error("Error handling order update:", error);
        throw error;
    }
};

const DOC_TYPE_NAMES: Record<number, string> = {
    4: "DeclarationOfConformity",
    5: "DeclarationOfPerformance",
    14: "PBOM_Hardware",
};

const DOC_TYPES_TO_PRINT: number[] = (() => {
    const raw = process.env.DOC_TYPES_TO_PRINT || "14,4,5";
    return raw
        .split(",")
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !isNaN(n));
})();

const DEFAULT_DOC_TYPE: number = DOC_TYPES_TO_PRINT[0] ?? 14;

async function handleOrderFinished(order: OrderUpdate["order"]) {
    console.log(`Order ${order._id} (${order.productOrder}) finished at ${order.workplace}. Fetching documents...`);

    try {
        const docsToPrint: string[] = [];

        for (const docType of DOC_TYPES_TO_PRINT) {
            const docs = await fetchDocumentsByType(order, docType);
            docsToPrint.push(...docs);
            const name = DOC_TYPE_NAMES[docType] || `Type${docType}`;
            console.log(`Found ${docs.length} ${name} documents`);
        }

        await triggerPrinting(docsToPrint, order);
    } catch (error) {
        console.error("Error in handleOrderFinished:", error);
    }
}

async function fetchDocumentsByType(order: OrderUpdate["order"], documentType: number): Promise<string[]> {
    try {
        const url = `${DOC_MANAGER_URL}/api/documents/fetch`;
        const response = await axios.get<{ file_path: string }[]>(url, {
            params: {
                order_code: order.salesOrder,
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
            `Error fetching documents type ${documentType} for order ${order.salesOrder}/${order.position}:`,
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
    const docType = req.documentType || DEFAULT_DOC_TYPE;

    const fetchUrl = `${DOC_MANAGER_URL}/api/documents/fetch`;

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
    const originalName =
        fileNameMatch ? fileNameMatch[1]!.trim() : `P${req.projectNumber}_${req.position}_Hardware.pdf`;
    headRes.data.destroy();

    const docRef = `docmgr://${req.projectNumber}/${req.position}/${docType}`;

    const db = await getDb();
    const docId = await insertGetId(db, "documents", { name: originalName });

    await db("revisions").insert({ document_id: docId, filename: docRef, version: 1 });

    const newDoc = await db("documents").where("id", docId).first();
    const revisions = await db("revisions").where("document_id", docId).orderBy("version", "desc");

    return { ...newDoc, revisions };
};

const CUSTOMER_PRODUCTION = 0;

export const searchPbom = async (orderCode: string): Promise<PbomSearchResult[]> => {
    const results: PbomSearchResult[] = [];
    const searchStr = String(orderCode);

    try {
        const ordersRes = await axios.get<unknown>(`${DOC_MANAGER_URL}/api/customers/${CUSTOMER_PRODUCTION}/orders`, {
            timeout: 10000,
        });
        const orders = Array.isArray(ordersRes.data) ? ordersRes.data : [];

        const matchingOrder = orders.find((o: unknown) => String(o).includes(searchStr));
        if (matchingOrder === undefined) return results;

        const positionsRes = await axios.get<unknown>(
            `${DOC_MANAGER_URL}/api/orders/${CUSTOMER_PRODUCTION}/${matchingOrder}/positions`,
            { timeout: 5000 },
        );
        const positions = Array.isArray(positionsRes.data) ? positionsRes.data : [];

        for (const pos of positions) {
            try {
                await axios.get(`${DOC_MANAGER_URL}/api/documents/fetch`, {
                    params: {
                        order_code: matchingOrder,
                        position_code: pos,
                        document_type: DEFAULT_DOC_TYPE,
                    },
                    timeout: 5000,
                });
                results.push({
                    customer_code: CUSTOMER_PRODUCTION,
                    order_code: typeof matchingOrder === "number" ? matchingOrder : Number(matchingOrder),
                    position_code: typeof pos === "number" ? pos : Number(pos),
                });
            } catch {}
        }
    } catch (error) {
        console.error("Error searching PBOM:", error);
    }

    return results;
};

async function triggerPrinting(filePaths: string[], order: OrderUpdate["order"]) {
    if (filePaths.length === 0) {
        console.log(`[PRINT] No documents to print for order ${order.productOrder}`);
        return;
    }

    console.log(
        `[PRINT] Would print ${filePaths.length} documents for order ${order.productOrder} (${order.salesOrder}/${order.position}):`,
    );
    for (const fp of filePaths) {
        console.log(`  - ${fp}`);
    }

    const { io } = require("../index");
    if (io) {
        io.emit("print-documents", {
            orderId: order._id,
            productOrder: order.productOrder,
            workstation: order.workplace,
            filePaths,
        });
    }
}
