import { Request, Response } from "express";
import {
    checkForNewPlan,
    getPrepQueue,
    getPrepQueueWorkplaces,
    getPrepQueueHardwareTypes,
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
