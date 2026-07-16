jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return {
        ...actual,
        watchFile: jest.fn(),
    };
});

import request from "supertest";
import express from "express";
import workstationRoutes from "../../routes/workstations";
import { getDb } from "../../config/database";
import {
    handleOrderUpdate,
    importDocument,
    searchPbom,
} from "../../services/workstationService";

jest.mock("../../config/database");
jest.mock("../../services/workstationService");
jest.mock("../../index", () => ({
    io: { emit: jest.fn() },
}));
jest.mock("axios");

function thenable<T>(value: T) {
    return { then: (resolve: (v: T) => void) => resolve(value) };
}

const app = express();
app.use(express.json());
app.use("/workstations", workstationRoutes);

describe("Workstation API Integration", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("GET /workstations", () => {
        it("should return 200 and list of workstations", async () => {
            const mockWorkstations = [
                {
                    id: 1,
                    name: "WS1",
                    current_order_id: null,
                    current_order_data: null,
                },
            ];
            const db = jest.fn();
            db.mockReturnValue({ orderBy: () => thenable(mockWorkstations) });
            (getDb as jest.Mock).mockResolvedValue(db);

            const response = await request(app).get("/workstations");

            expect(response.status).toBe(200);
            expect(response.body).toEqual(mockWorkstations);
        });
    });

    describe("POST /workstations/order-update", () => {
        it("should return 200 for valid STARTED payload", async () => {
            (handleOrderUpdate as jest.Mock).mockResolvedValue(undefined);

            const response = await request(app)
                .post("/workstations/order-update")
                .send({
                    order: {
                        _id: "ord1",
                        position: "01",
                        productOrder: "PO-001",
                        projectNumber: "PN-001",
                        salesOrder: "SO-001",
                        schedule: "SCH-001",
                        type: "production",
                        createdAt: "2026-01-01",
                        customer: "Customer",
                        customerDesc: "Desc",
                        filename: "doc.pdf",
                        maxCycle: 4,
                        productDesc: "Product",
                        quantity: 10,
                        updatedAt: "2026-01-02",
                        workplace: "Hardware",
                    },
                    cycleIndex: 1,
                    totalCycles: 4,
                    _id: "update1",
                    datetime: "2026-01-03T12:00:00Z",
                    action: "STARTED",
                });

            expect(response.status).toBe(200);
            expect(response.body).toEqual({ status: "ok" });
        });

        it("should return 400 for missing action", async () => {
            const response = await request(app)
                .post("/workstations/order-update")
                .send({ order: { _id: "ord1" } });

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                error: "Invalid payload: order and action are required",
            });
        });

        it("should return 400 for invalid action", async () => {
            const response = await request(app)
                .post("/workstations/order-update")
                .send({ order: { _id: "ord1" }, action: "INVALID" });

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                error: "Invalid action. Must be STARTED or FINISHED",
            });
        });
    });

    describe("POST /workstations/import-pbom", () => {
        it("should return 200 with imported document", async () => {
            const mockDoc = { id: 1, name: "test.pdf", revisions: [] };
            (importDocument as jest.Mock).mockResolvedValue(mockDoc);

            const response = await request(app)
                .post("/workstations/import-pbom")
                .send({
                    projectNumber: "PN-001",
                    position: "01",
                    customer: "Customer",
                });

            expect(response.status).toBe(200);
            expect(response.body).toEqual(mockDoc);
        });

        it("should return 400 for missing fields", async () => {
            const response = await request(app)
                .post("/workstations/import-pbom")
                .send({});

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                error: "projectNumber, position, and customer are required",
            });
        });
    });

    describe("GET /workstations/search-pbom", () => {
        it("should return 200 with search results", async () => {
            const mockResults = [
                { customer_code: 0, order_code: 12345, position_code: 1 },
            ];
            (searchPbom as jest.Mock).mockResolvedValue(mockResults);

            const response = await request(app)
                .get("/workstations/search-pbom")
                .query({ order_code: "12345" });

            expect(response.status).toBe(200);
            expect(response.body).toEqual(mockResults);
        });

        it("should return 400 when order_code is missing", async () => {
            const response = await request(app).get(
                "/workstations/search-pbom",
            );

            expect(response.status).toBe(400);
            expect(response.body).toEqual({
                error: "order_code query parameter is required",
            });
        });
    });

    describe("GET /workstations/log", () => {
        it("should return 200 with logs", async () => {
            const mockLogs = [
                {
                    id: 1,
                    workstation_name: "WS1",
                    order_id: "ord1",
                    action: "STARTED",
                    order_snapshot: null,
                },
            ];
            const db = jest.fn();
            db.mockReturnValue({ orderBy: () => thenable(mockLogs) });
            (getDb as jest.Mock).mockResolvedValue(db);

            const response = await request(app).get("/workstations/log");

            expect(response.status).toBe(200);
            expect(response.body).toEqual(mockLogs);
        });
    });
});
