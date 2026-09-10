/**
 * motorOrderService.ts
 *
 * Handles the "special Motor order" workflow — orders that go through the
 * Motor workstation but have no rows in the PTL system (parts.xlsx). The
 * production system still sends a STARTED event for them, and we print
 * labels at that point (same as normal Motor orders). But because there's
 * nothing in PTL, the order never gets a FINISHED event from the production
 * system — it would get stuck on the completion kiosk forever.
 *
 * This service:
 *   1. Reads the order JSON file referenced in the STARTED event
 *      (D:\PickByLight\..., falling back to HISTORY\OK\... if not found yet)
 *   2. Checks each itemID against parts.xlsx (the PTL parts database)
 *   3. If NONE of the items are found → emits a synthetic FINISHED event
 *      internally so the order appears on the completion kiosk immediately
 *
 * Env vars:
 *   PICKBYLIGHT_BASE_PATH   Local/UNC path to the PickByLight folder
 *                           (default: D:\PickByLight)
 *   PTL_PARTS_XLSX_PATH     Path to the parts.xlsx PTL parts database
 *                           (default: <PICKBYLIGHT_BASE_PATH>\parts.xlsx)
 *
 * The check only runs for Motor workplace orders on STARTED — everything
 * else is untouched.
 */

import fs from "fs";
import path from "path";
import * as XLSX from "xlsx";
import type { OrderUpdate } from "./workstationService";

const PICKBYLIGHT_BASE =
    process.env.PICKBYLIGHT_BASE_PATH || "D:\\PickByLight";

const PTL_PARTS_XLSX =
    process.env.PTL_PARTS_XLSX_PATH ||
    path.join(PICKBYLIGHT_BASE, "parts.xlsx");

// The Linux path prefix that the production system puts in the filename field.
// Everything after this prefix is the relative path we append to PICKBYLIGHT_BASE.
const LINUX_FILENAME_PREFIX = "/home/pickalvat/Data/order_data/";

/**
 * Resolves the local Windows path for an order JSON file.
 * Tries the primary location first, then the HISTORY\OK fallback.
 * Returns null if neither exists.
 */
export function resolveOrderFilePath(linuxFilename: string): string | null {
    const rel = linuxFilename
        .replace(LINUX_FILENAME_PREFIX, "")
        .replace(/\//g, path.sep);

    const primary = path.join(PICKBYLIGHT_BASE, rel);
    if (fs.existsSync(primary)) return primary;

    // Fallback: same relative path but under HISTORY\OK\
    const history = path.join(PICKBYLIGHT_BASE, "HISTORY", "OK", rel);
    if (fs.existsSync(history)) return history;

    return null;
}

interface OrderFileItem {
    itemID: string;
    itemDesc: string;
    itemQuantity: number;
    unit: string;
}

interface OrderFile {
    id: string;
    projectNumber: string;
    salesOrder: string;
    productOrder: string;
    position: string;
    quantity: number;
    maxCycle: number;
    items: OrderFileItem[];
}

/**
 * Reads and parses the order JSON file.
 * Returns null if the file can't be found or parsed.
 */
export function readOrderFile(filePath: string): OrderFile | null {
    try {
        const raw = fs.readFileSync(filePath, "utf-8");
        return JSON.parse(raw) as OrderFile;
    } catch (err: any) {
        console.error(`[MOTOR] Could not read order file ${filePath}: ${err.message}`);
        return null;
    }
}

/**
 * Loads the set of all item IDs from parts.xlsx.
 * Parts.xlsx is the PTL system's parts database — any item whose ID appears
 * here is a PTL item (normal workflow). Items not found here mean the order
 * has no PTL content and should be finished immediately.
 *
 * Reads the first sheet, first column (regardless of header name) and
 * collects all non-empty string values as the known item ID set.
 */
export function loadPtlPartIds(): Set<string> {
    const ids = new Set<string>();
    if (!fs.existsSync(PTL_PARTS_XLSX)) {
        console.warn(
            `[MOTOR] parts.xlsx not found at ${PTL_PARTS_XLSX} — ` +
                "all Motor orders will be treated as special (non-PTL). " +
                "Set PTL_PARTS_XLSX_PATH in .env if the file is elsewhere.",
        );
        return ids;
    }
    try {
        const workbook = XLSX.readFile(PTL_PARTS_XLSX, { sheetStubs: false });
        const sheet = workbook.Sheets[workbook.SheetNames[0]!];
        if (!sheet) {
            console.warn(`[MOTOR] parts.xlsx has no sheets — treating all Motor orders as special`);
            return ids;
        }
        const rows: any[][] = XLSX.utils.sheet_to_json(sheet, {
            header: 1,
            defval: null,
        });
        for (const row of rows) {
            const cell = row[0];
            if (cell !== null && cell !== undefined) {
                ids.add(String(cell).trim());
            }
        }
        console.log(`[MOTOR] Loaded ${ids.size} PTL part IDs from ${PTL_PARTS_XLSX}`);
    } catch (err: any) {
        console.error(`[MOTOR] Failed to read parts.xlsx: ${err.message}`);
    }
    return ids;
}

// Cache the part IDs in memory — the file doesn't change at runtime.
// Loaded lazily on first Motor STARTED event, not at startup, so a missing
// file doesn't prevent the server from starting.
let cachedPartIds: Set<string> | null = null;

function getPartIds(): Set<string> {
    if (!cachedPartIds) {
        cachedPartIds = loadPtlPartIds();
    }
    return cachedPartIds;
}

/** Clears the in-memory parts cache — useful if parts.xlsx is updated without
 *  restarting the server (can be called via a future admin endpoint). */
export function clearPartsCache(): void {
    cachedPartIds = null;
}

/**
 * Returns true when none of the order's items appear in parts.xlsx,
 * meaning this is a "special" (non-PTL) Motor order that needs to be
 * finished automatically via a synthetic FINISHED event.
 */
export function isNonPtlOrder(orderFile: OrderFile): boolean {
    const partIds = getPartIds();
    if (partIds.size === 0) {
        // parts.xlsx not found or empty — treat every order as non-PTL
        // (fail-safe: better to complete orders than to block them forever)
        return true;
    }
    return !orderFile.items.some((item) => partIds.has(item.itemID.trim()));
}

/**
 * Main entry point. Called from handleOrderUpdate when a Motor STARTED
 * event is received. If the order has no PTL items, builds and returns a
 * synthetic FINISHED update that the caller should immediately process,
 * so the order appears on the completion kiosk.
 *
 * Returns null when the order IS a normal PTL order (no action needed).
 */
export async function checkMotorOrderForAutoFinish(
    update: OrderUpdate,
): Promise<OrderUpdate | null> {
    const filename = update.order.filename;
    if (!filename) {
        console.log(
            `[MOTOR] Order ${update.order.productOrder} has no filename — cannot check PTL membership, skipping auto-finish`,
        );
        return null;
    }

    const filePath = resolveOrderFilePath(filename);
    if (!filePath) {
        console.log(
            `[MOTOR] Order file not found for ${update.order.productOrder} ` +
                `(tried primary and HISTORY\\OK path) — treating as PTL order`,
        );
        return null;
    }

    const orderFile = readOrderFile(filePath);
    if (!orderFile) return null;

    if (!isNonPtlOrder(orderFile)) {
        console.log(
            `[MOTOR] Order ${update.order.productOrder} has PTL items — normal workflow, no auto-finish`,
        );
        return null;
    }

    console.log(
        `[MOTOR] Order ${update.order.productOrder} (${update.order.salesOrder}/${update.order.position}) ` +
            `has no PTL items — emitting synthetic FINISHED so it appears on the completion kiosk`,
    );

    // Build a synthetic FINISHED event that mirrors the original STARTED
    // event exactly, so all existing FINISHED handling (workstation clearing,
    // socket broadcast, etc.) works without any special-casing.
    const syntheticFinish: OrderUpdate = {
        ...update,
        action: "FINISHED",
        _id: `synthetic_finish_${update.order._id}_${Date.now()}`,
        datetime: new Date().toISOString(),
    };

    return syntheticFinish;
}
