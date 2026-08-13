jest.mock("../../services/completionService");
jest.mock("../../services/documentPrinterService");

import { Request, Response } from "express";
import {
    createPrepLabel,
    createOrderCheck,
} from "../../controllers/completionController";
import {
    recordOrderPreparation,
    recordOrderCheck,
    isValidCheckStatus,
} from "../../services/completionService";
import { buildPrepLabelPdf } from "../../services/documentPrinterService";

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

            expect(buildPrepLabelPdf).toHaveBeenCalledWith("P1", "10", "Jan Novak", 1);
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

            expect(buildPrepLabelPdf).toHaveBeenCalledWith("P1", "10", "Jan Novak", 3);
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
            expect(buildPrepLabelPdf).toHaveBeenCalledWith("P1", "10", "Jan Novak", 2);

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
            expect(buildPrepLabelPdf).toHaveBeenCalledWith("P1", "10", "Jan Novak", 1);
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

    describe("createOrderCheck", () => {
        it("should return 400 if required fields (including cycleIndex) are missing", async () => {
            mockRequest = {
                body: { projectNumber: "P1", position: "10", employeeName: "Jan Novak", status: "ok" },
            };

            await createOrderCheck(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({
                error: "projectNumber, position, cycleIndex, employeeName, and status are required",
            });
            expect(recordOrderCheck).not.toHaveBeenCalled();
        });

        it("should return 400 for an invalid status value", async () => {
            (isValidCheckStatus as unknown as jest.Mock).mockReturnValue(false);
            mockRequest = {
                body: {
                    projectNumber: "P1",
                    position: "10",
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
