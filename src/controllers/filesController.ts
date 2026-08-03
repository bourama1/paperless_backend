import { Request, Response } from "express";
import { getDb } from "../config/database";
import path from "path";
import fs from "fs";
import { convertToPdfA, PdfaConversionError } from "../services/pdfaService";

/**
 * Returns a single document's own record (name, projectNumber, position,
 * documentType) — used by the document viewer to know which order/position
 * it belongs to, e.g. for the prep-station "print label" action.
 */
export const getDocumentById = async (req: Request, res: Response) => {
    try {
        const db = await getDb();
        const doc = await db("documents")
            .where({ id: req.params.id })
            .first();
        if (!doc) {
            return res.status(404).json({ error: "Document not found" });
        }
        res.json(doc);
    } catch (error) {
        console.error("Error fetching document:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

/**
 * Returns every document imported through the app that hasn't been
 * archived yet (see archivalService.ts), each annotated with:
 *   - status: the most recent kiosk completion status for its
 *     projectNumber/position ("complete" | "missing_product" |
 *     "shipped_incomplete" | null if never confirmed)
 *   - revisioned: whether it has an actual edited/annotated revision saved
 *     in-app (as opposed to just the original doc_manager import)
 *
 * Query params:
 *   status=complete,missing_product   comma-separated, OR'd together.
 *                                     Include "none" to also match documents
 *                                     with no completion status recorded.
 *   revisioned=true                   only documents with an edited revision
 */
export const getDocumentsOverview = async (req: Request, res: Response) => {
    try {
        const db = await getDb();

        const statusParam = (req.query.status as string) || "";
        const statuses = statusParam
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const revisionedOnly = req.query.revisioned === "true";

        // Most recent order_completion_log row per projectNumber/position —
        // a project/position can have many rows (one per FINISHED cycle at
        // the completion kiosk), so resolve to just the latest one.
        const latestCompletionMax = db("order_completion_log")
            .select("project_number", "position")
            .max("created_at as max_created_at")
            .groupBy("project_number", "position")
            .as("lc_max");

        let query = db("documents as d")
            .leftJoin("order_archive_log as oal", function (this: any) {
                this.on("oal.project_number", "d.project_number").andOn(
                    "oal.position",
                    "d.position",
                );
            })
            .leftJoin(latestCompletionMax, function (this: any) {
                this.on("lc_max.project_number", "d.project_number").andOn(
                    "lc_max.position",
                    "d.position",
                );
            })
            .leftJoin("order_completion_log as ocl", function (this: any) {
                this.on("ocl.project_number", "lc_max.project_number")
                    .andOn("ocl.position", "lc_max.position")
                    .andOn("ocl.created_at", "lc_max.max_created_at");
            })
            // Not archived yet — either no archive row at all (order never
            // tagged Complete), or a row that hasn't been archived yet.
            .whereNull("oal.archived_at")
            .select(
                "d.id as document_id",
                "d.name as document_name",
                "d.project_number",
                "d.position",
                "d.document_type",
                "d.created_at",
                "d.updated_at",
                "ocl.status as latest_status",
            );

        if (statuses.length > 0) {
            query = query.where(function (this: any) {
                if (statuses.includes("none")) {
                    this.orWhereNull("ocl.status");
                }
                const realStatuses = statuses.filter((s) => s !== "none");
                if (realStatuses.length > 0) {
                    this.orWhereIn("ocl.status", realStatuses);
                }
            });
        }

        const rows = await query.orderBy("d.updated_at", "desc");

        const docIds = rows.map((r: any) => r.document_id);
        const revisionRows =
            docIds.length > 0 ?
                await db("revisions")
                    .whereIn("document_id", docIds)
                    .orderBy("version", "desc")
            :   [];

        const revisionsByDoc = new Map<number, any[]>();
        for (const r of revisionRows) {
            if (!revisionsByDoc.has(r.document_id)) {
                revisionsByDoc.set(r.document_id, []);
            }
            revisionsByDoc.get(r.document_id)!.push({
                id: r.id,
                filename: r.filename,
                version: r.version,
                created_at: r.created_at,
                has_annotations: !!r.annotations,
                is_edited: !String(r.filename).startsWith("docmgr://"),
            });
        }

        let items = rows.map((row: any) => {
            const revisions = revisionsByDoc.get(row.document_id) || [];
            const revisioned = revisions.some((r) => r.is_edited);
            return {
                document_id: row.document_id,
                document_name: row.document_name,
                project_number: row.project_number,
                position: row.position,
                document_type: row.document_type,
                created_at: row.created_at,
                updated_at: row.updated_at,
                status: row.latest_status || null,
                revisioned,
                revisions,
            };
        });

        if (revisionedOnly) {
            items = items.filter((i) => i.revisioned);
        }

        res.json({ items });
    } catch (error) {
        console.error("Error fetching documents overview:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const exportPdfa = async (req: Request, res: Response) => {
    const { id } = req.params;
    console.log(`[Backend] exportPdfa called for docId: ${id}`);

    try {
        const db = await getDb();
        const doc = await db("documents").where({ id }).first();
        const latestRevision = await db("revisions")
            .select("filename")
            .where({ document_id: id })
            .orderBy("version", "desc")
            .first();

        if (!latestRevision) {
            return res
                .status(404)
                .json({ error: "No revisions found for this document" });
        }

        const storagePath = process.env.STORAGE_PATH || "./storage";
        const inputPath = path.join(storagePath, latestRevision.filename);

        const pdfaDir = path.join(storagePath, "pdfa");
        const outputFilename = latestRevision.filename.replace(
            ".pdf",
            "_pdfa.pdf",
        );
        const outputPath = path.join(pdfaDir, outputFilename);

        if (!fs.existsSync(inputPath)) {
            return res.status(404).json({ error: "Source file not found" });
        }

        console.log(
            `[Backend] Exporting ${latestRevision.filename} to PDF/A via Ghostscript...`,
        );
        await convertToPdfA(inputPath, outputPath, {
            title: doc?.name || latestRevision.filename,
        });

        console.log(`[Backend] PDF/A export saved to: ${outputPath}`);
        res.json({
            message: "Exported to PDF/A successfully",
            filename: outputFilename,
            fullPath: outputPath,
        });
    } catch (error) {
        console.error("Error exporting PDF/A:", error);
        if (error instanceof PdfaConversionError) {
            return res.status(502).json({ error: error.message });
        }
        res.status(500).json({ error: "Internal server error" });
    }
};
