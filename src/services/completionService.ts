/**
 * completionService.ts
 *
 * Backs the workstation kiosk tablet feature:
 *   - employees: the list of names shown in the "who finished this order"
 *     dropdown on the tablet.
 *   - order_completion_log: one row per FINISHED cycle a kiosk operator
 *     confirmed — who finished it, and whether the order is complete,
 *     missing a product (waiting), or being shipped incomplete.
 *
 * The tablet itself finds out about FINISHED cycles via the existing
 * "workstation-order-update" socket.io event (already emitted for every
 * order-update in workstationService.handleOrderUpdate) — no new event
 * emission was needed for this feature.
 */

import { getDb } from "../config/database";

export interface Employee {
    id: number;
    name: string;
}

export const ORDER_COMPLETION_STATUSES = [
    "complete",
    "missing_product",
    "shipped_incomplete",
] as const;

export type OrderCompletionStatus = (typeof ORDER_COMPLETION_STATUSES)[number];

export function isValidCompletionStatus(
    status: string,
): status is OrderCompletionStatus {
    return (ORDER_COMPLETION_STATUSES as readonly string[]).includes(status);
}

export const listEmployees = async (): Promise<Employee[]> => {
    const db = await getDb();
    return db("employees").select("id", "name").orderBy("name", "asc");
};

export const addEmployee = async (name: string): Promise<Employee> => {
    const db = await getDb();
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error("name is required");
    }
    const [row] = await db("employees")
        .insert({ name: trimmed })
        .onConflict("name")
        .merge() // idempotent: re-adding an existing name just returns it
        .returning(["id", "name"]);
    return row;
};

export interface OrderCompletionInput {
    orderId: string;
    workstation: string;
    cycleIndex?: number;
    totalCycles?: number;
    productOrder?: string;
    projectNumber?: string;
    position?: string;
    salesOrder?: string;
    employeeName: string;
    status: OrderCompletionStatus;
}

export const recordOrderCompletion = async (
    input: OrderCompletionInput,
): Promise<void> => {
    const db = await getDb();
    await db("order_completion_log").insert({
        order_id: input.orderId,
        workstation: input.workstation,
        cycle_index: input.cycleIndex,
        total_cycles: input.totalCycles,
        product_order: input.productOrder,
        project_number: input.projectNumber,
        position: input.position,
        sales_order: input.salesOrder,
        employee_name: input.employeeName,
        status: input.status,
    });

    // Archival (see archivalService.ts) is driven by this "Complete" tag,
    // not by FINISHED anymore — reusing ARCHIVE_RETENTION_DAYS, but the
    // countdown now only starts once EVERY cycle of the order has been
    // tagged Complete, not just whichever cycle happens to be tagged most
    // recently (an order isn't done just because door 1 of 6 is done).
    if (input.status === "complete") {
        if (!input.projectNumber || !input.position) {
            console.log(
                `[ARCHIVE] Order ${input.orderId} tagged Complete with no projectNumber/position — skipping archival queue`,
            );
            return;
        }

        const totalCycles = input.totalCycles ?? 1;
        const completedResult = await db("order_completion_log")
            .where({ order_id: input.orderId, status: "complete" })
            .countDistinct("cycle_index as count")
            .first();
        const completedCycles = Number(completedResult?.count) || 0;

        if (completedCycles < totalCycles) {
            console.log(
                `[ARCHIVE] Order ${input.orderId}: ${completedCycles}/${totalCycles} cycles tagged Complete — not fully complete yet`,
            );
            return;
        }

        console.log(
            `[ARCHIVE] Order ${input.orderId}: all ${totalCycles} cycle(s) tagged Complete — queueing for retention archival`,
        );
        await db("order_archive_log")
            .insert({
                order_id: input.orderId,
                project_number: input.projectNumber,
                position: input.position,
                sales_order: input.salesOrder,
                product_order: input.productOrder,
                finished_at: db.fn.now(),
            })
            .onConflict("order_id")
            .merge(["finished_at"]);
    } else {
        // Un-complete: if this order previously had a pending (not yet
        // archived) archival queued from an earlier Complete tag, cancel
        // it — the order isn't actually done. Already-archived orders are
        // left alone; there's no clean way to "unarchive" a copied file.
        await db("order_archive_log")
            .where({ order_id: input.orderId })
            .whereNull("archived_at")
            .delete();
    }
};

/**
 * Records who prepared a Hardware order's externally-sourced items at the
 * prep station. Called alongside labelPrintingService.printPrepLabel.
 */
export const recordOrderPreparation = async (
    projectNumber: string,
    position: string,
    employeeName: string,
): Promise<void> => {
    const db = await getDb();
    await db("order_preparation_log").insert({
        project_number: projectNumber,
        position,
        employee_name: employeeName,
    });
};
