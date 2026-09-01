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
