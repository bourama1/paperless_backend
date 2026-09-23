jest.mock("../../config/database");
jest.mock("../../services/notificationService");
jest.mock("../../services/qcRequirementService", () => ({
    getQcRequiredForPositions: jest.fn().mockResolvedValue(new Map()),
}));

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
    getDocumentById,
    exportPdfa,
} from "../../controllers/filesController";
import { getDb } from "../../config/database";
import { Request, Response } from "express";
import fs from "fs";
import { convertToPdfA, PdfaConversionError } from "../../services/pdfaService";
import { thenable } from "../helpers/thenable";
import { getQcRequiredForPositions } from "../../services/qcRequirementService";

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
                "join",
                "leftJoin",
                "whereNull",
                "whereNotNull",
                "whereNotExists",
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

            // ocl-driven rows only — document_id/name/type no longer come
            // from this query (see the separate "documents" fetch below).
            const mockOclRows = [
                {
                    project_number: "P1",
                    position: "10",
                    workstation: "Hardware",
                    sales_order: "SO1",
                    latest_status: "complete",
                    // The kiosk completion time — distinct from the
                    // document's own created_at, which only reflects
                    // whenever it happened to be opened/imported in-app.
                    completed_at: "2026-07-17T09:55:00Z",
                },
                {
                    project_number: "P2",
                    position: "20",
                    workstation: "Hardware",
                    sales_order: "SO2",
                    // Every row always has a status now — the query joins
                    // order_completion_log with an inner join, so it's
                    // structurally guaranteed, not filtered at runtime.
                    latest_status: "missing_product",
                    completed_at: "2026-07-17T11:58:00Z",
                },
            ];
            // The "documents" table's own rows — matched to an ocl row by
            // project_number+position+document_type, where document_type
            // is resolvePbomTypeForWorkplace(ocl.workstation) (14 = PBOM_HARDWARE
            // for "Hardware", per config/documentTypes.ts's real mapping).
            const mockDocumentRows = [
                {
                    id: 1,
                    name: "doc1.pdf",
                    project_number: "P1",
                    position: "10",
                    document_type: 14,
                    created_at: "2026-07-17T10:00:00Z",
                    updated_at: "2026-07-17T10:00:00Z",
                },
                {
                    id: 2,
                    name: "doc2.pdf",
                    project_number: "P2",
                    position: "20",
                    document_type: 14,
                    created_at: "2026-07-17T12:00:00Z",
                    updated_at: "2026-07-17T12:00:00Z",
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

            const db = jest.fn((table: any) => {
                if (table === "subquery") return chainable(mockOclRows);
                if (table === "documents") return chainable(mockDocumentRows);
                if (table === "revisions") return chainable(mockRevisionRows);
                // Real production order_completion_log rows behind the
                // joined "subquery" mock above — a position only appears
                // in the overview at all because of a row like this, so a
                // real run always has one; supplied here too so the
                // check-status lookup sees cycle 1 as actually finished.
                if (table === "order_completion_log") {
                    return chainable([
                        { project_number: "P1", position: "10", workstation: "Hardware", cycle_index: 1, max_total_cycles: 1 },
                        { project_number: "P2", position: "20", workstation: "Hardware", cycle_index: 1, max_total_cycles: 1 },
                    ]);
                }
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
                        workstation: "Hardware",
                        document_type: 14,
                        created_at: "2026-07-17T10:00:00Z",
                        updated_at: "2026-07-17T10:00:00Z",
                        completed_at: "2026-07-17T09:55:00Z",
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
                        sales_order: "SO1",
                        checked: false,
                        checked_cycles: 0,
                        total_cycles: 1,
                        unchecked_cycles: [1],
                        qc_required: null,
                        qc_checked: false,
                        qc_checked_cycles: 0,
                    },
                    {
                        document_id: 2,
                        document_name: "doc2.pdf",
                        project_number: "P2",
                        position: "20",
                        workstation: "Hardware",
                        document_type: 14,
                        created_at: "2026-07-17T12:00:00Z",
                        updated_at: "2026-07-17T12:00:00Z",
                        completed_at: "2026-07-17T11:58:00Z",
                        sales_order: "SO2",
                        status: "missing_product",
                        revisioned: false,
                        revisions: [],
                        checked: false,
                        checked_cycles: 0,
                        total_cycles: 1,
                        unchecked_cycles: [1],
                        qc_required: null,
                        qc_checked: false,
                        qc_checked_cycles: 0,
                    },
                ],
            });
        });

        it("includes an order that reached a kiosk finishing state even when its BOM was never opened/imported in-app (no documents row)", async () => {
            mockRequest = { query: {} };

            // No matching row in "documents" at all for this project/position.
            const mockOclRows = [
                {
                    project_number: "P3",
                    position: "30",
                    workstation: "Motor",
                    latest_status: "complete",
                    completed_at: "2026-09-16T11:46:28.220Z",
                },
            ];

            const db = jest.fn((table: any) => {
                if (table === "subquery") return chainable(mockOclRows);
                return chainable([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(
                mockRequest as Request,
                mockResponse as Response,
            );

            const result = mockJson.mock.calls[0][0];
            expect(result.items).toHaveLength(1);
            expect(result.items[0]).toMatchObject({
                document_id: null,
                document_name: null,
                project_number: "P3",
                position: "30",
                workstation: "Motor",
                status: "complete",
                completed_at: "2026-09-16T11:46:28.220Z",
                revisioned: false,
                revisions: [],
            });
        });

        it("keeps a Hardware completion and a Motor completion for the same project/position as two separate items", async () => {
            mockRequest = { query: {} };

            const mockOclRows = [
                {
                    project_number: "P1",
                    position: "10",
                    workstation: "Hardware",
                    latest_status: "complete",
                    completed_at: "2026-09-17T09:00:00Z",
                },
                {
                    project_number: "P1",
                    position: "10",
                    workstation: "Motor",
                    latest_status: "complete",
                    completed_at: "2026-09-17T10:00:00Z",
                },
            ];
            // 14 = PBOM_HARDWARE, 15 = PBOM_MOTOR — each completion must
            // pick up only its OWN document, never the other's.
            const mockDocumentRows = [
                { id: 1, name: "hardware.pdf", project_number: "P1", position: "10", document_type: 14 },
                { id: 2, name: "motor.pdf", project_number: "P1", position: "10", document_type: 15 },
            ];

            const db = jest.fn((table: any) => {
                if (table === "subquery") return chainable(mockOclRows);
                if (table === "documents") return chainable(mockDocumentRows);
                return chainable([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(
                mockRequest as Request,
                mockResponse as Response,
            );

            const result = mockJson.mock.calls[0][0];
            expect(result.items).toHaveLength(2);
            const byWorkstation = Object.fromEntries(
                result.items.map((i: any) => [i.workstation, i]),
            );
            expect(byWorkstation.Hardware).toMatchObject({ document_id: 1, document_name: "hardware.pdf" });
            expect(byWorkstation.Motor).toMatchObject({ document_id: 2, document_name: "motor.pdf" });
        });

        it("keeps Hardware's and Motor's cycle checks independent for the same position — checking Hardware's cycle 1 must not check Motor's cycle 1 too", async () => {
            mockRequest = { query: {} };

            const mockOclRows = [
                { project_number: "P1", position: "10", workstation: "Hardware", latest_status: "complete" },
                { project_number: "P1", position: "10", workstation: "Motor", latest_status: "complete" },
            ];

            const db = jest.fn((table: string) => {
                if (table === "subquery") return chainable(mockOclRows);
                if (table === "order_cycle_checks") {
                    // Only Hardware's cycle 1 was ever checked — Motor's
                    // own cycle 1 has no row at all.
                    return chainable([
                        {
                            project_number: "P1",
                            position: "10",
                            workstation: "Hardware",
                            cycle_index: 1,
                            status: "ok",
                            employee_name: "Jan Novak",
                            note: null,
                            created_at: "2026-09-18T09:00:00Z",
                        },
                    ]);
                }
                // Both workstations' cycle 1 actually finished (that's why
                // each has an "complete" row in mockOclRows above) — Motor's
                // is still uncheck*able*, just unchecked.
                if (table === "order_completion_log") {
                    return chainable([
                        { project_number: "P1", position: "10", workstation: "Hardware", cycle_index: 1 },
                        { project_number: "P1", position: "10", workstation: "Motor", cycle_index: 1 },
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
            const byWorkstation = Object.fromEntries(result.items.map((i: any) => [i.workstation, i]));
            expect(byWorkstation.Hardware).toMatchObject({ checked: true, checked_cycles: 1 });
            expect(byWorkstation.Motor).toMatchObject({ checked: false, checked_cycles: 0 });
        });

        it("still honors a check recorded before the workstation column existed (NULL), for whichever workstation asks", async () => {
            mockRequest = { query: {} };

            const mockOclRows = [
                { project_number: "P1", position: "10", workstation: "Hardware", latest_status: "complete" },
            ];

            const db = jest.fn((table: string) => {
                if (table === "subquery") return chainable(mockOclRows);
                if (table === "order_cycle_checks") {
                    return chainable([
                        {
                            project_number: "P1",
                            position: "10",
                            workstation: null,
                            cycle_index: 1,
                            status: "ok",
                            employee_name: "Jan Novak",
                            note: null,
                            created_at: "2026-01-01T09:00:00Z",
                        },
                    ]);
                }
                if (table === "order_completion_log") {
                    return chainable([
                        { project_number: "P1", position: "10", workstation: "Hardware", cycle_index: 1 },
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
            expect(result.items[0]).toMatchObject({ checked: true, checked_cycles: 1 });
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

        it("filters by status via whereIn when a status query param is given", async () => {
            mockRequest = {
                query: { status: "complete,complete_with_changes" },
            };

            let capturedWhereInArgs: [string, string[]] | undefined;
            const db = jest.fn((table: any) => {
                if (table === "subquery") {
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

            const mockOclRows = [
                { project_number: "P1", position: "10", workstation: "Hardware", latest_status: null },
                { project_number: "P2", position: "20", workstation: "Hardware", latest_status: null },
            ];
            const mockDocumentRows = [
                { id: 1, name: "doc1.pdf", project_number: "P1", position: "10", document_type: 14 },
                { id: 2, name: "doc2.pdf", project_number: "P2", position: "20", document_type: 14 },
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
                if (table === "subquery") return chainable(mockOclRows);
                if (table === "documents") return chainable(mockDocumentRows);
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

            const mockOclRows = [
                { project_number: "P1", position: "10", workstation: "Hardware", latest_status: "complete" },
            ];

            const db = jest.fn((table: string) => {
                if (table === "subquery") return chainable(mockOclRows);
                if (table === "revisions") return chainable([]);
                if (table === "order_completion_log") {
                    // Real P2L cycle data says this position has 3 cycles —
                    // takes priority over order_preparation_log/ptl_prep_queue.
                    // All 3 cycles have actually finished (one row each), so
                    // all 3 are checkable, not just however many have a
                    // check on record.
                    return chainable(
                        [1, 2, 3].map((cycle_index) => ({
                            project_number: "P1",
                            position: "10",
                            workstation: "Hardware",
                            cycle_index,
                            max_total_cycles: 3,
                        })),
                    );
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
                            workstation: "Hardware",
                            cycle_index: 1,
                            status: "ok",
                            employee_name: "Jan Novak",
                            note: null,
                            created_at: "2026-07-17T09:00:00Z",
                        },
                        {
                            project_number: "P1",
                            position: "10",
                            workstation: "Hardware",
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

            const mockOclRows = [
                { project_number: "P1", position: "10", workstation: "Hardware", latest_status: null },
                { project_number: "P2", position: "20", workstation: "Hardware", latest_status: null },
            ];
            const mockDocumentRows = [
                { id: 1, name: "doc1.pdf", project_number: "P1", position: "10", document_type: 14 },
                { id: 2, name: "doc2.pdf", project_number: "P2", position: "20", document_type: 14 },
            ];

            const db = jest.fn((table: string) => {
                if (table === "subquery") return chainable(mockOclRows);
                if (table === "documents") return chainable(mockDocumentRows);
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
                // Only P1's cycle 1 has actually finished — P2's hasn't
                // (still "not checked at all" below, just for a different
                // reason: nothing to check yet rather than an unchecked box).
                if (table === "order_completion_log") {
                    return chainable([
                        { project_number: "P1", position: "10", workstation: "Hardware", cycle_index: 1 },
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

            const mockOclRows = [
                { project_number: "P1", position: "10", workstation: "Hardware", latest_status: null },
            ];

            const db = jest.fn((table: string) => {
                if (table === "subquery") return chainable(mockOclRows);
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
                if (table === "order_completion_log") {
                    return chainable([
                        { project_number: "P1", position: "10", workstation: "Hardware", cycle_index: 1 },
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

        it("only offers cycles that have actually finished as checkable, not every cycle up to total_cycles", async () => {
            mockRequest = { query: {} };

            const mockOclRows = [
                { project_number: "P1", position: "10", workstation: "Hardware", latest_status: null },
            ];

            const db = jest.fn((table: string) => {
                if (table === "subquery") return chainable(mockOclRows);
                if (table === "revisions") return chainable([]);
                // The order has 4 doors total, but only doors 1 and 2 have
                // actually finished at the workstation so far.
                if (table === "order_completion_log") {
                    return chainable(
                        [1, 2].map((cycle_index) => ({
                            project_number: "P1",
                            position: "10",
                            workstation: "Hardware",
                            cycle_index,
                            max_total_cycles: 4,
                        })),
                    );
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
                total_cycles: 4,
                checked_cycles: 0,
                // Cycles 3 and 4 haven't finished yet — they must not show
                // up as needing a check.
                unchecked_cycles: [1, 2],
            });
        });

        it("qc=true keeps only QC-required positions without a full QC sign-off yet", async () => {
            mockRequest = { query: { qc: "true" } };

            // P1: QC required, not signed off -> kept. P2: QC required and
            // signed off by a quality engineer -> dropped. P3: no QC needed
            // -> dropped. P4: not resolved yet (absent from the map) ->
            // dropped. P1's STANDARD check doesn't count toward QC.
            const mockOclRows = ["P1", "P2", "P3", "P4"].map((pn) => ({
                project_number: pn,
                position: "10",
                workstation: "Hardware",
                sales_order: `SO-${pn}`,
                latest_status: "complete",
            }));
            (getQcRequiredForPositions as jest.Mock).mockResolvedValueOnce(
                new Map([
                    ["P1||10", true],
                    ["P2||10", true],
                    ["P3||10", false],
                ]),
            );

            const db = jest.fn((table: string) => {
                if (table === "subquery") return chainable(mockOclRows);
                if (table === "order_completion_log") {
                    return chainable(
                        ["P1", "P2", "P3", "P4"].map((pn) => ({
                            project_number: pn,
                            position: "10",
                            workstation: "Hardware",
                            cycle_index: 1,
                            max_total_cycles: 1,
                        })),
                    );
                }
                if (table === "order_cycle_checks") {
                    return chainable([
                        {
                            project_number: "P1",
                            position: "10",
                            workstation: "Hardware",
                            cycle_index: 1,
                            status: "ok",
                            created_at: "2026-09-23T09:00:00Z",
                        },
                    ]);
                }
                if (table === "order_qc_checks") {
                    return chainable([
                        {
                            project_number: "P2",
                            position: "10",
                            workstation: "Hardware",
                            cycle_index: 1,
                            status: "ok",
                            engineer_name: "Eva Kvalitní",
                            created_at: "2026-09-23T10:00:00Z",
                        },
                    ]);
                }
                return chainable([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentsOverview(mockRequest as Request, mockResponse as Response);

            const result = mockJson.mock.calls[0][0];
            expect(result.items.map((i: any) => i.project_number)).toEqual(["P1"]);
            expect(result.items[0]).toMatchObject({
                qc_required: true,
                checked: true, // standard check done...
                qc_checked: false, // ...but the QC sign-off isn't
            });
        });
    });

    describe("getDocumentById", () => {
        function chain(resolveValue: any) {
            const c: any = {};
            for (const m of ["where", "whereIn", "whereNot", "select", "max", "groupBy", "orderBy"]) {
                c[m] = jest.fn().mockReturnValue(c);
            }
            c.first = jest.fn().mockResolvedValue(Array.isArray(resolveValue) ? (resolveValue[0] ?? null) : resolveValue);
            c.then = (resolve: any) => resolve(resolveValue);
            return c;
        }

        it("picks the completion matching this document's own type, not just whichever is most recent overall", async () => {
            mockRequest = { params: { id: "1" } };

            const doc = { id: 1, project_number: "P1", position: "10", document_type: 14 }; // 14 = PBOM_HARDWARE
            // Motor is the more recent completion, but this document is
            // Hardware's — it must pick up Hardware's status, not Motor's.
            const completionRows = [
                {
                    order_id: "m1",
                    workstation: "Motor",
                    status: "complete",
                    cycle_index: 1,
                    total_cycles: 1,
                    product_order: "PO-M",
                    sales_order: "SO1",
                    created_at: "2026-09-18T10:00:00Z",
                },
                {
                    order_id: "h1",
                    workstation: "Hardware",
                    status: "complete_with_changes",
                    cycle_index: 1,
                    total_cycles: 1,
                    product_order: "PO-H",
                    sales_order: "SO1",
                    created_at: "2026-09-18T09:00:00Z",
                },
            ];

            const db = jest.fn((table: string) => {
                if (table === "documents") return chain(doc);
                if (table === "order_completion_log") return chain(completionRows);
                if (table === "revisions") return chain(null);
                return chain([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentById(mockRequest as Request, mockResponse as Response);

            expect(mockJson).toHaveBeenCalledWith(
                expect.objectContaining({
                    status: "complete_with_changes",
                    completion: expect.objectContaining({ order_id: "h1", workstation: "Hardware" }),
                }),
            );
        });

        it("attaches who completed each cycle (for this document's workstation only) to the cycles list", async () => {
            mockRequest = { params: { id: "1" } };
            const doc = { id: 1, project_number: "P1", position: "10", document_type: 14 };
            // Newest first. Motor's completer must never leak into Hardware's cycles.
            const completionRows = [
                { order_id: "m1", workstation: "Motor", status: "complete", cycle_index: 1, total_cycles: 2, max_total_cycles: 2, project_number: "P1", position: "10", employee_name: "Motor Guy", created_at: "2026-09-18T11:00:00Z" },
                { order_id: "h1", workstation: "Hardware", status: "complete", cycle_index: 2, total_cycles: 2, max_total_cycles: 2, project_number: "P1", position: "10", employee_name: "Iveta S.", created_at: "2026-09-18T10:00:00Z" },
                { order_id: "h1", workstation: "Hardware", status: "complete", cycle_index: 1, total_cycles: 2, max_total_cycles: 2, project_number: "P1", position: "10", employee_name: "Silvia D.", created_at: "2026-09-18T09:00:00Z" },
            ];
            const db = jest.fn((table: string) => {
                if (table === "documents") return chain(doc);
                if (table === "order_completion_log") return chain(completionRows);
                if (table === "revisions") return chain(null);
                return chain([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentById(mockRequest as Request, mockResponse as Response);

            const body = mockJson.mock.calls[0][0];
            expect(body.cycles.map((c: any) => [c.cycleIndex, c.completedBy])).toEqual([
                [1, "Silvia D."],
                [2, "Iveta S."],
            ]);
        });

        it("falls back to a null completion/status when no completion matches this document's type", async () => {
            mockRequest = { params: { id: "2" } };
            const doc = { id: 2, project_number: "P1", position: "10", document_type: 999 };

            const db = jest.fn((table: string) => {
                if (table === "documents") return chain(doc);
                if (table === "order_completion_log") return chain([]);
                if (table === "revisions") return chain(null);
                return chain([]);
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentById(mockRequest as Request, mockResponse as Response);

            expect(mockJson).toHaveBeenCalledWith(
                expect.objectContaining({ status: null, completion: null }),
            );
        });

        it("returns 404 when the document doesn't exist", async () => {
            mockRequest = { params: { id: "999" } };
            const db = jest.fn(() => chain(null));
            (getDb as jest.Mock).mockResolvedValue(db);

            await getDocumentById(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(404);
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
