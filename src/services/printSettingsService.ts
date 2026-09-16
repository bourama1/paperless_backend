/**
 * printSettingsService.ts
 *
 * A single live on/off switch for all printing (labels, QR stickers,
 * PBOM/declaration/confirmation documents, prep labels), backed by the
 * single-row print_settings table (see config/database.ts). Every print
 * call site checks isPrintingEnabled() immediately before sending bytes to
 * a physical printer, and treats "disabled" exactly like "no printer
 * configured" — a dry run, logged but not sent.
 *
 * isPrintingEnabled() is synchronous — printing decisions happen deep
 * inside hot code paths that can't await a DB round-trip — so the current
 * value is cached in memory and kept in sync with the DB by
 * setPrintingEnabled(), which is the only way to change it. That means the
 * toggle takes effect on the very next print attempt in THIS process, no
 * restart needed — there's no cross-process sync since only one backend
 * instance runs at a time here.
 */

import { getDb } from "../config/database";

let cachedEnabled = true;
let loaded = false;

/**
 * Loads the persisted value once at startup (see index.ts), so the very
 * first print attempt after a restart already reflects whatever was set
 * before, instead of the true default.
 */
export async function initPrintSettings(): Promise<void> {
    if (loaded) return;
    const db = await getDb();
    const row = await db("print_settings").where({ id: 1 }).first();
    cachedEnabled = row ? !!row.enabled : true;
    loaded = true;
}

/** Synchronous — safe to call from any print code path. */
export function isPrintingEnabled(): boolean {
    return cachedEnabled;
}

export async function setPrintingEnabled(enabled: boolean): Promise<void> {
    const db = await getDb();
    await db("print_settings")
        .insert({ id: 1, enabled, updated_at: db.fn.now() })
        .onConflict("id")
        .merge({ enabled, updated_at: db.fn.now() });
    cachedEnabled = enabled;
    loaded = true;
    console.log(`[PRINT] Printing ${enabled ? "ENABLED" : "DISABLED"} via live config`);
}
