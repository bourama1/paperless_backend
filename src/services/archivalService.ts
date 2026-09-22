import axios from "axios";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { PDFDocument, StandardFonts } from "pdf-lib";
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
 * The archival upload service auto-ingests files matching
 * "KM-SVM_<salesOrder>_<position>.pdf" — no document-type token in the
 * name, so Hardware and Motor PBOMs for the SAME real position would
 * otherwise collide on one filename. Motor's archived copy uses
 * position+1 instead, so it always encodes to a distinct name (e.g.
 * position "10" -> Hardware archives as "..._10.pdf", Motor as
 * "..._11.pdf") — this only affects the archived FILENAME, not the real
 * position used to fetch the document from doc_manager or the folder it's
 * written into.
 */
function archivePositionFor(documentType: number, position: string): string {
    if (documentType !== DOCUMENT_TYPES.PBOM_MOTOR) return position;
    const n = parseInt(position, 10);
    return Number.isNaN(n) ? position : String(n + 1);
}

interface CycleInfoRow {
    cycleIndex: number;
    preparedBy: string | null;
    completedBy: string | null;
    checkedBy: string | null;
}

/**
 * Every cycle of this order has up to three people on record (see
 * database.ts's comment on order_cycle_checks for the full picture):
 *   - who prepared it     -> order_preparation_log (cycle_index)
 *   - who ran the PTL cycle -> order_completion_log (cycle_index), keyed
 *     by order_id since Hardware and Motor completions for the same
 *     project/position are separate order_ids, not separate rows of one
 *   - who checked it's OK -> order_cycle_checks (cycle_index)
 * order_completion_log is the authoritative source for which cycles exist
 * at all (that's what queued this order for archival in the first place);
 * prep/check are matched in by project_number+position+cycle_index, same
 * as everywhere else those tables are read (they don't carry a workstation
 * column, so a prepared/checked record is shared across workstations for
 * the same position — a pre-existing modeling limit, not new here).
 * Each source can be re-recorded (a re-check, a re-print) — only the
 * latest row per cycle_index is used.
 */
async function getCycleInfoForOrder(
    orderId: string,
    projectNumber: string,
    position: string,
): Promise<CycleInfoRow[]> {
    const db = await getDb();

    const completionRows: { cycle_index: number; employee_name: string }[] = await db(
        "order_completion_log",
    )
        .where({ order_id: orderId })
        .orderBy("created_at", "desc")
        .select("cycle_index", "employee_name");

    const completedByCycle = new Map<number, string>();
    for (const r of completionRows) {
        if (!completedByCycle.has(r.cycle_index)) {
            completedByCycle.set(r.cycle_index, r.employee_name);
        }
    }

    const cycleIndexes = Array.from(completedByCycle.keys()).sort((a, b) => a - b);
    if (cycleIndexes.length === 0) return [];

    const [prepRows, checkRows] = await Promise.all([
        db("order_preparation_log")
            .where({ project_number: projectNumber, position })
            .whereIn("cycle_index", cycleIndexes)
            .orderBy("created_at", "desc")
            .select("cycle_index", "employee_name"),
        db("order_cycle_checks")
            .where({ project_number: projectNumber, position })
            .whereIn("cycle_index", cycleIndexes)
            .orderBy("created_at", "desc")
            .select("cycle_index", "employee_name"),
    ]);

    const preparedByCycle = new Map<number, string>();
    for (const r of prepRows as { cycle_index: number; employee_name: string }[]) {
        if (!preparedByCycle.has(r.cycle_index)) preparedByCycle.set(r.cycle_index, r.employee_name);
    }
    const checkedByCycle = new Map<number, string>();
    for (const r of checkRows as { cycle_index: number; employee_name: string }[]) {
        if (!checkedByCycle.has(r.cycle_index)) checkedByCycle.set(r.cycle_index, r.employee_name);
    }

    return cycleIndexes.map((cycleIndex) => ({
        cycleIndex,
        preparedBy: preparedByCycle.get(cycleIndex) ?? null,
        completedBy: completedByCycle.get(cycleIndex) ?? null,
        checkedBy: checkedByCycle.get(cycleIndex) ?? null,
    }));
}

const PAGE_WIDTH = 595.28; // A4 portrait, points
const PAGE_HEIGHT = 841.89;
const MARGIN = 40;
const LINE_HEIGHT = 16;
const TITLE_SIZE = 14;
const BODY_SIZE = 10;

/**
 * Appends one or more pages listing who prepared/ran/checked each cycle
 * (see getCycleInfoForOrder) to the end of the given PDF, before it's
 * converted to PDF/A for archival. Uses a fixed-width Courier layout
 * (padEnd-aligned columns) rather than drawing an actual table grid —
 * plenty readable for a plain production record, and far less code.
 * Returns the ORIGINAL bytes unchanged if there's nothing to add.
 */
async function appendCycleInfoPage(pdfBytes: Buffer, rows: CycleInfoRow[]): Promise<Buffer> {
    if (rows.length === 0) return pdfBytes;

    const pdfDoc = await PDFDocument.load(pdfBytes);
    const font = await pdfDoc.embedFont(StandardFonts.Courier);
    const boldFont = await pdfDoc.embedFont(StandardFonts.CourierBold);

    const col = (s: string, w: number) => s.padEnd(w).slice(0, w);
    const headerLine =
        col("Cyklus", 8) +
        col("Šrouby vychystal/a", 24) +
        col("Hardware vychystal/a", 24) +
        col("Zkontroloval/a", 24);

    const rowsPerPage = Math.floor((PAGE_HEIGHT - MARGIN * 2 - (TITLE_SIZE + 14) - LINE_HEIGHT) / LINE_HEIGHT);

    for (let i = 0; i < rows.length; i += rowsPerPage) {
        const chunk = rows.slice(i, i + rowsPerPage);
        const page = pdfDoc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        let y = PAGE_HEIGHT - MARGIN;

        if (i === 0) {
            page.drawText("Výrobní záznam", { x: MARGIN, y, size: TITLE_SIZE, font: boldFont });
            y -= TITLE_SIZE + 14;
        }

        page.drawText(headerLine, { x: MARGIN, y, size: BODY_SIZE, font: boldFont });
        y -= LINE_HEIGHT;

        for (const row of chunk) {
            const line =
                col(String(row.cycleIndex), 8) +
                col(row.preparedBy ?? "-", 24) +
                col(row.completedBy ?? "-", 24) +
                col(row.checkedBy ?? "-", 24);
            page.drawText(line, { x: MARGIN, y, size: BODY_SIZE, font });
            y -= LINE_HEIGHT;
        }
    }

    return Buffer.from(await pdfDoc.save());
}

/**
 * Archives one finished order: for each PBOM type actually relevant to this
 * order (see getPbomTypesForOrder — derived from which real production
 * workplaces it passed through), fetches that PBOM from doc_manager,
 * converts it to real PDF/A, and writes it to
 * ARCHIVE_SHARE_PATH/{projectNumber}/{position}/KM-SVM_{salesOrder}_{archivePosition}.pdf
 * (see archivePositionFor for the Hardware/Motor position offset).
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

    const cycleInfo = await getCycleInfoForOrder(row.order_id, row.project_number, row.position);

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

        // Best-effort: a stamping failure (e.g. a malformed source PDF
        // pdf-lib can't parse) shouldn't block archiving the document
        // itself — fall back to the unstamped original rather than losing
        // the archive entirely.
        let bufferToArchive = doc.buffer;
        try {
            bufferToArchive = await appendCycleInfoPage(doc.buffer, cycleInfo);
        } catch (err: any) {
            console.error(
                `[ARCHIVE] Failed to append cycle info page for order ${row.order_id}: ${err.message} — archiving without it`,
            );
        }

        const tmpInputPath = path.join(
            os.tmpdir(),
            `archive-src-${crypto.randomBytes(8).toString("hex")}.pdf`,
        );
        fs.writeFileSync(tmpInputPath, bufferToArchive);

        try {
            const outputFilename = `KM-SVM_${row.sales_order}_${archivePositionFor(documentType, row.position)}.pdf`;
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

