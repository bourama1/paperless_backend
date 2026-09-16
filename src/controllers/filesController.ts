import { Request, Response } from "express";
import { getDb } from "../config/database";
import path from "path";
import fs from "fs";
import { convertToPdfA, PdfaConversionError } from "../services/pdfaService";

/**
 * Batch-resolves check status for a set of (project_number, position)
 * pairs, for the QC workflow (order_cycle_checks — see completionService.ts
 * and database.ts's comment on that table).
 *
 * total_cycles for a position is read from whichever source has it, in
 * order of authority: real P2L cycle data (order_completion_log) first,
 * then the prep flow's own record (order_preparation_log), then the
 * pre-P2L plan's quantity (ptl_prep_queue) — falling back to 1 if none of
 * those have anything on record for it yet.
 *
 * A cycle counts as checked once it has at least one "ok" row in
 * order_cycle_checks; an "issue" row doesn't count until it's re-checked
 * "ok". checked=true only once every cycle 1..total_cycles has been OK'd.
 */
interface CycleCheckDetail {
    cycleIndex: number;
    checked: boolean; // has an "ok" row — the currently-latest one for this cycle
    status: "ok" | "issue" | null; // latest recorded status, whatever it was
    employeeName: string | null;
    note: string | null;
    checkedAt: string | null;
}

interface PositionCheckStatus {
    totalCycles: number;
    checkedCycles: number;
    checked: boolean;
    uncheckedCycles: number[];
    cycles: CycleCheckDetail[];
}

/**
 * Batch-resolves per-cycle QC status for a set of (project_number,
 * position) pairs (order_cycle_checks — see completionService.ts and
 * database.ts's comment on that table). Checking is per cycle (one box at
 * a time), not per position as a whole — a cycle counts as checked once
 * its MOST RECENT check row has status "ok"; an "issue" (even a later
 * re-check that flips back to issue) makes it unchecked again until
 * someone re-checks it "ok".
 *
 * total_cycles for a position is read from whichever source has it, in
 * order of authority: real P2L cycle data (order_completion_log) first,
 * then the prep flow's own record (order_preparation_log), then the
 * pre-P2L plan's quantity (ptl_prep_queue) — falling back to 1 if none of
 * those have anything on record for it yet.
 */
async function getCheckStatusForPositions(
    db: any,
    positions: { project_number: string; position: string }[],
): Promise<Map<string, PositionCheckStatus>> {
    const result = new Map<string, PositionCheckStatus>();
    if (positions.length === 0) return result;

    const key = (pn: string, pos: string) => `${pn}||${pos}`;
    const pairs = positions.map((p) => [p.project_number, p.position]);

    const [completionRows, prepRows, planRows, checkRows] = await Promise.all([
        db("order_completion_log")
            .select("project_number", "position")
            .max("total_cycles as max_total_cycles")
            .whereIn(["project_number", "position"], pairs)
            .groupBy("project_number", "position"),
        db("order_preparation_log")
            .select("project_number", "position")
            .max("total_cycles as max_total_cycles")
            .whereIn(["project_number", "position"], pairs)
            .groupBy("project_number", "position"),
        db("ptl_prep_queue")
            .select("project_number", "position")
            .max("quantity as max_quantity")
            .whereIn(["project_number", "position"], pairs)
            .groupBy("project_number", "position"),
        // Every check row, newest first, for every cycle of every position
        // — grouped/reduced to "latest row per cycle" below in JS, since
        // that's simpler and more portable across DBs than a window
        // function here.
        db("order_cycle_checks")
            .whereIn(["project_number", "position"], pairs)
            .orderBy("created_at", "desc"),
    ]);

    const totalByKey = new Map<string, number>();
    for (const r of completionRows as any[]) {
        totalByKey.set(
            key(r.project_number, r.position),
            Number(r.max_total_cycles) || 1,
        );
    }
    for (const r of prepRows as any[]) {
        const k = key(r.project_number, r.position);
        if (!totalByKey.has(k))
            totalByKey.set(k, Number(r.max_total_cycles) || 1);
    }
    for (const r of planRows as any[]) {
        const k = key(r.project_number, r.position);
        if (!totalByKey.has(k)) totalByKey.set(k, Number(r.max_quantity) || 1);
    }

    // Latest check row per (position, cycle_index) — rows are already
    // ordered newest-first, so the first one seen per (key, cycle_index)
    // wins and later (older) ones for that same cycle are ignored.
    const latestByPositionCycle = new Map<string, Map<number, any>>();
    for (const row of checkRows as any[]) {
        const k = key(row.project_number, row.position);
        let byCycle = latestByPositionCycle.get(k);
        if (!byCycle) {
            byCycle = new Map<number, any>();
            latestByPositionCycle.set(k, byCycle);
        }
        if (!byCycle.has(row.cycle_index)) {
            byCycle.set(row.cycle_index, row);
        }
    }

    for (const p of positions) {
        const k = key(p.project_number, p.position);
        const totalCycles = totalByKey.get(k) ?? 1;
        const byCycle = latestByPositionCycle.get(k);

        const cycles: CycleCheckDetail[] = [];
        for (let cycleIndex = 1; cycleIndex <= totalCycles; cycleIndex++) {
            const row = byCycle?.get(cycleIndex);
            cycles.push({
                cycleIndex,
                checked: row?.status === "ok",
                status: row?.status ?? null,
                employeeName: row?.employee_name ?? null,
                note: row?.note ?? null,
                checkedAt: row?.created_at ?? null,
            });
        }

        const checkedCycles = cycles.filter((c) => c.checked).length;
        const uncheckedCycles = cycles
            .filter((c) => !c.checked)
            .map((c) => c.cycleIndex);

        result.set(k, {
            totalCycles,
            checkedCycles,
            checked: totalCycles > 0 && checkedCycles >= totalCycles,
            uncheckedCycles,
            cycles,
        });
    }

    return result;
}

/**
 * Returns a single document's own record (name, projectNumber, position,
 * documentType) — used by the document viewer to know which order/position
 * it belongs to, e.g. for the prep-station "print label" action.
 *
 * Also annotated with the same status/completion/revisioned info the
 * overview list carries (see getDocumentsOverview), so the document viewer
 * can decide whether to show the "Finish order" action — that action is
 * only offered from inside an opened, revisioned document, not from the
 * overview list itself.
 */
export const getDocumentById = async (req: Request, res: Response) => {
    try {
        const db = await getDb();
        const doc = await db("documents").where({ id: req.params.id }).first();
        if (!doc) {
            return res.status(404).json({ error: "Document not found" });
        }

        const latestCompletion = await db("order_completion_log")
            .where({
                project_number: doc.project_number,
                position: doc.position,
            })
            .orderBy("created_at", "desc")
            .first();

        const hasEditedRevision = await db("revisions")
            .where({ document_id: doc.id })
            .whereNot("filename", "like", "docmgr://%")
            .first();

        const checkStatusMap = await getCheckStatusForPositions(db, [
            { project_number: doc.project_number, position: doc.position },
        ]);
        const checkStatus = checkStatusMap.get(
            `${doc.project_number}||${doc.position}`,
        ) ?? {
            totalCycles: 1,
            checkedCycles: 0,
            checked: false,
            uncheckedCycles: [1],
            cycles: [
                {
                    cycleIndex: 1,
                    checked: false,
                    status: null,
                    employeeName: null,
                    note: null,
                    checkedAt: null,
                },
            ],
        };

        res.json({
            ...doc,
            status: latestCompletion?.status || null,
            revisioned: !!hasEditedRevision,
            checked: checkStatus.checked,
            checked_cycles: checkStatus.checkedCycles,
            total_cycles: checkStatus.totalCycles,
            unchecked_cycles: checkStatus.uncheckedCycles,
            // Full per-cycle detail (who checked which cycle, with what
            // status/note) — the document viewer uses this to power a
            // per-cycle picker in the Check action, rather than only
            // showing the aggregate count.
            cycles: checkStatus.cycles,
            completion: latestCompletion
                ? {
                      order_id: latestCompletion.order_id,
                      workstation: latestCompletion.workstation,
                      cycle_index: latestCompletion.cycle_index,
                      total_cycles: latestCompletion.total_cycles,
                      product_order: latestCompletion.product_order,
                      sales_order: latestCompletion.sales_order,
                  }
                : null,
        });
    } catch (error) {
        console.error("Error fetching document:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

/**
 * Returns every order/position that has reached one of the completion
 * kiosk's finishing states and hasn't been archived yet (see
 * archivalService.ts) — driven by order_completion_log, NOT by the
 * "documents" table, so an order shows up here purely because the kiosk
 * finished it, whether or not its BOM was ever opened/imported through the
 * app's own preparation flow (document_id/document_name/document_type are
 * null when it wasn't). Each item is annotated with:
 *   - completed_at: when the kiosk operator actually finished this order —
 *     use this for display, not created_at/updated_at (those only reflect
 *     whenever/if someone happened to open the BOM in-app).
 *   - status: the most recent kiosk completion status for its
 *     projectNumber/position ("complete" | "complete_with_changes" |
 *     "missing_product" | "shipped_incomplete")
 *   - revisioned: whether it has an actual edited/annotated revision saved
 *     in-app (as opposed to just the original doc_manager import) — always
 *     false when document_id is null.
 *   - checked / checked_cycles / total_cycles: the QC workflow — see
 *     getCheckStatusForPositions above. checked is true only once every
 *     cycle of that project/position has an "ok" order_cycle_checks row.
 *
 * Query params:
 *   status=complete,missing_product   comma-separated, OR'd together.
 *   revisioned=true                   only documents with an edited revision
 *   unchecked=true                    only documents not yet fully checked
 */
export const getDocumentsOverview = async (req: Request, res: Response) => {
    try {
        const db = await getDb();

        const statusParam = (req.query.status as string) || "";
        const statuses = statusParam
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        const revisionedOnly = req.query.revisioned === "true";
        const uncheckedOnly = req.query.unchecked === "true";

        // Most recent order_completion_log row per projectNumber/position —
        // a project/position can have many rows (one per FINISHED cycle at
        // the completion kiosk), so resolve to just the latest one.
        const latestCompletionMax = db("order_completion_log")
            .select("project_number", "position")
            .max("created_at as max_created_at")
            .groupBy("project_number", "position")
            .as("lc_max");

        // Driven by order_completion_log, not by documents — a project/
        // position belongs here purely because the completion kiosk
        // finished it, whether or not anyone ever opened/imported its BOM
        // through the app's own preparation flow (see the "documents" left
        // join below, which is allowed to match nothing).
        let query = db(latestCompletionMax)
            .join("order_completion_log as ocl", function (this: any) {
                this.on("ocl.project_number", "lc_max.project_number")
                    .andOn("ocl.position", "lc_max.position")
                    .andOn("ocl.created_at", "lc_max.max_created_at");
            })
            .leftJoin("documents as d", function (this: any) {
                this.on("d.project_number", "ocl.project_number").andOn(
                    "d.position",
                    "ocl.position",
                );
            })
            // Not archived yet. A project/position can have more than one
            // order_archive_log row (e.g. two Motor cycles sharing the same
            // position) — whereNotExists rather than a join avoids fanning
            // that out into duplicate result rows.
            .whereNotExists(function (this: any) {
                this.select(1)
                    .from("order_archive_log as oal")
                    .whereRaw("oal.project_number = ocl.project_number")
                    .andWhereRaw("oal.position = ocl.position")
                    .whereNotNull("oal.archived_at");
            })
            .select(
                "d.id as document_id",
                "d.name as document_name",
                "ocl.project_number",
                "ocl.position",
                "ocl.workstation",
                "d.document_type",
                "d.created_at",
                "d.updated_at",
                "ocl.status as latest_status",
                // The actual thing the user cares about here — when the
                // kiosk operator finished this order — as opposed to
                // d.created_at/updated_at, which only reflect whenever
                // someone happened to open/import the BOM in-app (if ever).
                "ocl.created_at as completed_at",
            );

        if (statuses.length > 0) {
            query = query.whereIn("ocl.status", statuses);
        }

        const rows = await query.orderBy("ocl.created_at", "desc");

        // document_id can now be null (order finished but its BOM was never
        // opened/imported in-app), so exclude those before querying revisions.
        const docIds = rows
            .map((r: any) => r.document_id)
            .filter((id: any) => id != null);
        const revisionRows =
            docIds.length > 0
                ? await db("revisions")
                      .whereIn("document_id", docIds)
                      .orderBy("version", "desc")
                : [];

        const distinctPositions = Array.from(
            new Set(rows.map((r: any) => `${r.project_number}||${r.position}`)),
        ).map((key) => {
            const [project_number, position] = key.split("||");
            return { project_number: project_number!, position: position! };
        });
        const checkStatusByPosition = await getCheckStatusForPositions(
            db,
            distinctPositions,
        );

        const revisionsByDoc = new Map<number, any[]>();
        for (const r of revisionRows) {
            if (!revisionsByDoc.has(r.document_id)) {
                revisionsByDoc.set(r.document_id, []);
            }
            revisionsByDoc.get(r.document_id)!.push({
                id: r.id,
                filename: r.filename,
                version: r.version,
                created_at: r.created_at,
                has_annotations: !!r.annotations,
                is_edited: !String(r.filename).startsWith("docmgr://"),
            });
        }

        let items = rows.map((row: any) => {
            const revisions =
                row.document_id != null ? revisionsByDoc.get(row.document_id) || [] : [];
            const revisioned = revisions.some((r) => r.is_edited);
            const check = checkStatusByPosition.get(
                `${row.project_number}||${row.position}`,
            ) ?? {
                totalCycles: 1,
                checkedCycles: 0,
                checked: false,
                uncheckedCycles: [1],
            };
            return {
                document_id: row.document_id ?? null,
                document_name: row.document_name ?? null,
                project_number: row.project_number,
                position: row.position,
                workstation: row.workstation ?? null,
                document_type: row.document_type ?? null,
                created_at: row.created_at ?? row.completed_at,
                updated_at: row.updated_at ?? row.completed_at,
                completed_at: row.completed_at,
                status: row.latest_status || null,
                revisioned,
                revisions,
                checked: check.checked,
                checked_cycles: check.checkedCycles,
                total_cycles: check.totalCycles,
                // Which specific cycle numbers still need checking, e.g.
                // [2, 3] for a 3-box order where only box 1 has been
                // verified — lets the overview show exactly what's left
                // per position, not just a count.
                unchecked_cycles: check.uncheckedCycles,
            };
        });

        if (revisionedOnly) {
            items = items.filter((i) => i.revisioned);
        }
        if (uncheckedOnly) {
            items = items.filter((i) => !i.checked);
        }

        res.json({ items });
    } catch (error) {
        console.error("Error fetching documents overview:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const exportPdfa = async (req: Request, res: Response) => {
    const { id } = req.params;
    console.log(`[Backend] exportPdfa called for docId: ${id}`);

    try {
        const db = await getDb();
        const doc = await db("documents").where({ id }).first();
        const latestRevision = await db("revisions")
            .select("filename")
            .where({ document_id: id })
            .orderBy("version", "desc")
            .first();

        if (!latestRevision) {
            return res
                .status(404)
                .json({ error: "No revisions found for this document" });
        }

        const storagePath = process.env.STORAGE_PATH || "./storage";
        const inputPath = path.join(storagePath, latestRevision.filename);

        const pdfaDir = path.join(storagePath, "pdfa");
        const outputFilename = latestRevision.filename.replace(
            ".pdf",
            "_pdfa.pdf",
        );
        const outputPath = path.join(pdfaDir, outputFilename);

        if (!fs.existsSync(inputPath)) {
            return res.status(404).json({ error: "Source file not found" });
        }

        console.log(
            `[Backend] Exporting ${latestRevision.filename} to PDF/A via Ghostscript...`,
        );
        await convertToPdfA(inputPath, outputPath, {
            title: doc?.name || latestRevision.filename,
        });

        console.log(`[Backend] PDF/A export saved to: ${outputPath}`);
        res.json({
            message: "Exported to PDF/A successfully",
            filename: outputFilename,
            fullPath: outputPath,
        });
    } catch (error) {
        console.error("Error exporting PDF/A:", error);
        if (error instanceof PdfaConversionError) {
            return res.status(502).json({ error: error.message });
        }
        res.status(500).json({ error: "Internal server error" });
    }
};
