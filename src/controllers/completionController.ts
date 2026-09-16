import { Request, Response } from "express";
import {
    listEmployees,
    addEmployee,
    recordOrderCompletion,
    recordOrderPreparation,
    recordOrderCheck,
    isValidCompletionStatus,
    isValidCheckStatus,
} from "../services/completionService";
import { buildPrepLabelPdf, printPrepLabelBuffer } from "../services/documentPrinterService";
import { getDb, getNormsDb } from "../config/database";
import { closeOrderInToors } from "../services/toorsService";
import { normalizeWorkplace } from "../utils/normalizeWorkplace";
import { getOrderCycleSnapshot, motorCycleRange } from "../services/workstationService";

/**
 * Looks up the sales order number from ptl_prep_queue using project number
 * + position — avoids needing the mobile app to pass it through route params.
 * Returns null if not found (order not in the plan, or plan was pruned).
 */
async function lookupSalesOrder(
    projectNumber: string,
    position: string,
): Promise<string | null> {
    try {
        const db = await getDb();
        const row = await db("ptl_prep_queue")
            .where({ project_number: projectNumber, position })
            .select("sales_order")
            .first();
        return row?.sales_order ?? null;
    } catch (err: any) {
        console.error(
            `[PREP] Could not look up sales order for ${projectNumber}/${position}: ${err.message}`,
        );
        return null;
    }
}

/**
 * Looks up the production order number (vyr_obj) for a given order from the
 * Norms database. Path: txtfiles (zakazka + prodejni_objednavka + pozice)
 * → konfiguratory (id_txtfile + nazev LIKE '%hardware%' → vyr_obj).
 * The nazev filter is required because each txtfile row has multiple
 * konfiguratory rows for different parts (motor, hardware, etc.) — only
 * the Hardware row is relevant here. Returns null and fails open if the
 * Norms DB is unavailable or no row is found — the label still prints, just
 * without the production order barcode.
 */
async function lookupProductionOrderNumber(
    projectNumber: string,
    salesOrder: string,
    position: string,
): Promise<string | null> {
    try {
        const db = await getNormsDb();

        const txtfile = await db("txtfiles")
            .where({
                zakazka: projectNumber,
                prodejni_objednavka: salesOrder,
                pozice: position,
            })
            .select("id")
            .first();

        if (!txtfile?.id) return null;

        const konfig = await db("konfiguratory")
            .where({ id_txtfile: txtfile.id })
            .whereRaw("LOWER(nazev) LIKE '%hardware%'")
            .select("vyr_obj")
            .first();

        return konfig?.vyr_obj ? String(konfig.vyr_obj) : null;
    } catch (err: any) {
        console.error(
            `[NORMS] Could not look up production order for ${projectNumber}/${position}: ${err.message}`,
        );
        return null;
    }
}

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
        quantity,
    } = req.body;

    if (!orderId || !workstation || !employeeName || !status) {
        return res.status(400).json({
            error: "orderId, workstation, employeeName, and status are required",
        });
    }
    if (!isValidCompletionStatus(status)) {
        return res.status(400).json({
            error: "status must be one of: complete, complete_with_changes, missing_product, shipped_incomplete",
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

        // Close the order in the ERP system (TOORS) when status is "complete".
        // Other statuses (complete_with_changes, missing_product, etc.) are
        // intentionally skipped — only clean completions are auto-closed.
        // Awaited only long enough to confirm the bridge accepted the job
        // (queued, not the actual TOORS close — see toorsService.ts) so the
        // kiosk operator isn't kept waiting on TOORS itself.
        let toorsResult: Awaited<ReturnType<typeof closeOrderInToors>> | null = null;
        if (status === "complete" && productOrder) {
            // Only Motor batches multiple units into one completion call —
            // every other workstation (Hardware included) closes exactly 1
            // unit per cycle (see toorsService.ts's header comment).
            const isMotor = normalizeWorkplace(workstation) === "motor";
            let closeQty = 1;
            if (isMotor) {
                // The mobile app's `quantity` is just order.quantity, the
                // order's raw TOTAL (see kiosk.tsx) — never this cycle's
                // batch size. Re-derive the real per-cycle amount from the
                // SAME order data (quantity + maxCycle) the printing path
                // used for this exact cycle, via motorCycleRange, so
                // printing and completion can never disagree.
                const snapshot = await getOrderCycleSnapshot(orderId, cycleIndex);
                if (snapshot) {
                    closeQty = motorCycleRange(
                        snapshot.quantity,
                        snapshot.maxCycle,
                        cycleIndex,
                        totalCycles,
                    ).count;
                } else if (typeof quantity === "number" && quantity > 1) {
                    // No snapshot on record (e.g. an order-update was never
                    // logged for this cycle) — fall back to trusting the
                    // mobile-sent quantity rather than closing nothing.
                    closeQty = Math.floor(quantity);
                }
            }
            toorsResult = await closeOrderInToors(productOrder, Math.max(1, closeQty));
        }

        res.status(201).json({
            status: "ok",
            toors: toorsResult
                ? {
                      queued: toorsResult.queued,
                      error: toorsResult.error,
                  }
                : null,
        });
    } catch (error) {
        console.error("Error recording order completion:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createPrepLabel = async (req: Request, res: Response) => {
    const { projectNumber, position, employeeName, totalCycles } = req.body;

    if (!projectNumber || !position || !employeeName) {
        return res.status(400).json({
            error: "projectNumber, position, and employeeName are required",
        });
    }

    const cycles =
        typeof totalCycles === "number" && totalCycles > 0 ?
            Math.floor(totalCycles)
        :   1;

    // Look up both sales order and production order number on the backend —
    // the mobile app doesn't need to carry either through route params.
    // Both fail open: if unavailable the label still prints, just without
    // those fields.
    const salesOrder = await lookupSalesOrder(projectNumber, position);
    const productionOrderNumber = salesOrder
        ? await lookupProductionOrderNumber(projectNumber, salesOrder, position)
        : null;

    try {
        const pdfBuffer = buildPrepLabelPdf(
            projectNumber,
            position,
            employeeName,
            cycles,
            salesOrder ?? null,
            productionOrderNumber,
        );
        await recordOrderPreparation(projectNumber, position, employeeName, cycles);

        // Try to send directly to the Godex prep label printer.
        // If PREP_LABEL_PRINTER_HOST is configured, the backend prints it and
        // returns a simple JSON success so the mobile app shows a confirmation.
        // If not configured, fall back to returning the PDF bytes so the mobile
        // app can open the system share sheet (previous behaviour — useful for
        // dev/test or if the printer isn't set up yet).
        const sentToPrinter = await printPrepLabelBuffer(pdfBuffer);

        if (sentToPrinter) {
            res.json({ success: true });
        } else {
            res.setHeader("Content-Type", "application/pdf");
            res.setHeader(
                "Content-Disposition",
                `attachment; filename="label_${projectNumber}_${position}.pdf"`,
            );
            res.send(pdfBuffer);
        }
    } catch (error: any) {
        console.error("Error generating prep label:", error);
        res.status(500).json({
            error: error.message || "Internal server error",
        });
    }
};

export const createOrderCheck = async (req: Request, res: Response) => {
    const { projectNumber, position, cycleIndex, totalCycles, employeeName, status, note } =
        req.body;

    if (!projectNumber || !position || !employeeName || !status || !cycleIndex) {
        return res.status(400).json({
            error: "projectNumber, position, cycleIndex, employeeName, and status are required",
        });
    }
    if (!isValidCheckStatus(status)) {
        return res.status(400).json({
            error: "status must be one of: ok, issue",
        });
    }

    try {
        await recordOrderCheck({
            projectNumber,
            position,
            cycleIndex,
            totalCycles: typeof totalCycles === "number" && totalCycles > 0 ? totalCycles : 1,
            employeeName,
            status,
            note,
        });
        res.status(201).json({ status: "ok" });
    } catch (error) {
        console.error("Error recording order check:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};
