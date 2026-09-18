jest.mock("../../services/completionService");
jest.mock("../../services/documentPrinterService");
jest.mock("../../services/toorsService");
// Keep motorCycleRange's real math (it's pure and is exactly what these
// tests verify) but mock getOrderCycleSnapshot, which otherwise hits a
// real DB via getDb().
jest.mock("../../services/workstationService", () => ({
    ...jest.requireActual("../../services/workstationService"),
    getOrderCycleSnapshot: jest.fn(),
}));
jest.mock("../../index", () => ({ io: { emit: jest.fn() } }));

import { Request, Response } from "express";
import {
    createPrepLabel,
    createOrderCheck,
    createOrderCompletion,
    getCompletionQueueHandler,
} from "../../controllers/completionController";
import {
    recordOrderPreparation,
    recordOrderCheck,
    recordOrderCompletion,
    isValidCheckStatus,
    isValidCompletionStatus,
    getCompletionQueue,
} from "../../services/completionService";
import { buildPrepLabelPdf } from "../../services/documentPrinterService";
import { closeOrderInToors } from "../../services/toorsService";
import { getOrderCycleSnapshot } from "../../services/workstationService";
import { io } from "../../index";

describe("Completion Controller", () => {
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;
    let mockJson: jest.Mock;
    let mockStatus: jest.Mock;
    let mockSend: jest.Mock;
    let mockSetHeader: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockJson = jest.fn();
        mockSend = jest.fn();
        mockSetHeader = jest.fn();
        mockStatus = jest.fn(() => mockResponse as Response);
        mockResponse = { json: mockJson, status: mockStatus, send: mockSend, setHeader: mockSetHeader };
        (buildPrepLabelPdf as jest.Mock).mockReturnValue(Buffer.from("%PDF-fake"));
        // isValidCheckStatus is auto-mocked (jest.mock with no factory), so
        // it returns undefined by default — real "ok"/"issue" checks would
        // otherwise always fail the controller's validation gate. Its own
        // real logic isn't what these tests are about, so give it a sane
        // default and override per-test where the invalid-status path is
        // actually being exercised.
        (isValidCheckStatus as unknown as jest.Mock).mockReturnValue(true);
        (isValidCompletionStatus as unknown as jest.Mock).mockReturnValue(true);
        (closeOrderInToors as jest.Mock).mockResolvedValue({ queued: true, order_number: "PO1" });
        (getOrderCycleSnapshot as jest.Mock).mockResolvedValue(null);
    });

    describe("createPrepLabel", () => {
        it("should return 400 if required fields are missing", async () => {
            mockRequest = { body: { projectNumber: "P1" } };

            await createPrepLabel(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({
                error: "projectNumber, position, and employeeName are required",
            });
            expect(buildPrepLabelPdf).not.toHaveBeenCalled();
        });

        it("defaults totalCycles to 1 when not provided", async () => {
            mockRequest = {
                body: { projectNumber: "P1", position: "10", employeeName: "Jan Novak" },
            };

            await createPrepLabel(mockRequest as Request, mockResponse as Response);

            expect(buildPrepLabelPdf).toHaveBeenCalledWith("P1", "10", "Jan Novak", 1, null, null);
            expect(recordOrderPreparation).toHaveBeenCalledWith("P1", "10", "Jan Novak", 1);
            expect(mockSetHeader).toHaveBeenCalledWith("Content-Type", "application/pdf");
            expect(mockSend).toHaveBeenCalled();
        });

        it("passes totalCycles through to both the PDF and the preparation log, one label/row per box", async () => {
            mockRequest = {
                body: {
                    projectNumber: "P1",
                    position: "10",
                    employeeName: "Jan Novak",
                    totalCycles: 3,
                },
            };

            await createPrepLabel(mockRequest as Request, mockResponse as Response);

            expect(buildPrepLabelPdf).toHaveBeenCalledWith("P1", "10", "Jan Novak", 3, null, null);
            expect(recordOrderPreparation).toHaveBeenCalledWith("P1", "10", "Jan Novak", 3);
        });

        it("floors a non-integer totalCycles and ignores a non-positive one", async () => {
            mockRequest = {
                body: {
                    projectNumber: "P1",
                    position: "10",
                    employeeName: "Jan Novak",
                    totalCycles: 2.9,
                },
            };
            await createPrepLabel(mockRequest as Request, mockResponse as Response);
            expect(buildPrepLabelPdf).toHaveBeenCalledWith("P1", "10", "Jan Novak", 2, null, null);

            jest.clearAllMocks();
            (buildPrepLabelPdf as jest.Mock).mockReturnValue(Buffer.from("%PDF-fake"));
            mockRequest = {
                body: {
                    projectNumber: "P1",
                    position: "10",
                    employeeName: "Jan Novak",
                    totalCycles: 0,
                },
            };
            await createPrepLabel(mockRequest as Request, mockResponse as Response);
            expect(buildPrepLabelPdf).toHaveBeenCalledWith("P1", "10", "Jan Novak", 1, null, null);
        });

        it("should return 500 with the underlying error message on failure", async () => {
            (buildPrepLabelPdf as jest.Mock).mockImplementation(() => {
                throw new Error("PDF build failed");
            });
            mockRequest = {
                body: { projectNumber: "P1", position: "10", employeeName: "Jan Novak" },
            };

            await createPrepLabel(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
            expect(mockJson).toHaveBeenCalledWith({ error: "PDF build failed" });
        });
    });

    describe("createOrderCompletion", () => {
        it("closes exactly 1 unit in TOORS for a non-Motor workstation, even when the body's quantity is the order's full quantity", async () => {
            mockRequest = {
                body: {
                    orderId: "order1",
                    workstation: "Hardware",
                    cycleIndex: 1,
                    totalCycles: 20,
                    productOrder: "PO1",
                    employeeName: "Jan Novak",
                    status: "complete",
                    quantity: 20,
                },
            };

            await createOrderCompletion(mockRequest as Request, mockResponse as Response);

            expect(closeOrderInToors).toHaveBeenCalledWith("PO1", 1);
        });

        it("falls back to the body's quantity for Motor when no order snapshot is on record", async () => {
            // getOrderCycleSnapshot resolves null (beforeEach default) — no
            // workstation_log row for this order+cycle to re-derive from.
            mockRequest = {
                body: {
                    orderId: "order1",
                    workstation: "Motor",
                    cycleIndex: 1,
                    totalCycles: 1,
                    productOrder: "PO1",
                    employeeName: "Jan Novak",
                    status: "complete",
                    quantity: 20,
                },
            };

            await createOrderCompletion(mockRequest as Request, mockResponse as Response);

            expect(closeOrderInToors).toHaveBeenCalledWith("PO1", 20);
        });

        it("closes only THIS cycle's batch for Motor, re-derived from the recorded order snapshot — not the body's total quantity (the reported bug)", async () => {
            // Order snapshot: quantity=9 total, maxCycle=5 → cycle 2/2 = the
            // remaining 4, regardless of what quantity the mobile app sent.
            (getOrderCycleSnapshot as jest.Mock).mockResolvedValue({ quantity: 9, maxCycle: 5 });
            mockRequest = {
                body: {
                    orderId: "order1",
                    workstation: "Motor",
                    cycleIndex: 2,
                    totalCycles: 2,
                    productOrder: "PO1",
                    employeeName: "Jan Novak",
                    status: "complete",
                    quantity: 9, // the order's raw total, same value on every cycle
                },
            };

            await createOrderCompletion(mockRequest as Request, mockResponse as Response);

            expect(getOrderCycleSnapshot).toHaveBeenCalledWith("order1", 2);
            expect(closeOrderInToors).toHaveBeenCalledWith("PO1", 4);
        });

        it("does not call TOORS for a non-complete status", async () => {
            mockRequest = {
                body: {
                    orderId: "order1",
                    workstation: "Hardware",
                    productOrder: "PO1",
                    employeeName: "Jan Novak",
                    status: "missing_product",
                    quantity: 20,
                },
            };

            await createOrderCompletion(mockRequest as Request, mockResponse as Response);

            expect(recordOrderCompletion).toHaveBeenCalledTimes(1);
            expect(closeOrderInToors).not.toHaveBeenCalled();
        });

        it("emits order-completed so a sibling kiosk tablet can drop this order/cycle from its queue", async () => {
            mockRequest = {
                body: {
                    orderId: "order1",
                    workstation: "Hardware",
                    cycleIndex: 2,
                    totalCycles: 3,
                    productOrder: "PO1",
                    employeeName: "Jan Novak",
                    status: "complete",
                },
            };

            await createOrderCompletion(mockRequest as Request, mockResponse as Response);

            expect(io.emit).toHaveBeenCalledWith("order-completed", {
                orderId: "order1",
                cycleIndex: 2,
            });
        });

        it("emits order-completed for a non-complete status too — any status means this cycle is resolved", async () => {
            mockRequest = {
                body: {
                    orderId: "order1",
                    workstation: "Hardware",
                    cycleIndex: 1,
                    employeeName: "Jan Novak",
                    status: "missing_product",
                },
            };

            await createOrderCompletion(mockRequest as Request, mockResponse as Response);

            expect(io.emit).toHaveBeenCalledWith("order-completed", {
                orderId: "order1",
                cycleIndex: 1,
            });
        });
    });

    describe("getCompletionQueueHandler", () => {
        it("returns the queue for the given workplace", async () => {
            const queue = [{ order: { _id: "order1" }, cycleIndex: 1, totalCycles: 1 }];
            (getCompletionQueue as jest.Mock).mockResolvedValue(queue);
            mockRequest = { query: { workplace: "Motor" } };

            await getCompletionQueueHandler(mockRequest as Request, mockResponse as Response);

            expect(getCompletionQueue).toHaveBeenCalledWith("Motor");
            expect(mockJson).toHaveBeenCalledWith(queue);
        });

        it("passes undefined when no workplace filter is given", async () => {
            (getCompletionQueue as jest.Mock).mockResolvedValue([]);
            mockRequest = { query: {} };

            await getCompletionQueueHandler(mockRequest as Request, mockResponse as Response);

            expect(getCompletionQueue).toHaveBeenCalledWith(undefined);
        });

        it("returns 500 on a service error", async () => {
            (getCompletionQueue as jest.Mock).mockRejectedValue(new Error("DB error"));
            mockRequest = { query: {} };

            await getCompletionQueueHandler(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
        });
    });

    describe("createOrderCheck", () => {
        it("should return 400 if required fields (including workstation/cycleIndex) are missing", async () => {
            mockRequest = {
                body: { projectNumber: "P1", position: "10", employeeName: "Jan Novak", status: "ok" },
            };

            await createOrderCheck(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({
                error: "projectNumber, position, workstation, cycleIndex, employeeName, and status are required",
            });
            expect(recordOrderCheck).not.toHaveBeenCalled();
        });

        it("should return 400 for an invalid status value", async () => {
            (isValidCheckStatus as unknown as jest.Mock).mockReturnValue(false);
            mockRequest = {
                body: {
                    projectNumber: "P1",
                    position: "10",
                    workstation: "Hardware",
                    cycleIndex: 1,
                    employeeName: "Jan Novak",
                    status: "maybe",
                },
            };

            await createOrderCheck(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({
                error: "status must be one of: ok, issue",
            });
            expect(recordOrderCheck).not.toHaveBeenCalled();
        });

        it("records a check for exactly the one cycle specified — not the whole order", async () => {
            mockRequest = {
                body: {
                    projectNumber: "P1",
                    position: "10",
                    workstation: "Hardware",
                    cycleIndex: 2,
                    totalCycles: 3,
                    employeeName: "Petr Svoboda",
                    status: "ok",
                },
            };

            await createOrderCheck(mockRequest as Request, mockResponse as Response);

            expect(recordOrderCheck).toHaveBeenCalledTimes(1);
            expect(recordOrderCheck).toHaveBeenCalledWith({
                projectNumber: "P1",
                position: "10",
                workstation: "Hardware",
                cycleIndex: 2,
                totalCycles: 3,
                employeeName: "Petr Svoboda",
                status: "ok",
                note: undefined,
            });
            expect(mockStatus).toHaveBeenCalledWith(201);
            expect(mockJson).toHaveBeenCalledWith({ status: "ok" });
        });

        it("defaults totalCycles to 1 and passes through an optional note", async () => {
            mockRequest = {
                body: {
                    projectNumber: "P1",
                    position: "10",
                    workstation: "Hardware",
                    cycleIndex: 1,
                    employeeName: "Petr Svoboda",
                    status: "issue",
                    note: "Missing bracket",
                },
            };

            await createOrderCheck(mockRequest as Request, mockResponse as Response);

            expect(recordOrderCheck).toHaveBeenCalledTimes(1);
            expect(recordOrderCheck).toHaveBeenCalledWith({
                projectNumber: "P1",
                position: "10",
                workstation: "Hardware",
                cycleIndex: 1,
                totalCycles: 1,
                employeeName: "Petr Svoboda",
                status: "issue",
                note: "Missing bracket",
            });
        });

        it("should return 500 on a service error", async () => {
            (recordOrderCheck as jest.Mock).mockRejectedValue(new Error("DB Error"));
            mockRequest = {
                body: {
                    projectNumber: "P1",
                    position: "10",
                    workstation: "Hardware",
                    cycleIndex: 1,
                    employeeName: "Jan Novak",
                    status: "ok",
                },
            };

            await createOrderCheck(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
            expect(mockJson).toHaveBeenCalledWith({ error: "Internal server error" });
        });
    });
});
