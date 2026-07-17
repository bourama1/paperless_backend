import { Request, Response } from "express";
import { getDb } from "../config/database";
import path from "path";
import fs from "fs";
import { convertToPdfA, PdfaConversionError } from "../services/pdfaService";

export const getRevisionsByDate = async (req: Request, res: Response) => {
    try {
        const db = await getDb();
        const dateStr = (req.query.date as string) || new Date().toISOString().slice(0, 10);

        const rows = await db("revisions as r")
            .join("documents as d", "d.id", "r.document_id")
            .whereRaw("DATE(r.created_at) = ?", [dateStr])
            .where("r.filename", "like", "%_Rev%")
            .orderBy("d.name", "asc")
            .orderBy("r.version", "asc")
            .select(
                "d.id as document_id",
                "d.name as document_name",
                "d.updated_at",
                "r.id",
                "r.filename",
                "r.version",
                "r.annotations",
                "r.created_at",
            );

        const grouped = new Map<number, any>();
        for (const row of rows) {
            if (!grouped.has(row.document_id)) {
                grouped.set(row.document_id, {
                    document_id: row.document_id,
                    document_name: row.document_name,
                    updated_at: row.updated_at,
                    revisions: [],
                });
            }
            grouped.get(row.document_id)!.revisions.push({
                id: row.id,
                filename: row.filename,
                version: row.version,
                created_at: row.created_at,
                has_annotations: !!row.annotations,
            });
        }

        res.json({ date: dateStr, items: Array.from(grouped.values()) });
    } catch (error) {
        console.error("Error fetching revisions by date:", error);
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
