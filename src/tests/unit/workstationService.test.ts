jest.mock("../../config/database");
jest.mock("../../services/labelPrintingService", () => ({
    handleLabelPrinting: jest.fn().mockResolvedValue(undefined),
}));
jest.mock("../../index", () => ({
    io: { emit: jest.fn() },
}));
jest.mock("axios");

import {
    pollWorkstations,
    handleOrderUpdate,
    importDocument,
    searchPbom,
    OrderUpdate,
} from "../../services/workstationService";
import { getDb } from "../../config/database";
import { handleLabelPrinting } from "../../services/labelPrintingService";
import axios from "axios";

function thenable<T>(value: T) {
    return { then: (resolve: (v: T) => void) => resolve(value) };
}

const mockOrder = {
    _id: "ord1",
    position: "01",
    productOrder: "PO-001",
    projectNumber: "PN-001",
    salesOrder: "SO-001",
    schedule: "SCH-001",
    type: "production",
    createdAt: "2026-01-01",
    customer: "Customer A",
    customerDesc: "Description",
    filename: "doc.pdf",
    maxCycle: 4,
    productDesc: "Product",
    quantity: 10,
    updatedAt: "2026-01-02",
    workplace: "Hardware",
};

const mockUpdate: OrderUpdate = {
    order: mockOrder,
    cycleIndex: 1,
    totalCycles: 4,
    _id: "update1",
    datetime: "2026-01-03T12:00:00Z",
    action: "STARTED",
};

describe("Workstation Service", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe("pollWorkstations", () => {
        it("should update existing workstations and insert new ones", async () => {
            const axiosResponse = {
                data: [
                    { workstation: "WS1", order: { _id: "ord1" } },
                    { workstation: "WS2", order: null },
                ],
            };
            (axios.get as jest.Mock).mockResolvedValue(axiosResponse);

            const db = Object.assign(jest.fn(), {
                fn: { now: jest.fn(() => "CURRENT_TIMESTAMP") },
            });

            db.mockReturnValue({
                where: () => ({
                    first: () => thenable({ id: 1, name: "WS1" }),
                    update: () => thenable(undefined),
                }),
                insert: () => thenable(undefined),
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await pollWorkstations();

            expect(db).toHaveBeenCalledWith("workstations");
        });

        it("should handle API errors gracefully", async () => {
            (axios.get as jest.Mock).mockRejectedValue(new Error("API Error"));

            await pollWorkstations();

            expect(axios.get).toHaveBeenCalled();
        });

        it("should emit workstations-updated event via socket.io", async () => {
            const axiosResponse = {
                data: [{ workstation: "WS1", order: null }],
            };
            (axios.get as jest.Mock).mockResolvedValue(axiosResponse);

            const db = Object.assign(jest.fn(), {
                fn: { now: jest.fn(() => "CURRENT_TIMESTAMP") },
            });
            db.mockReturnValue({
                where: () => ({ first: () => thenable(null) }),
                insert: () => thenable(undefined),
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await pollWorkstations();

            const { io } = require("../../index");
            expect(io.emit).toHaveBeenCalledWith(
                "workstations-updated",
                axiosResponse.data,
            );
        });
    });

    describe("handleOrderUpdate", () => {
        it("should log a STARTED action and trigger label printing", async () => {
            const db = jest.fn();
            db.mockImplementation((table: string) => {
                if (table === "workstation_log") {
                    return { insert: () => thenable(undefined) };
                }
                if (table === "document_print_log") {
                    return {
                        where: () => ({ first: () => thenable(null) }),
                        insert: () => ({
                            onConflict: () => ({
                                ignore: () => thenable(undefined),
                            }),
                        }),
                    };
                }
                return {};
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await handleOrderUpdate(mockUpdate);

            expect(db).toHaveBeenCalledWith("workstation_log");
            expect(handleLabelPrinting).toHaveBeenCalledWith(mockUpdate);
        });

        it("should fetch and print documents on STARTED", async () => {
            (axios.get as jest.Mock).mockResolvedValue({ data: [] });
            const db = jest.fn();
            db.mockImplementation((table: string) => {
                if (table === "workstation_log") {
                    return { insert: () => thenable(undefined) };
                }
                if (table === "document_print_log") {
                    return {
                        where: () => ({ first: () => thenable(null) }),
                        insert: () => ({
                            onConflict: () => ({
                                ignore: () => thenable(undefined),
                            }),
                        }),
                    };
                }
                return {};
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await handleOrderUpdate(mockUpdate);
            await new Promise(process.nextTick);

            expect(axios.get).toHaveBeenCalledWith(
                expect.stringContaining("/api/documents/fetch"),
                expect.objectContaining({
                    params: expect.objectContaining({
                        order_code: mockOrder.projectNumber,
                        position_code: mockOrder.position,
                    }),
                }),
            );
        });

        it("should clear workstation on FINISHED action", async () => {
            const finishedUpdate = {
                ...mockUpdate,
                action: "FINISHED" as const,
            };
            const db = jest.fn();
            db.mockImplementation((table: string) => {
                if (table === "workstation_log") {
                    return { insert: () => thenable(undefined) };
                }
                if (table === "workstations") {
                    return {
                        where: () => ({ update: () => thenable(undefined) }),
                    };
                }
                if (table === "order_archive_log") {
                    return {
                        insert: () => ({
                            onConflict: () => ({
                                ignore: () => thenable(undefined),
                            }),
                        }),
                    };
                }
                return {};
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await handleOrderUpdate(finishedUpdate);

            expect(db).toHaveBeenCalledWith("workstations");
            expect(handleLabelPrinting).toHaveBeenCalledWith(finishedUpdate);
        });

        it("should queue the order for retention archival on FINISHED", async () => {
            const finishedUpdate = {
                ...mockUpdate,
                action: "FINISHED" as const,
            };
            const db = jest.fn();
            const archiveInsert = jest.fn(() => ({
                onConflict: () => ({ ignore: () => thenable(undefined) }),
            }));
            db.mockImplementation((table: string) => {
                if (table === "workstation_log") {
                    return { insert: () => thenable(undefined) };
                }
                if (table === "workstations") {
                    return {
                        where: () => ({ update: () => thenable(undefined) }),
                    };
                }
                if (table === "order_archive_log") {
                    return { insert: archiveInsert };
                }
                return {};
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await handleOrderUpdate(finishedUpdate);

            expect(db).toHaveBeenCalledWith("order_archive_log");
            expect(archiveInsert).toHaveBeenCalledWith(
                expect.objectContaining({
                    order_id: mockOrder._id,
                    project_number: mockOrder.projectNumber,
                    position: mockOrder.position,
                }),
            );
        });

        it("should propagate errors", async () => {
            (getDb as jest.Mock).mockRejectedValue(new Error("DB Error"));

            await expect(handleOrderUpdate(mockUpdate)).rejects.toThrow(
                "DB Error",
            );
        });

        it("should not fetch or print documents on FINISHED", async () => {
            const finishedUpdate = {
                ...mockUpdate,
                action: "FINISHED" as const,
            };
            const db = jest.fn();
            db.mockImplementation((table: string) => {
                if (table === "workstation_log") {
                    return { insert: () => thenable(undefined) };
                }
                if (table === "workstations") {
                    return {
                        where: () => ({ update: () => thenable(undefined) }),
                    };
                }
                if (table === "order_archive_log") {
                    return {
                        insert: () => ({
                            onConflict: () => ({
                                ignore: () => thenable(undefined),
                            }),
                        }),
                    };
                }
                return {};
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await handleOrderUpdate(finishedUpdate);
            // Give fire-and-forget promises a chance to run
            await new Promise(process.nextTick);

            // No document fetches should happen on FINISHED
            expect(axios.get).not.toHaveBeenCalledWith(
                expect.stringContaining("/api/documents/fetch"),
                expect.anything(),
            );
        });
    });

    describe("importDocument", () => {
        it("should fetch a document and create a local record", async () => {
            const mockHeadResponse = {
                headers: { "content-disposition": 'filename="test.pdf"' },
                data: { destroy: jest.fn() },
            };
            (axios.get as jest.Mock).mockResolvedValue(mockHeadResponse);

            const db = Object.assign(jest.fn(), {
                fn: { now: jest.fn(() => "CURRENT_TIMESTAMP") },
            });
            db.mockReturnValueOnce({
                insert: () => ({ returning: () => [1] }),
            })
                .mockReturnValueOnce({ insert: () => thenable(undefined) })
                .mockReturnValueOnce({
                    where: () => ({
                        first: () => thenable({ id: 1, name: "test.pdf" }),
                    }),
                })
                .mockReturnValueOnce({
                    where: () => ({
                        orderBy: () => thenable([{ id: 1, version: 1 }]),
                    }),
                });
            (getDb as jest.Mock).mockResolvedValue(db);

            const result = await importDocument({
                projectNumber: "PN-001",
                position: "01",
                customer: "Customer A",
            });

            expect(result).toHaveProperty("id", 1);
            expect(result).toHaveProperty("name", "test.pdf");
            expect(result).toHaveProperty("revisions");
        });
    });

    describe("searchPbom", () => {
        it("should return matching results", async () => {
            (axios.get as jest.Mock).mockImplementation(
                (url: string, config: any) => {
                    if (url.includes("/orders")) {
                        return Promise.resolve({ data: ["12345", "67890"] });
                    }
                    if (url.includes("/positions")) {
                        return Promise.resolve({ data: ["01", "02"] });
                    }
                    if (url.includes("/api/documents/fetch")) {
                        // Only position "01" has a BOM (Hardware) — "02" has none.
                        const { position_code, document_type } =
                            config.params;
                        const hasDoc =
                            position_code === "01" && document_type === 14;
                        return Promise.resolve({
                            status: hasDoc ? 200 : 404,
                            data: { destroy: jest.fn() },
                        });
                    }
                    return Promise.resolve({ data: [] });
                },
            );

            const results = await searchPbom("12345");

            expect(results.length).toBeGreaterThan(0);
            expect(results[0]).toHaveProperty("order_code", 12345);
            expect(results[0]).toHaveProperty("position_code", 1);
        });

        it("should return empty array when no matching order found", async () => {
            (axios.get as jest.Mock).mockResolvedValue({ data: ["67890"] });

            const results = await searchPbom("99999");

            expect(results).toEqual([]);
        });
    });
});
