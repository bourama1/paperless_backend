import express, { Request, RequestHandler } from "express";
import path from "path";

// Keep in sync with the route prefixes actually mounted in index.ts.
export const API_PATH_PREFIXES = [
    "/queue",
    "/files",
    "/workstations",
    "/employees",
    "/prep-queue",
    "/health",
];

/** True when a request path belongs to a real API route (and therefore
 * must still go through apiKeyAuth), false when it should be treated as a
 * web-app page request (served publicly — see createWebFrontendMiddleware). */
export function isApiRequest(reqPath: string): boolean {
    return API_PATH_PREFIXES.some(
        (p) => reqPath === p || reqPath.startsWith(`${p}/`),
    );
}

/**
 * Serves the mobile app's web export (see src/index.ts for the full
 * rationale) with an SPA fallback to index.html for client-side routes.
 * Deliberately public — no API key required — since a plain browser
 * navigation can't attach a custom header. Only GET requests to non-API
 * paths are handled here; everything else calls next() and falls through
 * to the normal apiKeyAuth + route handling.
 */
export function createWebFrontendMiddleware(
    webBuildPath: string,
): RequestHandler {
    const serveWebAssets = express.static(webBuildPath);

    return (req: Request, res, next) => {
        if (req.method !== "GET" || isApiRequest(req.path)) return next();
        serveWebAssets(req, res, (err) => {
            if (err) return next(err);
            res.sendFile(path.join(webBuildPath, "index.html"));
        });
    };
}
