/**
 * ptlPlanService.ts
 *
 * Ingests the daily "productionPlanPTL.json" drop into a work queue for
 * products that need to be physically prepared BEFORE they ever reach P2L
 * (see order_preparation_log / the existing print-prep-label flow, which
 * this queue feeds into).
 *
 * The source file is dropped by an external system into PTL_PLAN_FOLDER_PATH,
 * named with an embedded timestamp, e.g.:
 *   2026_08_04_14_34_48_productionPlanPTL.json
 * A new file can appear at any time; we don't watch it directly (fs.watch
 * can't watch a filename that changes every drop) — instead we periodically
 * list the folder, find the most recently-timestamped matching file, and
 * ingest it only if it's not the one we already ingested. The same check
 * can also be triggered on demand (see forceRefresh / POST /prep-queue/refresh).
 *
 * Environment variables (.env):
 *   PTL_PLAN_FOLDER_PATH        UNC/local path to watch for the JSON drops
 *   PTL_PLAN_CHECK_INTERVAL_MS  how often to check for a new file (default: 30 min)
 *   PTL_PLAN_RETAIN_FILES       how many of the most recent plan drops to
 *                               keep in the queue at once (default: 2)
 *
 * Retention: this queue is the only place a pending prep item is visible,
 * and its only purpose is telling someone what to prepare next — so a row
 * that drops out of the plan (superseded by a later drop) and was never
 * actually prepared through the app has no reason to keep showing up. Each
 * ingest prunes the queue down to just the rows from the
 * PTL_PLAN_RETAIN_FILES most recent plan files (see pruneOldPlanFiles);
 * rows that DO get prepared already disappear immediately via the
 * order_preparation_log check in getPrepQueue, independent of this.
 */

import fs from "fs";
import path from "path";
import { getDb, getMasterplanDb } from "../config/database";
import { normalizeWorkplace } from "./labelPrintingService";
import { resolveHardwareOrders } from "./hardwareOrderLookupService";
import { OrderFileItem } from "./motorOrderService";

const PTL_PLAN_FOLDER_PATH = process.env.PTL_PLAN_FOLDER_PATH || "";

export const PTL_PLAN_CHECK_INTERVAL_MS = parseInt(
    process.env.PTL_PLAN_CHECK_INTERVAL_MS || String(30 * 60 * 1000),
    10,
);

const FILENAME_PATTERN =
    /^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_productionPlanPTL\.json$/i;

export const PTL_PLAN_RETAIN_FILES = parseInt(
    process.env.PTL_PLAN_RETAIN_FILES || "2",
    10,
);

interface PlanRow {
    workplace: string;
    salesOrder: string;
    projectNumber: string;
    position: string;
    quantity: number;
    productionTime: number;
    date: string; // "DD.MM.YYYY"
    label: string;
}

let warnedMissingFolderPath = false;
let checkInFlight = false;

/** Parses the embedded timestamp out of a plan filename, for sorting. Returns null for non-matching names. */
function parsePlanFilenameTimestamp(filename: string): Date | null {
    const match = FILENAME_PATTERN.exec(filename);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    return new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
    );
}

/** "DD.MM.YYYY" -> "YYYY-MM-DD" (for storing as a real date column). Returns null if it doesn't parse. */
function parsePlanDate(raw: string): string | null {
    const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(raw.trim());
    if (!match) return null;
    const [, day, month, year] = match;
    return `${year}-${month}-${day}`;
}

/** Every productionPlanPTL.json in the watched folder, newest first. */
function listPlanFilesByRecency(): { filename: string; fullPath: string }[] {
    const entries = fs.readdirSync(PTL_PLAN_FOLDER_PATH);
    return entries
        .map((filename) => ({ filename, ts: parsePlanFilenameTimestamp(filename) }))
        .filter((c): c is { filename: string; ts: Date } => c.ts !== null)
        .sort((a, b) => b.ts.getTime() - a.ts.getTime())
        .map((c) => ({ filename: c.filename, fullPath: path.join(PTL_PLAN_FOLDER_PATH, c.filename) }));
}

/** Finds the most recently-timestamped productionPlanPTL.json in the watched folder, if any. */
function findLatestPlanFile(): { filename: string; fullPath: string } | null {
    return listPlanFilesByRecency()[0] ?? null;
}

/**
 * The PTL_PLAN_RETAIN_FILES most-recently-timestamped plan files currently
 * in the watched folder — the same set pruneOldPlanFiles keeps rows for.
 * Used by a forced refresh (see checkForNewPlan) to re-ingest every plan
 * the queue is currently retaining, not just the newest one — e.g. after a
 * parts.xlsx update, so non_ptl_items gets recomputed for older-but-still-
 * visible drops too, not just today's.
 */
function findRetainedPlanFiles(): { filename: string; fullPath: string }[] {
    return listPlanFilesByRecency().slice(0, PTL_PLAN_RETAIN_FILES);
}

/**
 * Deletes queue rows belonging to any plan file older than the
 * PTL_PLAN_RETAIN_FILES most recent ones seen in ptl_prep_queue. Rows still
 * pending from an old drop are, by definition, orders that were never
 * prepared through the app and have since been superseded — keeping them
 * around would just build up a growing backlog of stale, no-longer-relevant
 * entries in the only screen where this plan is shown. Sorts by the
 * timestamp embedded in the filename (same parser used to pick the latest
 * file to ingest) rather than assuming alphabetical order, so this keeps
 * working even if the source system ever changes its naming.
 */
async function pruneOldPlanFiles(db: any): Promise<number> {
    const rows: { source_file: string | null }[] = await db("ptl_prep_queue")
        .distinct("source_file")
        .whereNotNull("source_file");

    const filesByRecency = rows
        .map((r) => ({
            filename: r.source_file as string,
            ts: parsePlanFilenameTimestamp(r.source_file as string),
        }))
        .filter((f): f is { filename: string; ts: Date } => f.ts !== null)
        .sort((a, b) => b.ts.getTime() - a.ts.getTime());

    const filesToKeep = filesByRecency
        .slice(0, PTL_PLAN_RETAIN_FILES)
        .map((f) => f.filename);

    // Nothing ingested yet, or nothing parses — leave the table alone
    // rather than risk wiping everything on an unexpected input.
    if (filesToKeep.length === 0) return 0;

    return db("ptl_prep_queue")
        .whereNotNull("source_file")
        .whereNotIn("source_file", filesToKeep)
        .del();
}

/** Reads and upserts every row from one plan file into ptl_prep_queue. */
async function ingestPlanFile(
    filename: string,
    fullPath: string,
): Promise<number> {
    const db = await getDb();

    // Strip a UTF-8 BOM if present — the source file has one.
    const raw = fs.readFileSync(fullPath, "utf-8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw) as { productionPlan: PlanRow[] };
    const rows = parsed.productionPlan || [];

    // For Hardware rows, look up the matching HISTORY\OK order file to get
    // the real production order number and hardware family (Indy/Guardy) —
    // see hardwareOrderLookupService. Resolved as one batch (a handful of
    // directory scans total) rather than per row, then just read out of the
    // map below. Rows with no match yet (not produced/archived) simply get
    // null — re-ingesting later will pick it up once it appears.
    const hardwareRows = rows.filter(
        (row) => normalizeWorkplace(row.workplace) === "hardware",
    );
    const hardwareInfo = resolveHardwareOrders(
        hardwareRows.map((row) => ({ salesOrder: row.salesOrder, position: row.position })),
    );

    let ingested = 0;
    for (const row of rows) {
        const plannedDate = parsePlanDate(row.date);
        const hw = hardwareInfo.get(`${row.salesOrder}::${row.position}`);
        // Only store a non-empty checklist — [] and "no order file resolved
        // yet" should both read as "nothing to check" (see
        // getNonPtlItemsForOrder), so there's no need to distinguish them
        // in storage.
        const nonPtlItems =
            hw?.nonPtlItems && hw.nonPtlItems.length > 0 ? JSON.stringify(hw.nonPtlItems) : null;
        await db("ptl_prep_queue")
            .insert({
                workplace: row.workplace,
                sales_order: row.salesOrder,
                project_number: row.projectNumber,
                position: row.position,
                quantity: row.quantity,
                production_time: row.productionTime,
                planned_date: plannedDate,
                plan_label: row.label,
                source_file: filename,
                product_order: hw?.productOrder ?? null,
                hardware_type: hw?.hardwareType ?? null,
                non_ptl_items: nonPtlItems,
                updated_at: db.fn.now(),
            })
            .onConflict(["project_number", "position", "workplace"])
            .merge({
                sales_order: row.salesOrder,
                quantity: row.quantity,
                production_time: row.productionTime,
                planned_date: plannedDate,
                plan_label: row.label,
                source_file: filename,
                product_order: hw?.productOrder ?? null,
                hardware_type: hw?.hardwareType ?? null,
                non_ptl_items: nonPtlItems,
                updated_at: db.fn.now(),
            });
        ingested++;
    }

    await db("ptl_ingest_state")
        .insert({
            id: 1,
            last_file_name: filename,
            last_ingested_at: db.fn.now(),
            last_row_count: ingested,
            last_checked_at: db.fn.now(),
        })
        .onConflict("id")
        .merge({
            last_file_name: filename,
            last_ingested_at: db.fn.now(),
            last_row_count: ingested,
            last_checked_at: db.fn.now(),
        });

    const pruned = await pruneOldPlanFiles(db);
    if (pruned > 0) {
        console.log(
            `[PTL] Pruned ${pruned} row(s) from plan file(s) older than the ${PTL_PLAN_RETAIN_FILES} most recent`,
        );
    }

    return ingested;
}

/**
 * Checks the watched folder for a plan file newer than the last one we
 * ingested, and ingests it if found. Pass force=true (the manual "check
 * now"/refresh action) to instead re-ingest EVERY currently-retained plan
 * file (the PTL_PLAN_RETAIN_FILES most recent ones — the same set that
 * stays visible in the queue), not just the latest — harmless either way
 * since ingestion is an upsert, and it's what actually re-syncs
 * non_ptl_items/hardware lookups for older-but-still-visible drops too
 * (e.g. after a parts.xlsx update).
 */
export async function checkForNewPlan(force = false): Promise<{
    checked: boolean;
    newFile: boolean;
    filename?: string;
    rowCount?: number;
}> {
    if (!PTL_PLAN_FOLDER_PATH) {
        if (!warnedMissingFolderPath) {
            console.warn(
                "[PTL] PTL_PLAN_FOLDER_PATH is not set — the prep queue will stay empty. " +
                    "Set it to the folder productionPlanPTL.json files are dropped into.",
            );
            warnedMissingFolderPath = true;
        }
        return { checked: false, newFile: false };
    }

    if (checkInFlight) {
        console.log("[PTL] Check already in progress, skipping");
        return { checked: false, newFile: false };
    }
    checkInFlight = true;

    try {
        const latest = findLatestPlanFile();
        if (!latest) {
            console.log(
                `[PTL] No productionPlanPTL.json files found in ${PTL_PLAN_FOLDER_PATH}`,
            );
            return { checked: true, newFile: false };
        }

        const db = await getDb();
        const state = await db("ptl_ingest_state").where({ id: 1 }).first();

        if (!force && state?.last_file_name === latest.filename) {
            console.log(
                `[PTL] No new production plan file (latest is already ingested: ${latest.filename})`,
            );
            await db("ptl_ingest_state")
                .insert({ id: 1, last_checked_at: db.fn.now() })
                .onConflict("id")
                .merge({ last_checked_at: db.fn.now() });
            return { checked: true, newFile: false, filename: latest.filename };
        }

        if (force) {
            // Oldest first, so the last iteration's ptl_ingest_state write
            // (ingestPlanFile always overwrites it) ends up correctly
            // pointing at the actual latest file, same as the single-file
            // path below.
            const retained = findRetainedPlanFiles();
            let rowCount = 0;
            for (const file of [...retained].reverse()) {
                rowCount += await ingestPlanFile(file.filename, file.fullPath);
            }
            console.log(
                `[PTL] Force-refreshed ${retained.length} retained plan file(s) — ingested ${rowCount} row(s) total`,
            );
            return {
                checked: true,
                newFile: true,
                filename: latest.filename,
                rowCount,
            };
        }

        const rowCount = await ingestPlanFile(latest.filename, latest.fullPath);
        console.log(`[PTL] New production plan file: ${latest.filename} — ingested ${rowCount} row(s)`);
        return {
            checked: true,
            newFile: true,
            filename: latest.filename,
            rowCount,
        };
    } catch (error) {
        // Same defensive pattern as pollWorkstations/runArchivalSweep: this
        // is called fire-and-forget from index.ts's setInterval, so an
        // uncaught rejection here would crash the whole process instead of
        // just skipping this tick.
        console.error(
            "[PTL] Error checking for a new production plan file:",
            error,
        );
        return { checked: false, newFile: false };
    } finally {
        checkInFlight = false;
    }
}

export interface PrepQueueFilters {
    date?: string | undefined; // exact planned_date, "YYYY-MM-DD"
    dateFrom?: string | undefined;
    dateTo?: string | undefined;
    workplace?: string | undefined;
    hardwareType?: string | undefined; // e.g. "Indy" / "Guardy"
}

/**
 * Returns queue items that are still pending — i.e. that don't yet have a
 * matching order_preparation_log entry (project_number + position). That
 * log is written by the exact same print-prep-label action the document
 * viewer already exposes (see completionController.createPrepLabel /
 * completionService.recordOrderPreparation) — so printing a prep label for
 * an item, from anywhere in the app, is what removes it from this queue.
 */
export async function getPrepQueue(filters: PrepQueueFilters = {}) {
    const db = await getDb();

    let query = db("ptl_prep_queue as q")
        .whereNotExists(function (this: any) {
            this.select("*")
                .from("order_preparation_log as opl")
                .whereRaw("opl.project_number = q.project_number")
                .andWhereRaw("opl.position = q.position");
        })
        .orderBy("q.planned_date", "asc")
        .orderBy("q.sales_order", "asc");

    if (filters.date) {
        query = query.andWhere("q.planned_date", filters.date);
    }
    if (filters.dateFrom) {
        query = query.andWhere("q.planned_date", ">=", filters.dateFrom);
    }
    if (filters.dateTo) {
        query = query.andWhere("q.planned_date", "<=", filters.dateTo);
    }
    if (filters.workplace) {
        query = query.andWhere("q.workplace", filters.workplace);
    }
    if (filters.hardwareType) {
        query = query.andWhere("q.hardware_type", filters.hardwareType);
    }

    const rows: any[] = await query.select("q.*");

    // Annotate each row with a `locked` flag from the Masterplan database.
    // Rows where vyroba.tisk_zamcen = 1 must not be processed — the
    // physical preparation is blocked by an external decision (e.g. the
    // planning department has locked the order for reprinting). A single
    // batch query fetches all relevant locks so this is not N+1.
    const lockedKeys = await fetchLockedKeys(rows);
    return rows.map((row) => ({
        ...row,
        locked: lockedKeys.has(`${row.project_number}::${row.position}`),
    }));
}

/**
 * Queries the Masterplan database for any vyroba rows where tisk_zamcen = 1
 * for the given queue items. Returns a Set of "projectNumber::position" keys
 * that are locked. Fails open (empty set) if the Masterplan DB is
 * unavailable — a connectivity hiccup should never prevent workers from
 * seeing the queue entirely, and a locked order becoming temporarily
 * accessible is a far less harmful failure mode than the queue going blank.
 *
 * Exported so the search route can reuse the same check without duplicating
 * the Masterplan query logic.
 */
export async function fetchLockedKeys(
    rows: { project_number: string; position: string }[],
): Promise<Set<string>> {
    if (rows.length === 0) return new Set();

    try {
        const mpDb = await getMasterplanDb();

        // zak matches project_number (číslo zakázky).
        // poz matches position — both are stored as strings in our queue
        // and in Masterplan, so a string comparison is safe. The query
        // uses an OR of exact (zak, poz) pairs rather than a cross-join
        // so the index on (zak, poz) can be used if one exists.
        const conditions = rows.map((r) => ({
            zak: r.project_number,
            poz: r.position,
        }));

        const locked: { zak: string; poz: string }[] = await mpDb("vyroba")
            .where("tisk_zamcen", 1)
            .where(function () {
                for (const c of conditions) {
                    this.orWhere({ zak: c.zak, poz: c.poz });
                }
            })
            .select("zak", "poz");

        return new Set(locked.map((r) => `${r.zak}::${r.poz}`));
    } catch (err: any) {
        console.error(
            `[MASTERPLAN] Lock check failed — defaulting all items to unlocked: ${err.message}`,
        );
        return new Set();
    }
}

/** Distinct workplaces currently present in the queue, for building a filter UI. */
export async function getPrepQueueWorkplaces(): Promise<string[]> {
    const db = await getDb();
    const rows = await db("ptl_prep_queue")
        .distinct("workplace")
        .orderBy("workplace");
    return rows.map((r: any) => r.workplace);
}

/** Distinct Hardware types (Indy/Guardy/...) currently present in the queue, for building a filter UI. */
export async function getPrepQueueHardwareTypes(): Promise<string[]> {
    const db = await getDb();
    const rows = await db("ptl_prep_queue")
        .distinct("hardware_type")
        .whereNotNull("hardware_type")
        .orderBy("hardware_type");
    return rows.map((r: any) => r.hardware_type);
}

// ─── per-item prep checklist ────────────────────────────────────────────────
//
// Mirrors motorOrderService's isNonPtlOrder check, but at item granularity
// and for the prep-queue workflow: an order's non-PTL items (see
// hardwareOrderLookupService.resolveHardwareOrders, which computes them at
// ingest time and ptlPlanService.ingestPlanFile stores on the queue row) are
// the ones nobody in PTL/P2L will prepare automatically — a person has to
// tap through each one by hand before the prep label can be printed.

// ── which BAAN codes belong on the prep checklist ──
// Not every non-PTL item needs a person to prepare it (e.g. RAL colour
// codes). prep_baan_codes lists the BAAN codes (itemID) that DO — managed
// from the hidden admin screen, read on every checklist request, so a
// change applies to orders already in the queue straight away. An empty
// list = no filtering (every non-PTL item is shown), so a list nobody has
// set up yet never hides the whole checklist.

export interface PrepBaanCode {
    id: number;
    code: string;
    description: string | null;
}

export const normalizeBaanCode = (code: string) => code.trim().toUpperCase();

export async function listPrepBaanCodes(): Promise<PrepBaanCode[]> {
    const db = await getDb();
    return db("prep_baan_codes").select("id", "code", "description").orderBy("code", "asc");
}

/**
 * Adds one or more codes — `codes` may be a whole pasted block (separated
 * by new lines, spaces, commas or semicolons). Codes already on the list
 * are skipped. Returns how many were actually new.
 */
export async function addPrepBaanCodes(codes: string, description?: string): Promise<number> {
    const unique = Array.from(
        new Set(codes.split(/[\s,;]+/).map(normalizeBaanCode).filter(Boolean)),
    );
    if (unique.length === 0) return 0;
    const db = await getDb();
    const inserted = await db("prep_baan_codes")
        .insert(unique.map((code) => ({ code, description: description?.trim() || null })))
        .onConflict("code")
        .ignore()
        .returning("id");
    return inserted.length;
}

export async function deletePrepBaanCode(id: number): Promise<void> {
    const db = await getDb();
    await db("prep_baan_codes").where({ id }).delete();
}

/** The allowed BAAN codes, or null when the list is empty (= show all). */
async function getPrepBaanCodeSet(db: any): Promise<Set<string> | null> {
    const rows: { code: string }[] = await db("prep_baan_codes").select("code");
    return rows.length > 0 ? new Set(rows.map((r) => r.code)) : null;
}

export interface PrepChecklistItem extends OrderFileItem {
    checked: boolean;
}

export interface PrepChecklist {
    items: PrepChecklistItem[];
    /** True once every item is checked — including the (very common) case
     *  of no items to check at all, so callers can gate a "print label"
     *  button on this alone without special-casing an empty checklist. */
    allPrepared: boolean;
}

/**
 * Returns the non-PTL item checklist for one order (project_number +
 * position), each annotated with whether it's already been tapped
 * "prepared" (order_prep_item_log). An order with no resolved order file,
 * or whose file had no non-PTL items, simply has an empty checklist —
 * already fully "prepared" by definition.
 */
export async function getNonPtlItemsForOrder(
    projectNumber: string,
    position: string,
): Promise<PrepChecklist> {
    const db = await getDb();

    const row = await db("ptl_prep_queue")
        .where({ project_number: projectNumber, position })
        .select("non_ptl_items")
        .first();

    if (!row?.non_ptl_items) {
        return { items: [], allPrepared: true };
    }

    let items: OrderFileItem[];
    try {
        items = JSON.parse(row.non_ptl_items);
    } catch (err: any) {
        console.error(
            `[PREP] Could not parse non_ptl_items for ${projectNumber}/${position}: ${err.message}`,
        );
        return { items: [], allPrepared: true };
    }

    const allowed = await getPrepBaanCodeSet(db);
    if (allowed) {
        items = items.filter((item) => allowed.has(normalizeBaanCode(item.itemID)));
    }
    if (items.length === 0) {
        return { items: [], allPrepared: true };
    }

    const checkedRows: { item_id: string }[] = await db("order_prep_item_log")
        .select("item_id")
        .where({ project_number: projectNumber, position });
    const checkedIds = new Set(checkedRows.map((r) => r.item_id));

    const checklist = items.map((item) => ({
        ...item,
        checked: checkedIds.has(item.itemID),
    }));

    return { items: checklist, allPrepared: checklist.every((i) => i.checked) };
}

/**
 * Marks one non-PTL item as prepared. Idempotent — order_prep_item_log is
 * unique on (project_number, position, item_id), so tapping an
 * already-checked item again is a harmless no-op rather than an error or a
 * duplicate row.
 */
export async function recordPrepItemChecked(
    projectNumber: string,
    position: string,
    itemId: string,
    itemDesc: string | undefined,
    employeeName: string,
): Promise<void> {
    const db = await getDb();
    await db("order_prep_item_log")
        .insert({
            project_number: projectNumber,
            position,
            item_id: itemId,
            item_desc: itemDesc ?? null,
            employee_name: employeeName,
        })
        .onConflict(["project_number", "position", "item_id"])
        .ignore();
}

/**
 * Undoes a prep item check — e.g. a worker misclicked. Idempotent: deleting
 * a row that isn't there (already unchecked) is a harmless no-op.
 */
export async function recordPrepItemUnchecked(
    projectNumber: string,
    position: string,
    itemId: string,
): Promise<void> {
    const db = await getDb();
    await db("order_prep_item_log")
        .where({ project_number: projectNumber, position, item_id: itemId })
        .del();
}
