import { Request, Response } from "express";
import { getDb, insertGetId } from "../config/database";
import { notifyNewItem } from "../services/notificationService";

export const getQueue = async (req: Request, res: Response) => {
    try {
        const db = await getDb();
        const documents = await db("documents").orderBy("updated_at", "desc");

        const result = await Promise.all(
            documents.map(async (doc: any) => {
                const revisions = await db("revisions").where("document_id", doc.id).orderBy("version", "desc");
                return { ...doc, revisions };
            }),
        );

        res.json(result);
    } catch (error) {
        console.error("Error fetching documents:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const addToQueue = async (req: Request, res: Response) => {
    const { filename } = req.body;
    if (!filename) {
        return res.status(400).json({ error: "Filename is required" });
    }

    try {
        const db = await getDb();
        const docId = await insertGetId(db, "documents", { name: filename });

        await db("revisions").insert({ document_id: docId, filename, version: 1 });

        const newDoc = await db("documents").where("id", docId).first();
        const revisions = await db("revisions").where("document_id", docId);
        const fullDoc = { ...newDoc, revisions };

        notifyNewItem(fullDoc);
        res.status(201).json(fullDoc);
    } catch (error) {
        console.error("Error adding document:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const updateStatus = async (req: Request, res: Response) => {
    res.status(410).json({ error: "Status updates are no longer supported. Use revisions instead." });
};
