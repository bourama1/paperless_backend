import { Request, Response } from "express";
import {
    listEmployees,
    addEmployee,
    recordOrderCompletion,
    recordOrderPreparation,
    isValidCompletionStatus,
} from "../services/completionService";
import { buildPrepLabelPdf } from "../services/documentPrinterService";

export const getEmployees = async (req: Request, res: Response) => {
    try {
        const employees = await listEmployees();
        res.json(employees);
    } catch (error) {
        console.error("Error fetching employees:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createEmployee = async (req: Request, res: Response) => {
    const { name } = req.body;
    if (!name || typeof name !== "string" || !name.trim()) {
        return res.status(400).json({ error: "name is required" });
    }
    try {
        const employee = await addEmployee(name);
        res.status(201).json(employee);
    } catch (error) {
        console.error("Error adding employee:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createOrderCompletion = async (req: Request, res: Response) => {
    const {
        orderId,
        workstation,
        cycleIndex,
        totalCycles,
        productOrder,
        projectNumber,
        position,
        salesOrder,
        employeeName,
        status,
    } = req.body;

    if (!orderId || !workstation || !employeeName || !status) {
        return res.status(400).json({
            error: "orderId, workstation, employeeName, and status are required",
        });
    }
    if (!isValidCompletionStatus(status)) {
        return res.status(400).json({
            error: "status must be one of: complete, missing_product, shipped_incomplete",
        });
    }

    try {
        await recordOrderCompletion({
            orderId,
            workstation,
            cycleIndex,
            totalCycles,
            productOrder,
            projectNumber,
            position,
            salesOrder,
            employeeName,
            status,
        });
        res.status(201).json({ status: "ok" });
    } catch (error) {
        console.error("Error recording order completion:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createPrepLabel = async (req: Request, res: Response) => {
    const { projectNumber, position, employeeName } = req.body;

    if (!projectNumber || !position || !employeeName) {
        return res.status(400).json({
            error: "projectNumber, position, and employeeName are required",
        });
    }

    try {
        const pdfBuffer = buildPrepLabelPdf(
            projectNumber,
            position,
            employeeName,
        );
        await recordOrderPreparation(projectNumber, position, employeeName);

        res.setHeader("Content-Type", "application/pdf");
        res.setHeader(
            "Content-Disposition",
            `attachment; filename="label_${projectNumber}_${position}.pdf"`,
        );
        res.send(pdfBuffer);
    } catch (error: any) {
        console.error("Error generating prep label:", error);
        res.status(500).json({
            error: error.message || "Internal server error",
        });
    }
};
