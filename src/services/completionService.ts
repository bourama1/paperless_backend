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
};
