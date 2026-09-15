import { Request, Response } from "express";
import {
    checkForNewPlan,
    getPrepQueue,
    getPrepQueueWorkplaces,
    getPrepQueueHardwareTypes,
    getNonPtlItemsForOrder,
    recordPrepItemChecked,
} from "../services/ptlPlanService";

export const listPrepQueue = async (req: Request, res: Response) => {
    try {
        const { date, dateFrom, dateTo, workplace, hardwareType } = req.query;
        const items = await getPrepQueue({
            date: typeof date === "string" ? date : undefined,
            dateFrom: typeof dateFrom === "string" ? dateFrom : undefined,
            dateTo: typeof dateTo === "string" ? dateTo : undefined,
            workplace: typeof workplace === "string" ? workplace : undefined,
            hardwareType: typeof hardwareType === "string" ? hardwareType : undefined,
        });
        res.json({ items });
    } catch (error) {
        console.error("Error fetching prep queue:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const listPrepQueueWorkplaces = async (req: Request, res: Response) => {
    try {
        const workplaces = await getPrepQueueWorkplaces();
        res.json({ workplaces });
    } catch (error) {
        console.error("Error fetching prep queue workplaces:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const listPrepQueueHardwareTypes = async (req: Request, res: Response) => {
    try {
        const hardwareTypes = await getPrepQueueHardwareTypes();
        res.json({ hardwareTypes });
    } catch (error) {
        console.error("Error fetching prep queue hardware types:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const refreshPrepQueue = async (req: Request, res: Response) => {
    try {
        const result = await checkForNewPlan(true);
        res.json(result);
    } catch (error) {
        console.error("Error refreshing prep queue:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const getPrepItems = async (req: Request, res: Response) => {
    const { projectNumber, position } = req.query;
    if (typeof projectNumber !== "string" || typeof position !== "string") {
        return res.status(400).json({ error: "projectNumber and position are required" });
    }
    try {
        const checklist = await getNonPtlItemsForOrder(projectNumber, position);
        res.json(checklist);
    } catch (error) {
        console.error("Error fetching prep item checklist:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const checkPrepItem = async (req: Request, res: Response) => {
    const { projectNumber, position, itemId, itemDesc, employeeName } = req.body;
    if (!projectNumber || !position || !itemId || !employeeName) {
        return res.status(400).json({
            error: "projectNumber, position, itemId, and employeeName are required",
        });
    }
    try {
        await recordPrepItemChecked(projectNumber, position, itemId, itemDesc, employeeName);
        const checklist = await getNonPtlItemsForOrder(projectNumber, position);
        res.status(201).json(checklist);
    } catch (error) {
        console.error("Error recording prep item check:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
