import request from "supertest";
import express from "express";
import fs from "fs";
import os from "os";
import path from "path";
import {
    isApiRequest,
    createWebFrontendMiddleware,
    API_PATH_PREFIXES,
} from "../../middleware/webFrontend";

describe("isApiRequest", () => {
    it("matches an exact API prefix with nothing after it", () => {
        expect(isApiRequest("/health")).toBe(true);
        expect(isApiRequest("/workstations")).toBe(true);
    });

    it("matches an API prefix with a sub-path", () => {
        expect(isApiRequest("/workstations/5/render")).toBe(true);
        expect(isApiRequest("/queue/items")).toBe(true);
    });

    it("does not match a path that merely starts with the same letters", () => {
        // "/workstations-admin" is NOT "/workstations" or "/workstations/..."
        expect(isApiRequest("/workstations-admin")).toBe(false);
    });

    it("treats everything else as a web-app page request", () => {
        expect(isApiRequest("/")).toBe(false);
        expect(isApiRequest("/document/123")).toBe(false);
        expect(isApiRequest("/_expo/static/js/web/entry.js")).toBe(false);
    });

    it("covers every route actually mounted in index.ts", () => {
        // Cheap guard against index.ts growing a new route prefix without
        // this list being updated to match — see the comment in
        // webFrontend.ts about keeping these in sync.
        expect(API_PATH_PREFIXES).toEqual(
            expect.arrayContaining([
                "/queue",
                "/files",
                "/workstations",
                "/employees",
                "/prep-queue",
                "/health",
            ]),
        );
    });
});

describe("createWebFrontendMiddleware", () => {
    let webBuildPath: string;

    beforeAll(() => {
        webBuildPath = fs.mkdtempSync(
            path.join(os.tmpdir(), "web-frontend-test-"),
        );
        fs.writeFileSync(
            path.join(webBuildPath, "index.html"),
            "<html>SPA shell</html>",
        );
        fs.mkdirSync(path.join(webBuildPath, "assets"));
        fs.writeFileSync(
            path.join(webBuildPath, "assets", "app.js"),
            "console.log('hi')",
        );
    });

    afterAll(() => {
        fs.rmSync(webBuildPath, { recursive: true, force: true });
    });

    function buildApp() {
        const app = express();
        app.use(createWebFrontendMiddleware(webBuildPath));
        // A stand-in for the real apiKeyAuth + API routes further down the
        // chain in index.ts — reached only when the middleware calls next().
        app.use((req, res) => res.status(401).json({ error: "Unauthorized" }));
        return app;
    }

    it("serves the SPA shell for the root path without any auth", async () => {
        const response = await request(buildApp()).get("/");
        expect(response.status).toBe(200);
        expect(response.text).toContain("SPA shell");
    });

    it("serves a real static asset directly when it exists", async () => {
        const response = await request(buildApp()).get("/assets/app.js");
        expect(response.status).toBe(200);
        expect(response.text).toContain("console.log");
    });

    it("falls back to the SPA shell for a client-side route with no matching file (e.g. a page refresh)", async () => {
        const response = await request(buildApp()).get("/document/123");
        expect(response.status).toBe(200);
        expect(response.text).toContain("SPA shell");
    });

    it("does not intercept a real API path — lets it fall through to auth", async () => {
        const response = await request(buildApp()).get("/workstations");
        expect(response.status).toBe(401);
    });

    it("does not intercept /health either, even though it's also public — that's apiKeyAuth's job, not this middleware's", async () => {
        const response = await request(buildApp()).get("/health");
        // Reaches the stand-in "next" handler in this test (real index.ts
        // would let the actual /health route answer instead).
        expect(response.status).toBe(401);
    });

    it("does not intercept non-GET requests, even to a web-app-looking path", async () => {
        const response = await request(buildApp()).post("/document/123");
        expect(response.status).toBe(401);
    });
});

describe("createWebFrontendMiddleware — relative path regression (production incident)", () => {
    // The existing describe block above only ever exercises an ABSOLUTE
    // webBuildPath (fs.mkdtempSync returns one) — which is exactly why the
    // real bug shipped despite that coverage: WEB_BUILD_PATH=.\web-dist in
    // .env is relative, and a relative path reaching res.sendFile() throws
    // "path must be absolute or specify root to res.sendFile" — a
    // synchronous throw from inside serve-static's own error callback,
    // outside Express's normal request-handler try/catch, which crashed
    // the entire Node process in production (not just the web frontend —
    // the whole API went down until manually restarted). These tests use
    // a genuinely relative path to make sure that specific scenario is
    // covered, not just the absolute-path happy path.
    let tmpRoot: string;
    let relativeWebBuildPath: string;
    let originalCwd: string;

    beforeAll(() => {
        tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "web-frontend-relpath-test-"));
        fs.writeFileSync(path.join(tmpRoot, "index.html"), "<html>SPA shell</html>");
        originalCwd = process.cwd();
        // Simulate the real deployment: cwd is the app's working directory,
        // and WEB_BUILD_PATH is a relative path like ".\web-dist" from
        // there — createWebFrontendMiddleware must resolve this itself
        // rather than assume the caller already made it absolute.
        process.chdir(tmpRoot);
        relativeWebBuildPath = ".";
    });

    afterAll(() => {
        process.chdir(originalCwd);
        fs.rmSync(tmpRoot, { recursive: true, force: true });
    });

    it("serves the SPA fallback correctly when given a RELATIVE path, without crashing", async () => {
        const app = express();
        app.use(createWebFrontendMiddleware(relativeWebBuildPath));
        app.use((req, res) => res.status(401).json({ error: "Unauthorized" }));

        // /document/123 has no matching static file, so this specifically
        // exercises the res.sendFile() fallback path that crashed in
        // production — this is the regression test for that exact bug.
        const response = await request(app).get("/document/123");
        expect(response.status).toBe(200);
        expect(response.text).toContain("SPA shell");
    });

    it("responds with a clean 500 (not a crash) when index.html is missing entirely", async () => {
        const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), "web-frontend-empty-"));
        try {
            const app = express();
            app.use(createWebFrontendMiddleware(emptyDir));
            app.use((req, res) => res.status(401).json({ error: "Unauthorized" }));

            const response = await request(app).get("/some/client-route");
            expect(response.status).toBe(500);
        } finally {
            fs.rmSync(emptyDir, { recursive: true, force: true });
        }
    });
});
