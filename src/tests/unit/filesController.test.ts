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

import { getDocumentsOverview, exportPdfa } from "../../controllers/filesController";
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

    describe("getDocumentsOverview", () => {
        // Chain resolves at .orderBy(), matching how the real query is
        // awaited in the controller (`await query.orderBy(...)`).
        function chainable(resolveValue: any) {
            const chain: any = {};
            for (const m of [
                "leftJoin",
                "whereNull",
                "where",
                "whereIn",
                "select",
                "max",
                "groupBy",
            ]) {
                chain[m] = jest.fn().mockReturnValue(chain);
            }
            chain.as = jest.fn().mockReturnValue("subquery");
            chain.orderBy = jest.fn().mockResolvedValue(resolveValue);
            return chain;
        }

        it("should return non-archived documents with latest status and revisioned flag", async () => {
            mockRequest = { query: {} };

            const mockDocRows = [
                {
                    document_id: 1,
                    document_name: "doc1.pdf",
                    project_number: "P1",
                    position: "10",
                    document_type: 14,
                    created_at: "2026-07-17T10:00:00Z",
                    updated_at: "2026-07-17T10:00:00Z",
                    latest_status: "complete",
                },
                {
                    document_id: 2,
                    document_name: "doc2.pdf",
                    project_number: "P2",
                    position: "20",
                    document_type: 4,
                    created_at: "2026-07-17T12:00:00Z",
                    updated_at: "2026-07-17T12:00:00Z",
                    latest_status: null,
                },
            ];
            // Pre-sorted version desc, matching the real ORDER BY version desc clause.
            const mockRevisionRows = [
                {
                    id: 11,
                    document_id: 1,
                    filename: "doc1_Rev1.pdf",
                    version: 2,
                    annotations: null,
                    created_at: "2026-07-17T11:00:00Z",
                },
                {
                    id: 10,
                    document_id: 1,
                    filename: "docmgr://P1/10/14",
                    version: 1,
                    annotations: null,
                    created_at: "2026-07-17T10:30:00Z",
                },
            ];

            const db = jest.fn((table: string) => {
                if (table === "documents as d") return chainable(mockDocRows);
                if (table === "revisions") return chainable(mockRevisionRows);
                return chainable([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockJson).toHaveBeenCalledWith({
                items: [
                    {
                        document_id: 1,
                        document_name: "doc1.pdf",
                        project_number: "P1",
                        position: "10",
                        document_type: 14,
                        created_at: "2026-07-17T10:00:00Z",
                        updated_at: "2026-07-17T10:00:00Z",
                        status: "complete",
                        revisioned: true,
                        revisions: [
                            {
                                id: 11,
                                filename: "doc1_Rev1.pdf",
                                version: 2,
                                created_at: "2026-07-17T11:00:00Z",
                                has_annotations: false,
                                is_edited: true,
                            },
                            {
                                id: 10,
                                filename: "docmgr://P1/10/14",
                                version: 1,
                                created_at: "2026-07-17T10:30:00Z",
                                has_annotations: false,
                                is_edited: false,
                            },
                        ],
                    },
                    {
                        document_id: 2,
                        document_name: "doc2.pdf",
                        project_number: "P2",
                        position: "20",
                        document_type: 4,
                        created_at: "2026-07-17T12:00:00Z",
                        updated_at: "2026-07-17T12:00:00Z",
                        status: null,
                        revisioned: false,
                        revisions: [],
                    },
                ],
            });
        });

        it("should return empty items when nothing matches", async () => {
            mockRequest = { query: {} };
            const db = jest.fn(() => chainable([]));
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(mockJson).toHaveBeenCalledWith({ items: [] });
        });

        it("should filter to only revisioned documents when revisioned=true", async () => {
            mockRequest = { query: { revisioned: "true" } };

            const mockDocRows = [
                {
                    document_id: 1,
                    document_name: "doc1.pdf",
                    project_number: "P1",
                    position: "10",
                    document_type: 14,
                    created_at: "t",
                    updated_at: "t",
                    latest_status: null,
                },
                {
                    document_id: 2,
                    document_name: "doc2.pdf",
                    project_number: "P2",
                    position: "20",
                    document_type: 4,
                    created_at: "t",
                    updated_at: "t",
                    latest_status: null,
                },
            ];
            // Only document 1 has a real (non-docmgr://) edited revision.
            const mockRevisionRows = [
                {
                    id: 10,
                    document_id: 1,
                    filename: "doc1_Rev1.pdf",
                    version: 1,
                    annotations: null,
                    created_at: "t",
                },
                {
                    id: 20,
                    document_id: 2,
                    filename: "docmgr://P2/20/4",
                    version: 1,
                    annotations: null,
                    created_at: "t",
                },
            ];

            const db = jest.fn((table: string) => {
                if (table === "documents as d") return chainable(mockDocRows);
                if (table === "revisions") return chainable(mockRevisionRows);
                return chainable([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(
                mockRequest as Request,
                mockResponse as Response,
            );

            const result = mockJson.mock.calls[0][0];
            expect(result.items).toHaveLength(1);
            expect(result.items[0].document_id).toBe(1);
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
