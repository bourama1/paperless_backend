/**
 * toorsService.ts
 *
 * Calls the TOORS status_bridge service to automatically close a production
 * order in the ERP system when a kiosk completion with status="complete" is
 * recorded.
 *
 * The bridge is a separate Python/FastAPI service (status_bridge.exe) that
 * handles the multi-step HTTP session dance with the legacy PHP TOORS app —
 * we just send it one simple POST and it does the rest.
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
    success: boolean;
    order_number: string;
    /** Populated on success — what TOORS returned */
    detail?: {
        id: string;
        planned: string;
        closed_before: string;
        quantity_entered: number;
        result: string;
    };
    /** Populated on failure */
    error?: string;
    /** HTTP status from the bridge (404 = order not found, 502 = TOORS unreachable) */
    status?: number;
}

/**
 * Closes a production order in TOORS via the status_bridge service.
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
        return { success: false, order_number: productOrder, error: "TOORS_SERVICE_URL not configured" };
    }

    if (!productOrder) {
        console.warn("[TOORS] closeOrderInToors called with empty productOrder — skipping");
        return { success: false, order_number: productOrder, error: "Empty product order number" };
    }

    const qty = Math.max(1, Math.floor(quantity));

    try {
        console.log(`[TOORS] Closing order ${productOrder} (quantity: ${qty}) via ${TOORS_SERVICE_URL}`);

        const response = await axios.post(
            `${TOORS_SERVICE_URL}/close-order`,
            { order_number: productOrder, quantity: qty },
            { timeout: 10_000 },
        );

        const data = response.data;
        console.log(
            `[TOORS] Order ${productOrder} closed successfully. ` +
                `Planned: ${data.planned}, closed before: ${data.closed_before}, result: ${data.result}`,
        );

        return {
            success: true,
            order_number: productOrder,
            detail: {
                id: data.id,
                planned: data.planned,
                closed_before: data.closed_before,
                quantity_entered: data.quantity_entered,
                result: data.result,
            },
        };
    } catch (err: any) {
        const status = err?.response?.status;
        const detail = err?.response?.data?.detail || err?.message || String(err);

        if (status === 404) {
            console.warn(
                `[TOORS] Order ${productOrder} not found in TOORS (404): ${detail}`,
            );
        } else if (status === 502) {
            console.error(
                `[TOORS] TOORS server unreachable when closing order ${productOrder} (502): ${detail}`,
            );
        } else {
            console.error(
                `[TOORS] Unexpected error closing order ${productOrder} (status ${status ?? "none"}): ${detail}`,
            );
        }

        return {
            success: false,
            order_number: productOrder,
            error: detail,
            status,
        };
    }
}
