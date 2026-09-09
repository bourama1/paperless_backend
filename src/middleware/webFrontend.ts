import express, { Request, RequestHandler } from "express";
import path from "path";
import fs from "fs";

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
 *
 * `webBuildPath` is resolved to an absolute path here regardless of what's
 * passed in — this is a hard Express requirement for res.sendFile()
 * specifically (unlike express.static, which tolerates a relative path).
 * A previous version skipped this and passed a relative path (e.g. from
 * WEB_BUILD_PATH=.\web-dist in .env) straight through: static assets still
 * worked, since express.static resolves relative paths against cwd, but
 * the very first client-side route that needed the SPA fallback threw a
 * synchronous TypeError from inside serve-static's own error callback —
 * outside of Express's normal request-handler try/catch — which crashed
 * the entire Node process, taking down the whole API (not just the web
 * frontend) until it was restarted. Resolving the path here, and wrapping
 * sendFile in a real try/catch with an error callback, closes both the
 * specific bug and the whole class of "a bad path here kills the server"
 * failures.
 */
export function createWebFrontendMiddleware(
    webBuildPath: string,
): RequestHandler {
    const resolvedWebBuildPath = path.resolve(webBuildPath);
    const indexHtmlPath = path.join(resolvedWebBuildPath, "index.html");
    const serveWebAssets = express.static(resolvedWebBuildPath);

    return (req: Request, res, next) => {
        if (req.method !== "GET" || isApiRequest(req.path)) return next();
        serveWebAssets(req, res, (staticErr) => {
            if (staticErr) return next(staticErr);
            // No static file matched (e.g. /document/123 on a fresh load
            // or page refresh) — fall back to the SPA shell so
            // expo-router's client-side routing can take over. Guarded
            // and wrapped so a missing/misconfigured index.html degrades
            // to a normal error response instead of ever crashing the
            // process again.
            if (!fs.existsSync(indexHtmlPath)) {
                console.error(
                    `[WEB] index.html not found at ${indexHtmlPath} — web build looks incomplete or misconfigured.`,
                );
                res.status(500).send("Web frontend is misconfigured on the server.");
                return;
            }
            try {
                res.sendFile(indexHtmlPath, (sendErr) => {
                    if (sendErr && !res.headersSent) next(sendErr);
                });
            } catch (err) {
                next(err);
            }
        });
    };
}
