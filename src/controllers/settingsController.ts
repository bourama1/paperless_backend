import { Request, Response } from "express";
import { isPrintingEnabled, setPrintingEnabled } from "../services/printSettingsService";

export const getPrintingSetting = async (req: Request, res: Response) => {
    res.json({ enabled: isPrintingEnabled() });
};

export const updatePrintingSetting = async (req: Request, res: Response) => {
    const { enabled } = req.body;
    if (typeof enabled !== "boolean") {
        return res.status(400).json({ error: "enabled (boolean) is required" });
    }
    try {
        await setPrintingEnabled(enabled);
        res.json({ enabled });
    } catch (error) {
        console.error("Error updating printing setting:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
