import { lookupQcRequired } from "./labelPrintingService";

// How long to wait before retrying a position whose TMP file couldn't be
// resolved (no CSV/TMP yet, share unreachable, no 00000040 line).
const RETRY_AFTER_MS = 15 * 60 * 1000;

const inFlight = new Set<string>();
const retryAfter = new Map<string, number>();

const key = (projectNumber: string, position: string) => `${projectNumber}||${position}`;

export interface QcPosition {
    project_number: string;
    position: string;
    sales_order: string | null;
}

/**
 * Whether each project/position needs a quality-control check (TMP file
 * characteristic 00000040 = "j"), keyed "project_number||position".
 *
 * Answers come from the order_qc_requirement cache only — a position not
 * cached yet is simply absent from the map (unknown) and gets resolved in
 * the background, so this never waits on the network share. The Docs
 * overview polls every 10s, so a newly finished order shows its QC flag on
 * the next poll or so.
 */
export async function getQcRequiredForPositions(
    db: any,
    positions: QcPosition[],
): Promise<Map<string, boolean>> {
    const result = new Map<string, boolean>();
    if (positions.length === 0) return result;

    const rows: { project_number: string; position: string; qc_required: boolean }[] = await db(
        "order_qc_requirement",
    )
        .whereIn(
            ["project_number", "position"],
            positions.map((p) => [p.project_number, p.position]),
        )
        .select("project_number", "position", "qc_required");
    for (const r of rows) {
        result.set(key(r.project_number, r.position), !!r.qc_required);
    }

    const now = Date.now();
    for (const p of positions) {
        const k = key(p.project_number, p.position);
        if (result.has(k) || inFlight.has(k) || !p.sales_order) continue;
        if ((retryAfter.get(k) ?? 0) > now) continue;
        inFlight.add(k);
        void resolveAndStore(db, p, k);
    }

    return result;
}

async function resolveAndStore(db: any, p: QcPosition, k: string): Promise<void> {
    try {
        const qcRequired = await lookupQcRequired(p.sales_order!, p.position);
        if (qcRequired === null) {
            retryAfter.set(k, Date.now() + RETRY_AFTER_MS);
            return;
        }
        await db("order_qc_requirement")
            .insert({ project_number: p.project_number, position: p.position, qc_required: qcRequired })
            .onConflict(["project_number", "position"])
            .ignore();
        retryAfter.delete(k);
    } catch (err: any) {
        console.error(`[QC] Failed to resolve QC requirement for ${k}: ${err.message}`);
        retryAfter.set(k, Date.now() + RETRY_AFTER_MS);
    } finally {
        inFlight.delete(k);
    }
}
