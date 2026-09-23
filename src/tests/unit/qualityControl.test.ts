jest.mock("../../config/database");

import request from "supertest";
import express from "express";
import { getDb } from "../../config/database";
import {
    createQualityEngineer,
    findEngineerByPin,
    updateQualityEngineer,
    setQualityEngineerActive,
} from "../../services/qualityControlService";
import {
    verifyQcPin,
    createOrderQcCheck,
    resetQcPinLockouts,
} from "../../controllers/qualityControlController";

// Tiny in-memory stand-in for the two tables involved — enough of knex's
// chain for what qualityControlService actually calls.
function fakeDb() {
    const tables: Record<string, any[]> = { quality_engineers: [], order_qc_checks: [] };
    let nextId = 1;
    const db = jest.fn((table: string) => {
        const rows = tables[table]!;
        let filtered = rows;
        const chain: any = {
            where(cond: Record<string, unknown>) {
                filtered = filtered.filter((r) => Object.entries(cond).every(([k, v]) => r[k] === v));
                return chain;
            },
            select: () => chain,
            orderBy: () => chain,
            insert(row: any) {
                const inserted = { id: nextId++, ...row };
                rows.push(inserted);
                filtered = [inserted];
                return chain;
            },
            update(patch: any) {
                filtered.forEach((r) => Object.assign(r, patch));
                return chain;
            },
            returning: () => Promise.resolve(filtered.map(({ pin_hash, ...rest }) => rest)),
            then: (resolve: any) => resolve(filtered),
        };
        return chain;
    });
    return { db, tables };
}

describe("qualityControlService", () => {
    let tables: Record<string, any[]>;

    beforeEach(() => {
        const fake = fakeDb();
        tables = fake.tables;
        (getDb as jest.Mock).mockResolvedValue(fake.db);
    });

    it("never stores the PIN in plain text, and finds the engineer by it", async () => {
        await createQualityEngineer("Eva Kvalitní", "4821");

        expect(tables.quality_engineers![0].pin_hash).not.toContain("4821");
        expect((await findEngineerByPin("4821"))?.name).toBe("Eva Kvalitní");
        expect(await findEngineerByPin("0000")).toBeNull();
    });

    it("rejects a PIN that isn't 4-8 digits", async () => {
        await expect(createQualityEngineer("A", "12")).rejects.toThrow("4-8 digits");
        await expect(createQualityEngineer("A", "abcd")).rejects.toThrow("4-8 digits");
    });

    it("refuses a PIN another engineer already has — even a hidden one", async () => {
        const eva = await createQualityEngineer("Eva", "4821");
        await setQualityEngineerActive(eva.id, false);

        await expect(createQualityEngineer("Petr", "4821")).rejects.toThrow("already used");
    });

    it("a hidden engineer's PIN stops working, and works again once restored", async () => {
        const eva = await createQualityEngineer("Eva", "4821");

        await setQualityEngineerActive(eva.id, false);
        expect(await findEngineerByPin("4821")).toBeNull();

        await setQualityEngineerActive(eva.id, true);
        expect((await findEngineerByPin("4821"))?.id).toBe(eva.id);
    });

    it("updating without a PIN keeps the old one; with a PIN replaces it", async () => {
        const eva = await createQualityEngineer("Eva", "4821");

        await updateQualityEngineer(eva.id, "Eva N.", "");
        expect((await findEngineerByPin("4821"))?.name).toBe("Eva N.");

        await updateQualityEngineer(eva.id, "Eva N.", "9999");
        expect(await findEngineerByPin("4821")).toBeNull();
        expect((await findEngineerByPin("9999"))?.name).toBe("Eva N.");
    });
});

describe("QC sign-off endpoints", () => {
    let tables: Record<string, any[]>;

    function buildApp() {
        const app = express();
        app.use(express.json());
        app.post("/qc-check/verify", verifyQcPin);
        app.post("/order-qc-check", createOrderQcCheck);
        return app;
    }

    const body = {
        projectNumber: "P1",
        position: "10",
        workstation: "Hardware",
        cycleIndex: 2,
        totalCycles: 4,
        status: "ok",
    };

    beforeEach(async () => {
        resetQcPinLockouts();
        const fake = fakeDb();
        tables = fake.tables;
        (getDb as jest.Mock).mockResolvedValue(fake.db);
        await createQualityEngineer("Eva", "4821");
    });

    it("verify returns the engineer for the right PIN (sent as a header)", async () => {
        const res = await request(buildApp()).post("/qc-check/verify").set("X-QC-Pin", "4821");
        expect(res.status).toBe(200);
        expect(res.body.name).toBe("Eva");
    });

    it("records the sign-off under the PIN owner's name", async () => {
        const res = await request(buildApp()).post("/order-qc-check").set("X-QC-Pin", "4821").send(body);

        expect(res.status).toBe(201);
        expect(tables.order_qc_checks![0]).toMatchObject({
            project_number: "P1",
            cycle_index: 2,
            engineer_name: "Eva",
            status: "ok",
        });
    });

    it("rejects a wrong PIN without recording anything", async () => {
        const res = await request(buildApp()).post("/order-qc-check").set("X-QC-Pin", "0000").send(body);

        expect(res.status).toBe(401);
        expect(tables.order_qc_checks).toHaveLength(0);
    });

    it("locks the client out after 5 wrong PINs — even the right PIN then gets 429", async () => {
        const app = buildApp();
        for (let i = 0; i < 5; i++) {
            await request(app).post("/qc-check/verify").set("X-QC-Pin", "0000");
        }
        const res = await request(app).post("/qc-check/verify").set("X-QC-Pin", "4821");
        expect(res.status).toBe(429);
    });
});
