import request from "supertest";
import express from "express";
import queueRoutes from "../../routes/queue";
import { getDb } from "../../config/database";

jest.mock("../../config/database");
jest.mock("../../index", () => ({
    io: {
        emit: jest.fn(),
    },
}));

function thenable<T>(value: T) {
    return { then: (resolve: (v: T) => void) => resolve(value) };
}

const app = express();
app.use(express.json());
app.use("/queue", queueRoutes);

describe("API Integration Tests", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("GET /queue", () => {
        it("should return 200 and all documents with revisions", async () => {
            const mockDocs = [{ id: 1, name: "test.pdf" }];
            const mockRevisions = [{ id: 1, document_id: 1, filename: "test.pdf", version: 1 }];

            const db = jest.fn();
            db.mockImplementation((table: string) => {
                if (table === "documents") {
                    return { orderBy: () => thenable(mockDocs) };
                }
                return { where: () => ({ orderBy: () => thenable(mockRevisions) }) };
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            const response = await request(app).get("/queue");

            expect(response.status).toBe(200);
            expect(response.body).toEqual([{ ...mockDocs[0], revisions: mockRevisions }]);
        });
    });

    describe("GET /health", () => {
        it("should return 200 and status ok", async () => {
            const healthApp = express();
            healthApp.get("/health", (req, res) => res.json({ status: "ok" }));

            const response = await request(healthApp).get("/health");
            expect(response.status).toBe(200);
            expect(response.body).toEqual({ status: "ok" });
        });
    });
});
