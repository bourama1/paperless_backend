import { Request, Response, NextFunction } from "express";

// Paths that stay open without credentials:
// - /health: liveness check for load balancers/monitoring — leaks nothing.
// - /workstations/order-update: webhook pushed by the external production
//   system on STARTED/FINISHED order events. That system isn't ours, so it
//   can't send X-API-Key; this webhook drives order completion and
//   workstation state, so it must remain reachable without a key.
const PUBLIC_PATHS = new Set(["/health", "/workstations/order-update"]);

export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
    if (PUBLIC_PATHS.has(req.path)) {
        return next();
    }

    // Read directly from process.env (rather than a module-level constant)
    // so the check reflects the current environment at request time — this
    // also makes the "not configured" case testable without needing to
    // reload the module between tests.
    const apiKey = process.env.API_KEY;

    if (!apiKey) {
        // Fail closed: an unset key must never mean "let everyone in".
        console.error(
            "[AUTH] API_KEY is not set — rejecting all requests. Set API_KEY in .env.",
        );
        res.status(500).json({ error: "Server misconfigured" });
        return;
    }

    // Header is the normal path (used by apiClient for all axios calls and
    // by the Socket.IO handshake). A query-param fallback exists only for
    // requests a WebView/iframe issues internally (the PDF renderer, loaded
    // via pdf.js inside a WebView on native and a plain <iframe> on web) —
    // neither can attach a custom header, so the mobile app appends
    // ?apiKey=... to that one URL instead. See index.ts's request logger,
    // which strips this param before printing so it never lands in logs.
    const provided = req.header("X-API-Key") || req.query.apiKey;
    if (!provided || provided !== apiKey) {
        res.status(401).json({ error: "Unauthorized" });
        return;
    }

    next();
}

// Second factor for the hidden employee-admin screen — the mobile app
// still needs a valid X-API-Key to reach these routes at all (apiKeyAuth
// above runs first), this just additionally requires a separate PIN the
// factory floor doesn't otherwise know, since creating/renaming/hiding
// employee names shouldn't be one tap away for anyone with the app.
export function adminPinAuth(req: Request, res: Response, next: NextFunction) {
    const pin = process.env.EMPLOYEE_ADMIN_PIN;

    if (!pin) {
        // Fail closed, same reasoning as apiKeyAuth: an unset PIN must
        // never mean "admin routes are open to anyone".
        console.error(
            "[AUTH] EMPLOYEE_ADMIN_PIN is not set — rejecting all employee-admin requests.",
        );
        res.status(500).json({ error: "Admin PIN not configured" });
        return;
    }

    const provided = req.header("X-Admin-Pin");
    if (!provided || provided !== pin) {
        res.status(401).json({ error: "Invalid PIN" });
        return;
    }

    next();
}
