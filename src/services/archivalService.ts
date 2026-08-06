import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { getDb } from "../config/database";
import { DOC_MANAGER_URL } from "./workstationService";
import {
    documentTypeName,
    resolvePbomTypeForWorkplace,
    DOCUMENT_TYPES,
} from "../config/documentTypes";
import { convertToPdfA, PdfaConversionError } from "./pdfaService";

// Network share where archived PDF/A copies are written, e.g.
//   \\FILESERVER\Archive          (Windows UNC)
//   /mnt/archive                  (Linux mount)
// Required — if unset, the sweep logs a warning and does nothing rather than
// silently writing archives somewhere unexpected.
const ARCHIVE_SHARE_PATH = process.env.ARCHIVE_SHARE_PATH || "";

// How many days after an order is tagged "Complete" (via the workstation
// kiosk's completion confirmation) it becomes eligible for archival.
// NOTE: order_archive_log.finished_at is populated by
// completionService.recordOrderCompletion when status === "complete", not
// by the FINISHED order-update event anymore — the column name is a
// holdover, kept as-is to avoid an unnecessary migration.
const RETENTION_DAYS = parseInt(process.env.ARCHIVE_RETENTION_DAYS || "7", 10);

// How often the sweep runs. Archival isn't time-critical (it's driven by a
// multi-day retention window), so this defaults to every 6 hours rather
// than polling frequently like pollWorkstations does.
export const ARCHIVE_POLL_INTERVAL_MS = parseInt(
    process.env.ARCHIVE_POLL_INTERVAL_MS || String(6 * 60 * 60 * 1000),
    10,
);

// Stop retrying an order after this many failed sweep attempts, so a
// permanently-broken order (e.g. doc_manager 500s forever for it) doesn't
// get retried every sweep, forever, without anyone noticing.
const MAX_ATTEMPTS = parseInt(process.env.ARCHIVE_MAX_ATTEMPTS || "5", 10);

let warnedMissingSharePath = false;
let sweepInFlight = false;

interface ArchiveLogRow {
    id: number;
    order_id: string;
    project_number: string;
    position: string;
    sales_order: string | null;
    product_order: string | null;
    finished_at: string | Date;
    attempts: number;
}

/**
 * Downloads a single document from doc_manager for the given order/type,
 * mirroring the same request shape workstationService.importDocument uses
 * (GET .../api/documents/fetch with responseType stream, filename parsed
 * from Content-Disposition). Returns null if doc_manager has no document of
 * this type for this order (a 404), which is a normal, non-fatal outcome —
 * not every order has every document type.
 */
async function fetchDocumentBuffer(
    projectNumber: string,
    position: string,
    documentType: number,
): Promise<{ buffer: Buffer; filename: string } | null> {
    const url = `${DOC_MANAGER_URL}/api/documents/fetch`;
    try {
        const response = await axios.get(url, {
            params: {
                order_code: projectNumber,
                position_code: position,
                document_type: documentType,
            },
            responseType: "arraybuffer",
            timeout: 30_000,
            validateStatus: (status) => status === 200 || status === 404,
        });

        if (response.status === 404) {
            return null;
        }

        const cd = (response.headers["content-disposition"] as string) || "";
        const fileNameMatch = cd.match(/filename="?(.+?)"?$/);
        const filename = fileNameMatch
            ? fileNameMatch[1]!.trim()
            : `${projectNumber}_${position}_${documentType}.pdf`;

        return { buffer: Buffer.from(response.data), filename };
    } catch (error: any) {
        if (error?.response?.status === 404) {
            return null;
        }
        throw error;
    }
}

/**
 * Resolves which PBOM document_type(s) actually apply to a finished order,
 * based on every distinct workplace it was seen at (workstation_log.workstation_name
 * carries update.order.workplace for every STARTED/FINISHED event — see
 * workstationService.handleOrderUpdate). An order that passed through both
 * "Hardware" and "Motor" gets both PBOM_HARDWARE and PBOM_MOTOR archived;
 * an order that only ever hit "Hardware" gets only PBOM_HARDWARE.
 *
 * Falls back to PBOM_HARDWARE if there's no workstation_log history at all
 * for this order_id (shouldn't normally happen, but keeps archival from
 * silently archiving nothing for an edge case like a manually-inserted
 * order_archive_log row).
 */
async function getPbomTypesForOrder(orderId: string): Promise<number[]> {
    const db = await getDb();
    const rows: { workstation_name: string }[] = await db("workstation_log")
        .distinct("workstation_name")
        .where({ order_id: orderId });

    const types = new Set<number>();
    for (const row of rows) {
        types.add(resolvePbomTypeForWorkplace(row.workstation_name));
    }

    if (types.size === 0) {
        console.log(
            `[ARCHIVE] No workstation_log history for order ${orderId} — falling back to PBOM_HARDWARE`,
        );
        types.add(DOCUMENT_TYPES.PBOM_HARDWARE);
    }

    return Array.from(types);
}

/**
 * Archives one finished order: for each PBOM type actually relevant to this
 * order (see getPbomTypesForOrder — derived from which real production
 * workplaces it passed through), fetches that PBOM from doc_manager,
 * converts it to real PDF/A, and writes it to
 * ARCHIVE_SHARE_PATH/{projectNumber}/{position}/{pbomType}_pdfa.pdf.
 *
 * Only PBOM documents are archived — declarations, drawings, confirmations,
 * etc. are intentionally not part of retention archival.
 *
 * A missing PBOM (doc_manager 404) is skipped, not fatal. A hard failure
 * (network error, Ghostscript failure, etc.) throws so the caller can
 * record it and retry on the next sweep.
 */
async function archiveOrder(
    row: ArchiveLogRow,
): Promise<{ archivedCount: number; attemptedCount: number }> {
    const orderDir = path.join(
        ARCHIVE_SHARE_PATH,
        row.project_number,
        row.position,
    );
    let archivedCount = 0;

    const pbomTypes = await getPbomTypesForOrder(row.order_id);
    console.log(
        `[ARCHIVE] Order ${row.order_id} (${row.project_number}/${row.position}) — ` +
            `archiving PBOM type(s): ${pbomTypes.map(documentTypeName).join(", ")}`,
    );

    for (const documentType of pbomTypes) {
        const doc = await fetchDocumentBuffer(
            row.project_number,
            row.position,
            documentType,
        );
        if (!doc) {
            console.log(
                `[ARCHIVE] No document of type ${documentType} (${documentTypeName(documentType)}) for order ${row.order_id} ` +
                    `(${row.project_number}/${row.position}) — skipping`,
            );
            continue;
        }

        const tmpInputPath = path.join(
            os.tmpdir(),
            `archive-src-${crypto.randomBytes(8).toString("hex")}.pdf`,
        );
        fs.writeFileSync(tmpInputPath, doc.buffer);

        try {
            const outputFilename = `${documentTypeName(documentType)}_pdfa.pdf`;
            const outputPath = path.join(orderDir, outputFilename);

            await convertToPdfA(tmpInputPath, outputPath, {
                title: doc.filename,
            });

            console.log(
                `[ARCHIVE] Wrote ${outputPath} for order ${row.order_id}`,
            );
            archivedCount++;
        } finally {
            fs.unlink(tmpInputPath, () => {});
        }
    }

    return { archivedCount, attemptedCount: pbomTypes.length };
}

/**
 * Finds FINISHED orders whose retention window has elapsed and haven't
 * been successfully archived yet, and archives each of them. Safe to call
 * repeatedly — already-archived orders and orders still within the
 * retention window are skipped, and only one sweep runs at a time.
 */
export async function runArchivalSweep(): Promise<void> {
    if (!ARCHIVE_SHARE_PATH) {
        if (!warnedMissingSharePath) {
            console.warn(
                "[ARCHIVE] ARCHIVE_SHARE_PATH is not set — retention archival is disabled. " +
                    "Set it to a network share path (e.g. \\\\FILESERVER\\Archive) to enable it.",
            );
            warnedMissingSharePath = true;
        }
        return;
    }

    if (sweepInFlight) {
        console.log("[ARCHIVE] Sweep already in progress, skipping this tick");
        return;
    }
    sweepInFlight = true;

    try {
        const db = await getDb();
        const cutoff = new Date(
            Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000,
        );

        const dueRows: ArchiveLogRow[] = await db("order_archive_log")
            .whereNull("archived_at")
            .andWhere("finished_at", "<=", cutoff)
            .andWhere("attempts", "<", MAX_ATTEMPTS)
            .orderBy("finished_at", "asc");

        if (dueRows.length === 0) {
            console.log("[ARCHIVE] No orders due for archival");
            return;
        }

        console.log(
            `[ARCHIVE] ${dueRows.length} order(s) due for archival (retention: ${RETENTION_DAYS} days)`,
        );

        for (const row of dueRows) {
            try {
                const { archivedCount, attemptedCount } = await archiveOrder(row);
                await db("order_archive_log").where({ id: row.id }).update({
                    archived_at: db.fn.now(),
                    last_error: null,
                });
                console.log(
                    `[ARCHIVE] Order ${row.order_id} archived (${archivedCount}/${attemptedCount} PBOM document(s) found)`,
                );
            } catch (error: any) {
                const message =
                    error instanceof PdfaConversionError
                        ? error.message
                        : error?.message || String(error);
                console.error(
                    `[ARCHIVE] Failed to archive order ${row.order_id} (attempt ${row.attempts + 1}): ${message}`,
                );
                await db("order_archive_log")
                    .where({ id: row.id })
                    .update({
                        attempts: row.attempts + 1,
                        last_error: message.slice(0, 2000),
                    });
            }
        }
    } catch (error) {
        console.error("[ARCHIVE] Error running archival sweep:", error);
    } finally {
        sweepInFlight = false;
    }
}

