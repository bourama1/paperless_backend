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
 */

import fs from "fs";
import path from "path";
import { getDb } from "../config/database";

const PTL_PLAN_FOLDER_PATH = process.env.PTL_PLAN_FOLDER_PATH || "";

export const PTL_PLAN_CHECK_INTERVAL_MS = parseInt(
    process.env.PTL_PLAN_CHECK_INTERVAL_MS || String(30 * 60 * 1000),
    10,
);

const FILENAME_PATTERN =
    /^(\d{4})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_(\d{2})_productionPlanPTL\.json$/i;

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

/** Finds the most recently-timestamped productionPlanPTL.json in the watched folder, if any. */
function findLatestPlanFile(): { filename: string; fullPath: string } | null {
    const entries = fs.readdirSync(PTL_PLAN_FOLDER_PATH);
    const candidates = entries
        .map((filename) => ({
            filename,
            ts: parsePlanFilenameTimestamp(filename),
        }))
        .filter((c): c is { filename: string; ts: Date } => c.ts !== null)
        .sort((a, b) => b.ts.getTime() - a.ts.getTime());

    if (candidates.length === 0) return null;
    const latest = candidates[0]!;
    return {
        filename: latest.filename,
        fullPath: path.join(PTL_PLAN_FOLDER_PATH, latest.filename),
    };
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

    let ingested = 0;
    for (const row of rows) {
        const plannedDate = parsePlanDate(row.date);
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

    return ingested;
}

/**
 * Checks the watched folder for a plan file newer than the last one we
 * ingested, and ingests it if found. Pass force=true to re-ingest the
 * current latest file even if it's already the one on record (harmless —
 * ingestion is an upsert — and useful for the manual "check now" action).
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

        const rowCount = await ingestPlanFile(latest.filename, latest.fullPath);
        console.log(
            `[PTL] ${force ? "Force-refreshed" : "New production plan file"}: ${latest.filename} — ingested ${rowCount} row(s)`,
        );
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

    return query.select("q.*");
}

/** Distinct workplaces currently present in the queue, for building a filter UI. */
export async function getPrepQueueWorkplaces(): Promise<string[]> {
    const db = await getDb();
    const rows = await db("ptl_prep_queue")
        .distinct("workplace")
        .orderBy("workplace");
    return rows.map((r: any) => r.workplace);
}
