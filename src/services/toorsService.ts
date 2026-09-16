/**
 * toorsService.ts
 *
 * Calls the TOORS status_bridge service to automatically close a production
 * order in the ERP system when a kiosk completion with status="complete" is
 * recorded.
 *
 * The bridge is a separate Python/FastAPI service (status_bridge.exe) that
 * handles the multi-step HTTP session dance with the legacy PHP TOORS app.
 * As of the bridge's queue-based rewrite, POST /close-order no longer does
 * that dance inline — it queues the job and returns 202 + a job id
 * immediately, then a background worker in the bridge processes it in its
 * own time (retrying every 30s, indefinitely, on a connection failure —
 * see the bridge's own README "Queue and retries" section).
 *
 * This service only fires that POST and reports whether the job was
 * QUEUED — it deliberately does not wait for or poll the eventual
 * done/failed result. The kiosk operator moves on immediately; the ERP
 * close happens in the background on the bridge's own schedule.
 *
 * Only orders with status="complete" are closed — "complete_with_changes",
 * "missing_product", "shipped_incomplete" are intentionally skipped.
 *
 * Env vars:
 *   TOORS_SERVICE_URL   Base URL of the running status_bridge service,
 *                       e.g. http://tocz-app4:3310. Leave empty to disable
 *                       (orders won't be closed in ERP, just logged).
 *
 * Quantity:
 *   - Hardware (and most workplaces): 1 per completion call — each FINISHED
 *     event is one cycle = one unit.
 *   - Motor: the order's own quantity field (can be > 1 when a batch of
 *     motors is finished at once). The mobile app sends this in the body.
 */

import axios from "axios";

const TOORS_SERVICE_URL = (process.env.TOORS_SERVICE_URL || "").replace(/\/$/, "");

export interface ToorsCloseResult {
    /** True once the bridge has accepted the job into its queue — NOT
     *  once it's actually closed in TOORS, which happens later and isn't
     *  tracked here. */
    queued: boolean;
    order_number: string;
    /** The bridge's queue job id, for looking it up later (GET
     *  /queue/{job_id} on the bridge) if its outcome ever needs checking. */
    job_id?: string;
    /** Populated when the job could not even be queued (bridge
     *  unreachable/misconfigured, etc.) */
    error?: string;
}

/**
 * Queues a production order to be closed in TOORS via the status_bridge
 * service. Returns as soon as the bridge accepts the job — does not wait
 * for TOORS itself to actually process it.
 *
 * Always resolves (never throws) — ERP closing is best-effort and must
 * not affect the kiosk completion flow if TOORS or the bridge is down.
 */
export async function closeOrderInToors(
    productOrder: string,
    quantity: number,
): Promise<ToorsCloseResult> {
    if (!TOORS_SERVICE_URL) {
        console.log(
            `[TOORS] TOORS_SERVICE_URL not set — skipping ERP close for order ${productOrder}`,
        );
        return { queued: false, order_number: productOrder, error: "TOORS_SERVICE_URL not configured" };
    }

    if (!productOrder) {
        console.warn("[TOORS] closeOrderInToors called with empty productOrder — skipping");
        return { queued: false, order_number: productOrder, error: "Empty product order number" };
    }

    const qty = Math.max(1, Math.floor(quantity));

    try {
        console.log(`[TOORS] Queuing close for order ${productOrder} (quantity: ${qty}) via ${TOORS_SERVICE_URL}`);

        const response = await axios.post(
            `${TOORS_SERVICE_URL}/close-order`,
            { order_number: productOrder, quantity: qty },
            { timeout: 10_000 },
        );
        const jobId: string | undefined = response.data?.job_id;

        console.log(`[TOORS] Order ${productOrder} queued as job ${jobId} — not waiting for the result`);
        return { queued: true, order_number: productOrder, ...(jobId ? { job_id: jobId } : {}) };
    } catch (err: any) {
        const detail = err?.response?.data?.detail || err?.message || String(err);
        console.error(`[TOORS] Failed to queue close for order ${productOrder}: ${detail}`);
        return { queued: false, order_number: productOrder, error: detail };
    }
}
