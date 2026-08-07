import { Request, Response } from "express";
import {
    checkForNewPlan,
    getPrepQueue,
    getPrepQueueWorkplaces,
} from "../services/ptlPlanService";

export const listPrepQueue = async (req: Request, res: Response) => {
    try {
        const { date, dateFrom, dateTo, workplace } = req.query;
        const items = await getPrepQueue({
            date: typeof date === "string" ? date : undefined,
            dateFrom: typeof dateFrom === "string" ? dateFrom : undefined,
            dateTo: typeof dateTo === "string" ? dateTo : undefined,
            workplace: typeof workplace === "string" ? workplace : undefined,
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

export const refreshPrepQueue = async (req: Request, res: Response) => {
    try {
        const result = await checkForNewPlan(true);
        res.json(result);
    } catch (error) {
        console.error("Error refreshing prep queue:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
