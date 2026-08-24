import { Request, Response, NextFunction } from "express";

// Only the liveness check stays open — load balancers/monitoring hit this
// without credentials, and it leaks nothing sensitive.
const PUBLIC_PATHS = new Set(["/health"]);

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
