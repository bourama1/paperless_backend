jest.mock("../../config/database");
jest.mock("../../services/notificationService");

// Wrap fs with jest mocks; readFileSync delegates to real fs by default
// so country-codes.json loads correctly at module-import time.
jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return {
        ...actual,
        readFileSync: jest.fn((...args: any[]) =>
            (actual as any).readFileSync(...args),
        ),
        writeFileSync: jest.fn(),
        unlinkSync: jest.fn(),
        existsSync: jest.fn(() => true),
    };
});

jest.mock("pdf-lib", () => ({
    PDFDocument: {
        load: jest.fn(),
    },
    rgb: jest.fn(() => ({ r: 1, g: 0, b: 0 })),
}));

jest.mock("../../services/pdfaService", () => ({
    convertToPdfA: jest.fn(),
    PdfaConversionError: class PdfaConversionError extends Error {},
}));

import { reviseFile, exportPdfa } from "../../controllers/filesController";
import { getDb } from "../../config/database";
import { notifyQueueUpdate } from "../../services/notificationService";
import { Request, Response } from "express";
import fs from "fs";
import { PDFDocument } from "pdf-lib";
import { convertToPdfA, PdfaConversionError } from "../../services/pdfaService";

function thenable<T>(value: T) {
    return { then: (resolve: (v: T) => void) => resolve(value) };
}

describe("Files Controller", () => {
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;
    let mockJson: jest.Mock;
    let mockStatus: jest.Mock;

    beforeEach(() => {
        mockJson = jest.fn();
        mockStatus = jest.fn().mockReturnValue({ json: mockJson });
        mockResponse = { json: mockJson, status: mockStatus };

        const mockPdfDoc = {
            getPages: jest.fn().mockReturnValue([
                {
                    getSize: jest
                        .fn()
                        .mockReturnValue({ width: 100, height: 100 }),
                    drawLine: jest.fn(),
                },
            ]),
            save: jest.fn().mockResolvedValue(Buffer.from("%PDF-1.4 mock")),
        };

        (PDFDocument.load as jest.Mock).mockResolvedValue(mockPdfDoc);
        (fs.readFileSync as jest.Mock).mockReturnValue(
            Buffer.from("%PDF-1.4 mock"),
        );
        (fs.writeFileSync as jest.Mock).mockImplementation(() => {});
        (fs.unlinkSync as jest.Mock).mockImplementation(() => {});
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe("reviseFile", () => {
        it("should successfully revise a file and create a new revision", async () => {
            mockRequest = {
                params: { id: "1" },
                body: { annotations: JSON.stringify([]) },
                file: { path: "temp/path", filename: "new_file.pdf" } as any,
            };
            const mockDoc = { id: 1, name: "document.pdf" };
            const mockLatestRevision = { version: 1, filename: "document.pdf" };
            const mockUpdatedDoc = {
                id: 1,
                name: "document.pdf",
                updated_at: "2026-04-15",
            };
            const mockRevisions = [
                {
                    id: 2,
                    document_id: 1,
                    filename: "document_v2.pdf",
                    version: 2,
                },
                { id: 1, document_id: 1, filename: "document.pdf", version: 1 },
            ];

            const db = Object.assign(jest.fn(), {
                fn: { now: jest.fn(() => "CURRENT_TIMESTAMP") },
            });

            const docWhereFirst = {
                where: () => ({ first: () => thenable(mockDoc) }),
            };
            const revWhereOrderFirst = {
                select: () => ({
                    where: () => ({
                        orderBy: () => ({
                            first: () => thenable(mockLatestRevision),
                        }),
                    }),
                }),
            };
            const revInsert = { insert: () => thenable(undefined) };
            const docUpdate = {
                where: () => ({ update: () => thenable(undefined) }),
            };
            const docWhereFirstUpdated = {
                where: () => ({ first: () => thenable(mockUpdatedDoc) }),
            };
            const revWhereOrder = {
                where: () => ({ orderBy: () => thenable(mockRevisions) }),
            };

            db.mockReturnValueOnce(docWhereFirst)
                .mockReturnValueOnce(revWhereOrderFirst)
                .mockReturnValueOnce(revInsert)
                .mockReturnValueOnce(docUpdate)
                .mockReturnValueOnce(docWhereFirstUpdated)
                .mockReturnValueOnce(revWhereOrder);

            (getDb as jest.Mock).mockResolvedValue(db);

            await reviseFile(mockRequest as Request, mockResponse as Response);

            expect(fs.writeFileSync).toHaveBeenCalled();
            expect(fs.unlinkSync).toHaveBeenCalledWith("temp/path");
            expect(notifyQueueUpdate).toHaveBeenCalledWith({
                ...mockUpdatedDoc,
                revisions: mockRevisions,
            });
            expect(mockJson).toHaveBeenCalledWith({
                ...mockUpdatedDoc,
                revisions: mockRevisions,
            });
        });

        it("should return 400 if no file is uploaded", async () => {
            mockRequest = { params: { id: "1" }, body: {} };

            await reviseFile(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({
                error: "No file uploaded",
            });
        });

        it("should return 404 if document not found", async () => {
            mockRequest = {
                params: { id: "1" },
                body: {},
                file: { path: "temp/path" } as any,
            };
            const db = Object.assign(jest.fn(), {
                fn: { now: jest.fn() },
            });
            db.mockReturnValue({
                where: () => ({ first: () => thenable(null) }),
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await reviseFile(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(mockJson).toHaveBeenCalledWith({
                error: "Document not found",
            });
        });
    });

    describe("exportPdfa", () => {
        it("should convert the latest revision via Ghostscript and return its path", async () => {
            mockRequest = { params: { id: "1" } };
            const mockDoc = { id: 1, name: "document.pdf" };
            const mockLatestRevision = { filename: "document_v2.pdf" };

            const db = Object.assign(jest.fn(), {});
            const docWhereFirst = {
                where: () => ({ first: () => thenable(mockDoc) }),
            };
            const revWhereOrderFirst = {
                select: () => ({
                    where: () => ({
                        orderBy: () => ({
                            first: () => thenable(mockLatestRevision),
                        }),
                    }),
                }),
            };
            db.mockReturnValueOnce(docWhereFirst).mockReturnValueOnce(
                revWhereOrderFirst,
            );
            (getDb as jest.Mock).mockResolvedValue(db);
            (convertToPdfA as jest.Mock).mockResolvedValue(undefined);

            await exportPdfa(mockRequest as Request, mockResponse as Response);

            expect(convertToPdfA).toHaveBeenCalledWith(
                expect.stringContaining("document_v2.pdf"),
                expect.stringContaining("document_v2_pdfa.pdf"),
                { title: "document.pdf" },
            );
            expect(mockJson).toHaveBeenCalledWith(
                expect.objectContaining({
                    message: "Exported to PDF/A successfully",
                    filename: "document_v2_pdfa.pdf",
                }),
            );
        });

        it("should return 404 if there are no revisions for the document", async () => {
            mockRequest = { params: { id: "1" } };
            const db = Object.assign(jest.fn(), {});
            const docWhereFirst = {
                where: () => ({
                    first: () => thenable({ id: 1, name: "doc.pdf" }),
                }),
            };
            const revWhereOrderFirst = {
                select: () => ({
                    where: () => ({
                        orderBy: () => ({ first: () => thenable(null) }),
                    }),
                }),
            };
            db.mockReturnValueOnce(docWhereFirst).mockReturnValueOnce(
                revWhereOrderFirst,
            );
            (getDb as jest.Mock).mockResolvedValue(db);

            await exportPdfa(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(convertToPdfA).not.toHaveBeenCalled();
        });

        it("should return 404 if the source file is missing on disk", async () => {
            mockRequest = { params: { id: "1" } };
            const db = Object.assign(jest.fn(), {});
            const docWhereFirst = {
                where: () => ({
                    first: () => thenable({ id: 1, name: "doc.pdf" }),
                }),
            };
            const revWhereOrderFirst = {
                select: () => ({
                    where: () => ({
                        orderBy: () => ({
                            first: () => thenable({ filename: "doc.pdf" }),
                        }),
                    }),
                }),
            };
            db.mockReturnValueOnce(docWhereFirst).mockReturnValueOnce(
                revWhereOrderFirst,
            );
            (getDb as jest.Mock).mockResolvedValue(db);
            (fs.existsSync as jest.Mock).mockReturnValueOnce(false);

            await exportPdfa(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
            expect(convertToPdfA).not.toHaveBeenCalled();
        });

        it("should return 502 if Ghostscript conversion fails", async () => {
            mockRequest = { params: { id: "1" } };
            const db = Object.assign(jest.fn(), {});
            const docWhereFirst = {
                where: () => ({
                    first: () => thenable({ id: 1, name: "doc.pdf" }),
                }),
            };
            const revWhereOrderFirst = {
                select: () => ({
                    where: () => ({
                        orderBy: () => ({
                            first: () => thenable({ filename: "doc.pdf" }),
                        }),
                    }),
                }),
            };
            db.mockReturnValueOnce(docWhereFirst).mockReturnValueOnce(
                revWhereOrderFirst,
            );
            (getDb as jest.Mock).mockResolvedValue(db);
            (convertToPdfA as jest.Mock).mockRejectedValue(
                new PdfaConversionError("gs blew up"),
            );

            await exportPdfa(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(502);
            expect(mockJson).toHaveBeenCalledWith({ error: "gs blew up" });
        });
    });
});
