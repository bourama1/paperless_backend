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
import { OrderUpdate } from "./workstationService";

// How far back the completion queue looks for FINISHED orders that haven't
// been completion-tagged yet (see getCompletionQueue below). Configurable
// since workstation_log has been recording FINISHED events since long
// before this feature existed — without a window, a stale gap from before
// this shipped would resurface every order ever missed, forever.
const COMPLETION_QUEUE_WINDOW_HOURS = parseInt(
    process.env.COMPLETION_QUEUE_WINDOW_HOURS || "24",
    10,
);

export interface Employee {
    id: number;
    name: string;
}

export interface EmployeeAdmin extends Employee {
    active: boolean;
}

export const ORDER_COMPLETION_STATUSES = [
    "complete",
    // Same as "complete" in every way (archival, counting toward
    // completedCycles, etc.) — the distinction exists purely so someone
    // reviewing completed orders can tell which ones need their changes
    // manually entered into the ERP system afterwards.
    "complete_with_changes",
    "missing_product",
    "shipped_incomplete",
] as const;

export type OrderCompletionStatus = (typeof ORDER_COMPLETION_STATUSES)[number];

// Statuses that count as "this cycle is done" for archival purposes — see
// recordOrderCompletion below.
const COMPLETE_LIKE_STATUSES: readonly OrderCompletionStatus[] = [
    "complete",
    "complete_with_changes",
];

export function isValidCompletionStatus(
    status: string,
): status is OrderCompletionStatus {
    return (ORDER_COMPLETION_STATUSES as readonly string[]).includes(status);
}

// Every "who did this" picker across the app (kiosk, prep label, finish
// order, QC check) — hidden (active=false) employees never show up here.
export const listEmployees = async (): Promise<Employee[]> => {
    const db = await getDb();
    return db("employees")
        .where({ active: true })
        .select("id", "name")
        .orderBy("name", "asc");
};

// The admin employee list — everyone, including hidden ones, so a hidden
// name can be found again and restored.
export const listEmployeesForAdmin = async (): Promise<EmployeeAdmin[]> => {
    const db = await getDb();
    return db("employees").select("id", "name", "active").orderBy("name", "asc");
};

export const addEmployee = async (name: string): Promise<Employee> => {
    const db = await getDb();
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error("name is required");
    }
    const [row] = await db("employees")
        .insert({ name: trimmed, active: true })
        .onConflict("name")
        // Re-adding a name that was previously hidden un-hides it, rather
        // than silently doing nothing — the admin typed that exact name to
        // bring it back.
        .merge(["active"])
        .returning(["id", "name"]);
    return row;
};

export const renameEmployee = async (id: number, name: string): Promise<Employee> => {
    const db = await getDb();
    const trimmed = name.trim();
    if (!trimmed) {
        throw new Error("name is required");
    }
    const [row] = await db("employees")
        .where({ id })
        .update({ name: trimmed })
        .returning(["id", "name"]);
    if (!row) {
        throw new Error("Employee not found");
    }
    return row;
};

// "Delete" only ever hides — past completion/check/prep-log rows still
// reference this name in plain text, not a foreign key, so a real DELETE
// would just orphan that history's display. active=false hides it from
// every picker; setEmployeeActive(id, true) undoes it.
export const setEmployeeActive = async (
    id: number,
    active: boolean,
): Promise<Employee> => {
    const db = await getDb();
    const [row] = await db("employees")
        .where({ id })
        .update({ active })
        .returning(["id", "name"]);
    if (!row) {
        throw new Error("Employee not found");
    }
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

    // Archival (see archivalService.ts) is driven by this "Complete" tag
    // (either flavor — see COMPLETE_LIKE_STATUSES), not by FINISHED
    // anymore — reusing ARCHIVE_RETENTION_DAYS, but the countdown now only
    // starts once EVERY cycle of the order has been tagged Complete, not
    // just whichever cycle happens to be tagged most recently (an order
    // isn't done just because door 1 of 6 is done).
    if (COMPLETE_LIKE_STATUSES.includes(input.status)) {
        if (!input.projectNumber || !input.position) {
            console.log(
                `[ARCHIVE] Order ${input.orderId} tagged Complete with no projectNumber/position — skipping archival queue`,
            );
            return;
        }

        const totalCycles = input.totalCycles ?? 1;
        const completedResult = await db("order_completion_log")
            .where({ order_id: input.orderId })
            .whereIn("status", COMPLETE_LIKE_STATUSES)
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
 * prep station — one row per box/cycle (see buildPrepLabelPdf, which prints
 * one label per cycle for a batch order), not one row for the whole
 * project/position. Called alongside labelPrintingService.printPrepLabel.
 */
export const recordOrderPreparation = async (
    projectNumber: string,
    position: string,
    employeeName: string,
    totalCycles: number = 1,
): Promise<void> => {
    const db = await getDb();
    const count = Math.max(1, totalCycles);
    const rows = Array.from({ length: count }, (_, i) => ({
        project_number: projectNumber,
        position,
        employee_name: employeeName,
        cycle_index: i + 1,
        total_cycles: count,
    }));
    await db("order_preparation_log").insert(rows);
};

// Only Hardware and Motor go through the completion kiosk workflow — every
// other work-type (ManDoor, 2KV, PredHridel, ...) never gets a completion
// tag, so the durable backlog excludes them regardless of which workplace
// filter is requested. Mirrors FORCED_FINISH_WORKPLACES in kiosk.tsx.
const COMPLETION_KIOSK_WORKPLACES = ["Hardware", "Motor"];

/**
 * Hardware/Motor orders that reached FINISHED at the given workplace (or
 * either, if none given) but haven't been completion-tagged yet — the
 * kiosk's durable backlog. Previously the kiosk only ever learned about a
 * FINISHED order via a live "workstation-order-update" socket event, so an
 * order finishing while no tablet had kiosk mode open was missed forever.
 * workstation_log already records every FINISHED event (see
 * workstationService.handleOrderUpdate); this just reads back whichever of
 * those don't yet have a matching order_completion_log row for that exact
 * order_id + cycle_index.
 *
 * cycle_index is compared via COALESCE(...,1) on both sides: workstation_log
 * defaults it to 1, but order_completion_log's column has no default and
 * can be NULL for a completion submitted without one — a plain `=` would
 * treat those as never matching and leave the entry stuck in the queue
 * forever even once genuinely completed.
 */
export const getCompletionQueue = async (
    workplace?: string,
): Promise<OrderUpdate[]> => {
    const db = await getDb();
    const cutoff = new Date(Date.now() - COMPLETION_QUEUE_WINDOW_HOURS * 60 * 60 * 1000);

    let query = db("workstation_log as wl")
        .where("wl.action", "FINISHED")
        .andWhere("wl.created_at", ">=", cutoff)
        .whereIn("wl.workstation_name", COMPLETION_KIOSK_WORKPLACES)
        .whereNotExists(function (this: any) {
            this.select(1)
                .from("order_completion_log as ocl")
                .whereRaw("ocl.order_id = wl.order_id")
                .andWhereRaw(
                    "coalesce(ocl.cycle_index, 1) = coalesce(wl.cycle_index, 1)",
                );
        });

    if (workplace) {
        query = query.andWhere("wl.workstation_name", workplace);
    }

    const rows = await query.select("wl.*").orderBy("wl.created_at", "asc");

    return rows.map((row: any) => ({
        order: JSON.parse(row.order_snapshot),
        cycleIndex: row.cycle_index,
        totalCycles: row.total_cycles,
        _id: row.order_id,
        datetime: row.created_at,
        action: "FINISHED" as const,
    }));
};

export interface ProductStat {
    productDesc: string;
    count: number;
}

// Parses a "YYYY-MM-DD" query param into a local-midnight Date, or returns
// `fallback` if missing/malformed — never throws, since a bad param should
// just fall back rather than 500 the stats tab.
function parseDayParam(value: unknown, fallback: Date): Date {
    if (typeof value === "string") {
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
        if (m) return new Date(+m[1]!, +m[2]! - 1, +m[3]!);
    }
    return fallback;
}

function sortedCounts(counts: Map<string, number>): ProductStat[] {
    return Array.from(counts, ([productDesc, count]) => ({ productDesc, count })).sort(
        (a, b) => b.count - a.count,
    );
}

/** "completed" = every FINISHED cycle (a door physically finished at the
 * workstation). "checked" = only cycles that also got an "ok" QC check
 * (order_cycle_checks) — see getCheckedProductStats below. */
export type ProductStatsStage = "completed" | "checked";

async function getCompletedProductStats(
    startDay: Date,
    rangeEnd: Date,
): Promise<ProductStat[]> {
    const db = await getDb();
    const rows: { order_snapshot: string }[] = await db("workstation_log")
        .where("action", "FINISHED")
        .andWhere("created_at", ">=", startDay)
        .andWhere("created_at", "<", rangeEnd)
        .select("order_snapshot");

    const counts = new Map<string, number>();
    for (const row of rows) {
        if (!row.order_snapshot) continue;
        let productDesc: string;
        try {
            productDesc = JSON.parse(row.order_snapshot).productDesc || "Unknown";
        } catch {
            continue;
        }
        counts.set(productDesc, (counts.get(productDesc) ?? 0) + 1);
    }
    return sortedCounts(counts);
}

/**
 * Same tally as getCompletedProductStats, but only for cycles that were
 * ALSO QC-checked ("ok" in order_cycle_checks) in the range — "we finished
 * it AND someone signed off on it", not just "it went through the
 * station". order_cycle_checks has no productDesc (or order_id) of its
 * own, so this joins by hand in JS: it maps every checked cycle to a
 * project_number+position+workstation+cycle_index key, then looks that key
 * up against FINISHED workstation_log snapshots (the only place
 * productDesc is recorded) for the workstations actually checked.
 * ponytail: scans every FINISHED row for those workstations, unbounded by
 * date, since a check can land well after its cycle finished — fine at
 * today's volume, revisit (e.g. index/cap by order age) if this gets slow.
 */
async function getCheckedProductStats(
    startDay: Date,
    rangeEnd: Date,
): Promise<ProductStat[]> {
    const db = await getDb();
    const checkRows: {
        project_number: string;
        position: string;
        workstation: string;
        cycle_index: number;
    }[] = await db("order_cycle_checks")
        .where("status", "ok")
        .andWhere("created_at", ">=", startDay)
        .andWhere("created_at", "<", rangeEnd)
        .select("project_number", "position", "workstation", "cycle_index");

    if (checkRows.length === 0) return [];

    const checkKey = (r: { project_number: string; position: string; workstation: string; cycle_index: number }) =>
        `${r.project_number}||${r.position}||${r.workstation}||${r.cycle_index}`;
    // A cycle can be checked more than once (re-verified after a fix) —
    // count it once.
    const checkedKeys = new Set(checkRows.map(checkKey));

    const workstations = Array.from(new Set(checkRows.map((r) => r.workstation)));
    const snapRows: { order_snapshot: string; cycle_index: number }[] = await db("workstation_log")
        .where("action", "FINISHED")
        .whereIn("workstation_name", workstations)
        .select("order_snapshot", "cycle_index");

    const productDescByKey = new Map<string, string>();
    for (const row of snapRows) {
        if (!row.order_snapshot) continue;
        let order: any;
        try {
            order = JSON.parse(row.order_snapshot);
        } catch {
            continue;
        }
        const key = `${order.projectNumber}||${order.position}||${order.workplace}||${row.cycle_index}`;
        productDescByKey.set(key, order.productDesc || "Unknown");
    }

    const counts = new Map<string, number>();
    for (const key of checkedKeys) {
        const productDesc = productDescByKey.get(key) || "Unknown";
        counts.set(productDesc, (counts.get(productDesc) ?? 0) + 1);
    }
    return sortedCounts(counts);
}

/**
 * How many cycles (doors/units) fall into `stage` in [from, to] (inclusive,
 * server-local calendar days), grouped by the order's productDesc (e.g.
 * "Hardware (Indy)") — the tally behind the stats tab. `from`/`to` are
 * "YYYY-MM-DD"; omitting both defaults to today only.
 */
export const getProductStats = async (
    from?: string,
    to?: string,
    stage: ProductStatsStage = "completed",
): Promise<ProductStat[]> => {
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startDay = parseDayParam(from, today);
    const endDay = parseDayParam(to, startDay);
    // Exclusive upper bound — the day after `to`, at local midnight.
    const rangeEnd = new Date(
        endDay.getFullYear(),
        endDay.getMonth(),
        endDay.getDate() + 1,
    );

    return stage === "checked"
        ? getCheckedProductStats(startDay, rangeEnd)
        : getCompletedProductStats(startDay, rangeEnd);
};

export const ORDER_CHECK_STATUSES = ["ok", "issue"] as const;
export type OrderCheckStatus = (typeof ORDER_CHECK_STATUSES)[number];

export function isValidCheckStatus(status: string): status is OrderCheckStatus {
    return (ORDER_CHECK_STATUSES as readonly string[]).includes(status);
}

export interface OrderCheckInput {
    projectNumber: string;
    position: string;
    // Which independent production pass this check belongs to (e.g.
    // "Hardware" vs "Motor") — the same project/position can be completed
    // separately at more than one workplace, so this is what keeps their
    // checks from being conflated. See getCheckStatusForPositions.
    workstation: string;
    cycleIndex: number;
    totalCycles: number;
    employeeName: string;
    status: OrderCheckStatus;
    note?: string;
}

/**
 * Records the third and final role on a cycle — after who prepared it
 * (order_preparation_log) and who ran it (order_completion_log), who
 * checked it's actually correct. A cycle can be checked more than once
 * (e.g. re-verifying after fixing an issue); getCheckStatusForPositions
 * (filesController.ts) reads whichever cycles have at least one "ok" row
 * as checked.
 */
export const recordOrderCheck = async (input: OrderCheckInput): Promise<void> => {
    const db = await getDb();
    await db("order_cycle_checks").insert({
        project_number: input.projectNumber,
        position: input.position,
        workstation: input.workstation,
        cycle_index: input.cycleIndex,
        total_cycles: input.totalCycles,
        employee_name: input.employeeName,
        status: input.status,
        note: input.note || null,
    });
};
