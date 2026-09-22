import request from "supertest";
import express from "express";
import { apiKeyAuth, adminPinAuth } from "../../middleware/apiKeyAuth";

function buildApp() {
    const app = express();
    app.use(apiKeyAuth);
    app.get("/health", (req, res) => res.json({ status: "ok" }));
    app.get("/protected", (req, res) => res.json({ status: "ok" }));
    app.post("/workstations/order-update", (req, res) =>
        res.json({ status: "ok" }),
    );
    return app;
}

describe("apiKeyAuth middleware", () => {
    const ORIGINAL_API_KEY = process.env.API_KEY;

    afterEach(() => {
        process.env.API_KEY = ORIGINAL_API_KEY;
    });

    it("allows /health through without a key, even when unconfigured", async () => {
        delete process.env.API_KEY;
        const response = await request(buildApp()).get("/health");
        expect(response.status).toBe(200);
    });

    it("allows POST /workstations/order-update through without a key", async () => {
        // Webhook from the external production system, which can't send the
        // API key — must stay reachable even when unconfigured.
        delete process.env.API_KEY;
        const response = await request(buildApp()).post(
            "/workstations/order-update",
        );
        expect(response.status).toBe(200);
    });

    it("responds 500 when API_KEY is not configured", async () => {
        delete process.env.API_KEY;
        const response = await request(buildApp()).get("/protected");
        expect(response.status).toBe(500);
    });

    it("rejects requests with no X-API-Key header", async () => {
        process.env.API_KEY = "secret";
        const response = await request(buildApp()).get("/protected");
        expect(response.status).toBe(401);
    });

    it("rejects requests with an incorrect X-API-Key header", async () => {
        process.env.API_KEY = "secret";
        const response = await request(buildApp())
            .get("/protected")
            .set("X-API-Key", "wrong-key");
        expect(response.status).toBe(401);
    });

    it("allows requests with the correct X-API-Key header", async () => {
        process.env.API_KEY = "secret";
        const response = await request(buildApp())
            .get("/protected")
            .set("X-API-Key", "secret");
        expect(response.status).toBe(200);
        expect(response.body).toEqual({ status: "ok" });
    });

    it("allows requests with a correct ?apiKey= query param (no header)", async () => {
        // Fallback for the PDF WebView/iframe, which can't set custom headers.
        process.env.API_KEY = "secret";
        const response = await request(buildApp()).get("/protected?apiKey=secret");
        expect(response.status).toBe(200);
    });

    it("rejects requests with an incorrect ?apiKey= query param", async () => {
        process.env.API_KEY = "secret";
        const response = await request(buildApp()).get("/protected?apiKey=wrong-key");
        expect(response.status).toBe(401);
    });
});

describe("adminPinAuth middleware", () => {
    const ORIGINAL_PIN = process.env.EMPLOYEE_ADMIN_PIN;

    function buildPinApp() {
        const app = express();
        app.get("/employees/admin", adminPinAuth, (req, res) => res.json({ status: "ok" }));
        return app;
    }

    afterEach(() => {
        process.env.EMPLOYEE_ADMIN_PIN = ORIGINAL_PIN;
    });

    it("responds 500 when EMPLOYEE_ADMIN_PIN is not configured, even with a header sent", async () => {
        delete process.env.EMPLOYEE_ADMIN_PIN;
        const response = await request(buildPinApp())
            .get("/employees/admin")
            .set("X-Admin-Pin", "1234");
        expect(response.status).toBe(500);
    });

    it("rejects requests with no X-Admin-Pin header", async () => {
        process.env.EMPLOYEE_ADMIN_PIN = "1234";
        const response = await request(buildPinApp()).get("/employees/admin");
        expect(response.status).toBe(401);
    });

    it("rejects requests with the wrong PIN", async () => {
        process.env.EMPLOYEE_ADMIN_PIN = "1234";
        const response = await request(buildPinApp())
            .get("/employees/admin")
            .set("X-Admin-Pin", "0000");
        expect(response.status).toBe(401);
    });

    it("allows requests with the correct PIN", async () => {
        process.env.EMPLOYEE_ADMIN_PIN = "1234";
        const response = await request(buildPinApp())
            .get("/employees/admin")
            .set("X-Admin-Pin", "1234");
        expect(response.status).toBe(200);
    });
});
