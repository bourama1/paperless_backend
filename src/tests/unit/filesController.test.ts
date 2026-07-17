jest.mock("../../config/database");
jest.mock("../../services/notificationService");

jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return {
        ...actual,
        readFileSync: jest.fn((...args: any[]) =>
            (actual as any).readFileSync(...args),
        ),
        existsSync: jest.fn(() => true),
    };
});

jest.mock("../../services/pdfaService", () => ({
    convertToPdfA: jest.fn(),
    PdfaConversionError: class PdfaConversionError extends Error {},
}));

import { getRevisionsByDate, exportPdfa } from "../../controllers/filesController";
import { getDb } from "../../config/database";
import { Request, Response } from "express";
import fs from "fs";
import { convertToPdfA, PdfaConversionError } from "../../services/pdfaService";
import { thenable } from "../helpers/thenable";

describe("Files Controller", () => {
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;
    let mockJson: jest.Mock;
    let mockStatus: jest.Mock;

    beforeEach(() => {
        mockJson = jest.fn();
        mockStatus = jest.fn().mockReturnValue({ json: mockJson });
        mockResponse = { json: mockJson, status: mockStatus };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe("getRevisionsByDate", () => {
        function chainable(resolveValue: any) {
            const chain: any = jest.fn();
            chain.mockReturnValue(chain);
            chain.join = jest.fn().mockReturnValue(chain);
            chain.whereRaw = jest.fn().mockReturnValue(chain);
            chain.where = jest.fn().mockReturnValue(chain);
            chain.orderBy = jest.fn().mockReturnValue(chain);
            chain.select = jest.fn().mockResolvedValue(resolveValue);
            return chain;
        }

        it("should return revisions grouped by document for a given date", async () => {
            mockRequest = { query: { date: "2026-07-17" } };
            const mockRows = [
                {
                    document_id: 1,
                    document_name: "doc1.pdf",
                    updated_at: "2026-07-17T10:00:00Z",
                    id: 10,
                    filename: "doc1_Rev2.pdf",
                    version: 2,
                    annotations: null,
                    created_at: "2026-07-17T10:30:00Z",
                },
                {
                    document_id: 1,
                    document_name: "doc1.pdf",
                    updated_at: "2026-07-17T10:00:00Z",
                    id: 11,
                    filename: "doc1_Rev3.pdf",
                    version: 3,
                    annotations: '{"paths":[]}',
                    created_at: "2026-07-17T11:00:00Z",
                },
                {
                    document_id: 2,
                    document_name: "doc2.pdf",
                    updated_at: "2026-07-17T12:00:00Z",
                    id: 12,
                    filename: "doc2_Rev1.pdf",
                    version: 1,
                    annotations: null,
                    created_at: "2026-07-17T12:30:00Z",
                },
            ];

            const db = chainable(mockRows);
            (getDb as jest.Mock).mockResolvedValue(db);

            await getRevisionsByDate(mockRequest as Request, mockResponse as Response);

            expect(mockJson).toHaveBeenCalledWith({
                date: "2026-07-17",
                items: [
                    {
                        document_id: 1,
                        document_name: "doc1.pdf",
                        updated_at: "2026-07-17T10:00:00Z",
                        revisions: [
                            { id: 10, filename: "doc1_Rev2.pdf", version: 2, created_at: "2026-07-17T10:30:00Z", has_annotations: false },
                            { id: 11, filename: "doc1_Rev3.pdf", version: 3, created_at: "2026-07-17T11:00:00Z", has_annotations: true },
                        ],
                    },
                    {
                        document_id: 2,
                        document_name: "doc2.pdf",
                        updated_at: "2026-07-17T12:00:00Z",
                        revisions: [
                            { id: 12, filename: "doc2_Rev1.pdf", version: 1, created_at: "2026-07-17T12:30:00Z", has_annotations: false },
                        ],
                    },
                ],
            });
        });

        it("should default to today when no date is provided", async () => {
            mockRequest = { query: {} };

            const db = chainable([]);
            (getDb as jest.Mock).mockResolvedValue(db);

            await getRevisionsByDate(mockRequest as Request, mockResponse as Response);

            const today = new Date().toISOString().slice(0, 10);
            expect(mockJson).toHaveBeenCalledWith({ date: today, items: [] });
        });

        it("should return empty items when no revisions match", async () => {
            mockRequest = { query: { date: "2020-01-01" } };

            const db = chainable([]);
            (getDb as jest.Mock).mockResolvedValue(db);

            await getRevisionsByDate(mockRequest as Request, mockResponse as Response);

            expect(mockJson).toHaveBeenCalledWith({ date: "2020-01-01", items: [] });
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
