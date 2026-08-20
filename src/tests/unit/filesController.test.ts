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

import {
    getDocumentsOverview,
    exportPdfa,
} from "../../controllers/filesController";
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
        // Chain resolves whenever awaited — matching real knex query
        // builders, which are thenable at any point in the chain (not just
        // after one specific terminal method). Different queries in the
        // controller terminate the chain at different points (.orderBy()
        // for the main overview query, .groupBy() for the check-status
        // aggregates), so this needs to work regardless of which method
        // was called last.
        function chainable(resolveValue: any) {
            const chain: any = {};
            for (const m of [
                "leftJoin",
                "whereNull",
                "whereNotNull",
                "where",
                "whereIn",
                "select",
                "max",
                "countDistinct",
                "groupBy",
            ]) {
                chain[m] = jest.fn().mockReturnValue(chain);
            }
            chain.as = jest.fn().mockReturnValue("subquery");
            chain.orderBy = jest.fn().mockResolvedValue(resolveValue);
            chain.then = (resolve: any) => resolve(resolveValue);
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
                    // Not null — the query's whereNotNull("ocl.status")
                    // means a real result row here always has a status;
                    // see the two tests below for that filtering itself.
                    latest_status: "missing_product",
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
                        // No order_cycle_checks/order_completion_log/
                        // order_preparation_log/ptl_prep_queue rows in this
                        // mock -> getCheckStatusForPositions falls back to
                        // its defaults (1 cycle, none checked).
                        checked: false,
                        checked_cycles: 0,
                        total_cycles: 1,
                        unchecked_cycles: [1],
                    },
                    {
                        document_id: 2,
                        document_name: "doc2.pdf",
                        project_number: "P2",
                        position: "20",
                        document_type: 4,
                        created_at: "2026-07-17T12:00:00Z",
                        updated_at: "2026-07-17T12:00:00Z",
                        status: "missing_product",
                        revisioned: false,
                        revisions: [],
                        checked: false,
                        checked_cycles: 0,
                        total_cycles: 1,
                        unchecked_cycles: [1],
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

        it("always excludes documents with no completion status recorded, even with no status filter applied", async () => {
            mockRequest = { query: {} };

            let capturedWhereNotNullArg: string | undefined;
            const db = jest.fn((table: string) => {
                if (table === "documents as d") {
                    const chain = chainable([]);
                    // Wrap whereNotNull to capture what it was called with,
                    // while still behaving like the rest of the chain.
                    const original = chain.whereNotNull;
                    chain.whereNotNull = jest.fn((arg: string) => {
                        capturedWhereNotNullArg = arg;
                        return original(arg);
                    });
                    return chain;
                }
                return chainable([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(capturedWhereNotNullArg).toBe("ocl.status");
        });

        it("filters by status via whereIn when a status query param is given", async () => {
            mockRequest = {
                query: { status: "complete,complete_with_changes" },
            };

            let capturedWhereInArgs: [string, string[]] | undefined;
            const db = jest.fn((table: string) => {
                if (table === "documents as d") {
                    const chain = chainable([]);
                    const original = chain.whereIn;
                    chain.whereIn = jest.fn(
                        (column: string, values: string[]) => {
                            capturedWhereInArgs = [column, values];
                            return original(column, values);
                        },
                    );
                    return chain;
                }
                return chainable([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(
                mockRequest as Request,
                mockResponse as Response,
            );

            expect(capturedWhereInArgs).toEqual([
                "ocl.status",
                ["complete", "complete_with_changes"],
            ]);
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

        it("should compute checked/checked_cycles/total_cycles from order_cycle_checks, preferring order_completion_log for total_cycles", async () => {
            mockRequest = { query: {} };

            const mockDocRows = [
                {
                    document_id: 1,
                    document_name: "doc1.pdf",
                    project_number: "P1",
                    position: "10",
                    document_type: 14,
                    created_at: "t",
                    updated_at: "t",
                    latest_status: "complete",
                },
            ];

            const db = jest.fn((table: string) => {
                if (table === "documents as d") return chainable(mockDocRows);
                if (table === "revisions") return chainable([]);
                if (table === "order_completion_log") {
                    // Real P2L cycle data says this position has 3 cycles —
                    // takes priority over order_preparation_log/ptl_prep_queue.
                    return chainable([
                        {
                            project_number: "P1",
                            position: "10",
                            max_total_cycles: 3,
                        },
                    ]);
                }
                if (table === "order_preparation_log") {
                    return chainable([
                        {
                            project_number: "P1",
                            position: "10",
                            max_total_cycles: 1,
                        },
                    ]);
                }
                if (table === "order_cycle_checks") {
                    // Only 2 of the 3 cycles have an "ok" check on record —
                    // now returning raw rows (query fetches everything and
                    // groups/reduces to "latest per cycle" in JS).
                    return chainable([
                        {
                            project_number: "P1",
                            position: "10",
                            cycle_index: 1,
                            status: "ok",
                            employee_name: "Jan Novak",
                            note: null,
                            created_at: "2026-07-17T09:00:00Z",
                        },
                        {
                            project_number: "P1",
                            position: "10",
                            cycle_index: 2,
                            status: "ok",
                            employee_name: "Jan Novak",
                            note: null,
                            created_at: "2026-07-17T09:05:00Z",
                        },
                    ]);
                }
                return chainable([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(
                mockRequest as Request,
                mockResponse as Response,
            );

            const result = mockJson.mock.calls[0][0];
            expect(result.items[0]).toMatchObject({
                total_cycles: 3,
                checked_cycles: 2,
                checked: false, // 2 of 3 checked -> not fully checked yet
                unchecked_cycles: [3],
            });
        });

        it("should filter to only unchecked documents when unchecked=true", async () => {
            mockRequest = { query: { unchecked: "true" } };

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

            const db = jest.fn((table: string) => {
                if (table === "documents as d") return chainable(mockDocRows);
                if (table === "revisions") return chainable([]);
                if (table === "order_cycle_checks") {
                    // P1/10 fully checked (1/1 default cycle); P2/20 not checked at all.
                    return chainable([
                        {
                            project_number: "P1",
                            position: "10",
                            cycle_index: 1,
                            status: "ok",
                            employee_name: "Jan Novak",
                            note: null,
                            created_at: "2026-07-17T09:00:00Z",
                        },
                    ]);
                }
                return chainable([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(
                mockRequest as Request,
                mockResponse as Response,
            );

            const result = mockJson.mock.calls[0][0];
            expect(result.items).toHaveLength(1);
            expect(result.items[0].document_id).toBe(2);
            expect(result.items[0].checked).toBe(false);
        });

        it("does not count a cycle as checked if its latest row is 'issue', even if an older row was 'ok'", async () => {
            mockRequest = { query: {} };

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
            ];

            const db = jest.fn((table: string) => {
                if (table === "documents as d") return chainable(mockDocRows);
                if (table === "revisions") return chainable([]);
                if (table === "order_cycle_checks") {
                    // Rows are returned newest-first (matches the real
                    // .orderBy("created_at", "desc")) — the later "issue"
                    // row for cycle 1 must win over the earlier "ok" one.
                    return chainable([
                        {
                            project_number: "P1",
                            position: "10",
                            cycle_index: 1,
                            status: "issue",
                            employee_name: "Petr Svoboda",
                            note: "Missing bracket",
                            created_at: "2026-07-17T10:00:00Z",
                        },
                        {
                            project_number: "P1",
                            position: "10",
                            cycle_index: 1,
                            status: "ok",
                            employee_name: "Jan Novak",
                            note: null,
                            created_at: "2026-07-17T09:00:00Z",
                        },
                    ]);
                }
                return chainable([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(
                mockRequest as Request,
                mockResponse as Response,
            );

            const result = mockJson.mock.calls[0][0];
            expect(result.items[0]).toMatchObject({
                checked: false,
                checked_cycles: 0,
                unchecked_cycles: [1],
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
