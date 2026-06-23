import { Request, Response } from "express";
import { getDb } from "../config/database";
import { handleOrderUpdate, OrderUpdate, importDocument, searchPbom } from "../services/workstationService";
import path from "path";
import fs from "fs";
import axios from "axios";
import { Readable } from "stream";

const DOC_MANAGER_URL = process.env.DOC_MANAGER_URL || "http://tocz-app4:5200";
const EDITED_PDF_PATH = process.env.EDITED_PDF_PATH || "";
const STORAGE_PATH = process.env.STORAGE_PATH || "./storage";

// ── helpers ─────────────────────────────────────────────────────────────────

function parseDocmgrRef(ref: string) {
    // docmgr://{order_code}/{position_code}/{docType}
    const m = ref.match(/^docmgr:\/\/([^/]+)\/([^/]+)\/(\d+)$/);
    if (!m) return null;
    return {
        orderCode: m[1] as string,
        positionCode: m[2] as string,
        docType: parseInt(m[3] as string, 10),
    };
}

async function resolveDocumentStream(documentId: number): Promise<{ stream: Readable; filename: string } | null> {
    const db = await getDb();
    const doc = await db.get("SELECT * FROM documents WHERE id = ?", documentId);
    if (!doc) return null;

    const latestRev = await db.get(
        "SELECT filename, version FROM revisions WHERE document_id = ? ORDER BY version DESC LIMIT 1",
        documentId,
    );
    if (!latestRev) return null;

    const ref = latestRev.filename;

    // docmgr:// reference → fetch from doc_manager
    const parsed = parseDocmgrRef(ref);
    if (parsed) {
        const url = `${DOC_MANAGER_URL}/api/documents/fetch`;
        const response = await axios.get(url, {
            params: {
                order_code: parsed.orderCode,
                position_code: parsed.positionCode,
                document_type: parsed.docType,
            },
            responseType: "stream",
            timeout: 30000,
        });
        return {
            stream: response.data,
            filename: `PBOM_Hardware_${parsed.orderCode}_${parsed.positionCode}.pdf`,
        };
    }

    // Legacy local file reference (imported before switch to docmgr://)
    const localPath = path.join(STORAGE_PATH, ref);
    if (fs.existsSync(localPath)) {
        return { stream: fs.createReadStream(localPath), filename: ref };
    }

    return null;
}

// ── exports ──────────────────────────────────────────────────────────────────

export const getWorkstations = async (req: Request, res: Response) => {
    try {
        const db = await getDb();
        const workstations = await db.all("SELECT * FROM workstations ORDER BY name");

        const result = workstations.map((ws) => ({
            ...ws,
            current_order_data: ws.current_order_data ? JSON.parse(ws.current_order_data) : null,
        }));

        res.json(result);
    } catch (error) {
        console.error("Error fetching workstations:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const receiveOrderUpdate = async (req: Request, res: Response) => {
    const update = req.body as OrderUpdate;

    if (!update || !update.order || !update.action) {
        return res.status(400).json({ error: "Invalid payload: order and action are required" });
    }

    if (!["STARTED", "FINISHED"].includes(update.action)) {
        return res.status(400).json({ error: "Invalid action. Must be STARTED or FINISHED" });
    }

    try {
        await handleOrderUpdate(update);
        res.json({ status: "ok" });
    } catch (error) {
        console.error("Error processing order update:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const importPbom = async (req: Request, res: Response) => {
    const { projectNumber, position, customer, productOrder, productDesc, documentType } = req.body;

    if (!projectNumber || !position || !customer) {
        return res.status(400).json({ error: "projectNumber, position, and customer are required" });
    }

    try {
        const doc = await importDocument({
            projectNumber,
            position,
            customer,
            productOrder,
            productDesc,
            documentType,
        });
        res.json(doc);
    } catch (error: any) {
        console.error("Error importing PBOM:", error);
        const message = error?.response?.data?.error || error.message || "Internal server error";
        res.status(500).json({ error: message });
    }
};

export const searchPbomHandler = async (req: Request, res: Response) => {
    const { order_code } = req.query;

    if (!order_code) {
        return res.status(400).json({ error: "order_code query parameter is required" });
    }

    try {
        const results = await searchPbom(order_code as string);
        res.json(results);
    } catch (error) {
        console.error("Error searching PBOM:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const getWorkstationLog = async (req: Request, res: Response) => {
    try {
        const db = await getDb();
        const { workstation, limit } = req.query;

        let query = "SELECT * FROM workstation_log";
        const params: string[] = [];

        if (workstation) {
            query += " WHERE workstation_name = ?";
            params.push(workstation as string);
        }

        query += " ORDER BY created_at DESC";

        if (limit) {
            query += " LIMIT ?";
            params.push(limit as string);
        }

        const logs = await db.all(query, params);

        const result = logs.map((log) => ({
            ...log,
            order_snapshot: log.order_snapshot ? JSON.parse(log.order_snapshot) : null,
        }));

        res.json(result);
    } catch (error) {
        console.error("Error fetching workstation log:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const renderDocument = async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
        const result = await resolveDocumentStream(Number(id));
        if (!result) {
            return res.status(404).json({ error: "Document not found" });
        }

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader("Content-Disposition", `inline; filename="${result.filename}"`);
        result.stream.pipe(res);
    } catch (error) {
        console.error("Error rendering document:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

async function saveEditedPdf(documentId: number, pdfBuffer: Buffer) {
    const db = await getDb();
    const doc = await db.get("SELECT * FROM documents WHERE id = ?", documentId);
    if (!doc) throw new Error("Document not found");

    const editCountResult = await db.get(
        "SELECT COUNT(*) as count FROM revisions WHERE document_id = ? AND filename NOT LIKE ?",
        [documentId, "docmgr://%"],
    );
    const editRev = (editCountResult?.count || 0) + 1;

    const ext = path.extname(doc.name);
    let base = path.basename(doc.name, ext);
    const revMatch = base.match(/^(.*)_Rev(\d+)$/i);
    const sourceRev = revMatch ? parseInt(revMatch[2]!, 10) : 0;
    const revNumber = Math.max(editRev, sourceRev + 1);
    const newFilename = revMatch ? `${revMatch[1]}_Rev${revNumber}${ext}` : `${base}_Rev${revNumber}${ext}`;

    if (!fs.existsSync(STORAGE_PATH)) {
        fs.mkdirSync(STORAGE_PATH, { recursive: true });
    }
    const filePath = path.join(STORAGE_PATH, newFilename);
    fs.writeFileSync(filePath, pdfBuffer);
    console.log(`[save-edited-pdf] Saved to ${filePath}`);

    if (EDITED_PDF_PATH) {
        try {
            const networkPath = path.join(EDITED_PDF_PATH, newFilename);
            const networkDir = path.dirname(networkPath);
            if (!fs.existsSync(networkDir)) {
                fs.mkdirSync(networkDir, { recursive: true });
            }
            fs.copyFileSync(filePath, networkPath);
            console.log(`[save-edited-pdf] Copied to network share: ${networkPath}`);
        } catch (err: any) {
            console.error(`[save-edited-pdf] Failed to copy to network share: ${err.message}`);
        }
    }

    await db.run("INSERT INTO revisions (document_id, filename, version) VALUES (?, ?, ?)", [
        documentId,
        newFilename,
        revNumber,
    ]);
    console.log(`[save-edited-pdf] Created revision ${revNumber} for document ${documentId}`);

    return { filename: newFilename, revision: revNumber };
}

export const saveEdited = async (req: Request, res: Response) => {
    const { documentId, pdfBase64, filename: _filename } = req.body;
    if (!documentId || !pdfBase64) {
        return res.status(400).json({ error: "documentId and pdfBase64 are required" });
    }

    try {
        const pdfBuffer = Buffer.from(pdfBase64, "base64");
        console.log(`[save-edited] Receiving PDF for document ${documentId} (${pdfBuffer.length} bytes)`);
        const result = await saveEditedPdf(Number(documentId), pdfBuffer);
        res.json({ status: "ok", ...result });
    } catch (error: any) {
        console.error("Error saving edited document:", error);
        res.status(500).json({ error: error.message || "Internal server error" });
    }
};
