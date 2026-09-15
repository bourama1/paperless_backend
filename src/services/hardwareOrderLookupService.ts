/**
 * hardwareOrderLookupService.ts
 *
 * Looks up the production order file for a Hardware prep-queue item, the
 * same way motorOrderService looks up Motor order files — except the prep
 * queue (see ptlPlanService.ts) only knows a row's salesOrder/position from
 * productionPlanPTL.json, never a filename, so this searches for the file
 * instead of resolving one given by the production system.
 *
 * Hardware order files are named:
 *   <salesOrder>_<position>_<productOrder>_Hardware.json
 * and live under one of the PRODUCED sub-types (STANDARD/SEMI/SPARE), e.g.:
 *   HISTORY\OK\PRODUCED\STANDARD\604594_10_230018_Hardware.json
 * Their "id" field also tells us which hardware family the order is,
 * e.g. "Hardware (Indy)" or "Hardware (Guardy)".
 *
 * Same file also carries the order's item list — every item's `itemID` is
 * checked against parts.xlsx (the PTL parts database, via
 * motorOrderService.getPartIds — the exact same check
 * motorOrderService.isNonPtlOrder does for the Motor auto-finish workflow)
 * so the prep queue can show a worker exactly which items P2L/PTL won't
 * handle automatically and someone has to physically prepare by hand.
 *
 * Reuses PICKBYLIGHT_BASE_PATH (see motorOrderService.ts) since it's the
 * same PickByLight share.
 */

import fs from "fs";
import path from "path";
import { getPartIds, OrderFileItem } from "./motorOrderService";

const PICKBYLIGHT_BASE =
    process.env.PICKBYLIGHT_BASE_PATH || "D:\\PickByLight";

// The prep queue only ever needs to find Hardware orders that have already
// been produced (they're archived to HISTORY\OK once done), so unlike
// motorOrderService's live-then-HISTORY fallback, this only looks there.
const PRODUCED_TYPE_DIRS = ["STANDARD", "SEMI", "SPARE"];

function historyProducedDir(typeDir: string): string {
    return path.join(PICKBYLIGHT_BASE, "HISTORY", "OK", "PRODUCED", typeDir);
}

const HARDWARE_FILENAME_PATTERN = /^([^_]+)_([^_]+)_([^_]+)_Hardware\.json$/i;

export interface HardwareOrderInfo {
    productOrder: string;
    // The hardware family parsed out of the file's "id" field, e.g. "Indy"
    // from "Hardware (Indy)". Null if the file has no "id" or it doesn't
    // match that "X (Y)" shape.
    hardwareType: string | null;
    // Items from this order that do NOT appear in parts.xlsx — the ones a
    // person has to physically prepare, since nothing in PTL/P2L will pick
    // them up automatically. Empty when every item is a known PTL part, or
    // when the file has no items.
    nonPtlItems: OrderFileItem[];
}

/** Extracts "Indy" out of `"Hardware (Indy)"`. Falls back to the raw id. */
function parseHardwareType(id: string | undefined): string | null {
    if (!id) return null;
    const match = /\(([^)]+)\)/.exec(id);
    if (match) return match[1]!.trim() || null;
    return id.trim() || null;
}

/**
 * Batch-resolves Hardware order info for a set of (salesOrder, position)
 * pairs. Scans each PRODUCED type folder under HISTORY\OK once (rather than
 * once per row) and only reads the JSON files that actually match one of
 * the requested pairs.
 *
 * Returns a map keyed by "salesOrder::position". A pair with no matching
 * file (e.g. not produced/archived yet) is simply absent from the map —
 * that's expected, not an error.
 */
export function resolveHardwareOrders(
    pairs: { salesOrder: string | null | undefined; position: string | null | undefined }[],
): Map<string, HardwareOrderInfo> {
    const result = new Map<string, HardwareOrderInfo>();

    const wanted = new Set<string>();
    for (const p of pairs) {
        if (!p.salesOrder || !p.position) continue;
        wanted.add(`${p.salesOrder}::${p.position}`);
    }
    if (wanted.size === 0) return result;

    for (const typeDir of PRODUCED_TYPE_DIRS) {
        const dir = historyProducedDir(typeDir);
        let entries: string[];
        try {
            entries = fs.readdirSync(dir);
        } catch (err: any) {
            console.warn(`[HARDWARE] Could not list ${dir}: ${err.message}`);
            continue;
        }

        for (const filename of entries) {
            const match = HARDWARE_FILENAME_PATTERN.exec(filename);
            if (!match) continue;
            const [, salesOrder, position, productOrderFromName] = match;
            const key = `${salesOrder}::${position}`;
            if (!wanted.has(key) || result.has(key)) continue;

            try {
                // Strip a UTF-8 BOM if present — the production system
                // writes these order files with one (see motorOrderService's
                // readOrderFile, which reads the equivalent Motor files).
                const raw = fs
                    .readFileSync(path.join(dir, filename), "utf-8")
                    .replace(/^﻿/, "");
                const parsed = JSON.parse(raw) as {
                    id?: string;
                    productOrder?: string;
                    items?: OrderFileItem[];
                };
                const items = parsed.items || [];
                const partIds = getPartIds();
                // Fail open the same way isNonPtlOrder does: an empty/missing
                // parts.xlsx means nothing can be confirmed as a known PTL
                // part, so every item is treated as needing manual prep
                // rather than silently hiding the whole checklist.
                const nonPtlItems =
                    partIds.size === 0 ?
                        items
                    :   items.filter((item) => !partIds.has(item.itemID.trim()));
                result.set(key, {
                    productOrder: parsed.productOrder || productOrderFromName!,
                    hardwareType: parseHardwareType(parsed.id),
                    nonPtlItems,
                });
            } catch (err: any) {
                console.error(`[HARDWARE] Could not read/parse ${filename}: ${err.message}`);
            }
        }
    }

    return result;
}
