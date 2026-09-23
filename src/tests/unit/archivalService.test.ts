process.env.ARCHIVE_SHARE_PATH = "/tmp/test-archive-share";
process.env.ARCHIVE_RETENTION_DAYS = "7";
process.env.ARCHIVE_MAX_ATTEMPTS = "3";

jest.mock("../../config/database");
jest.mock("axios");
jest.mock("../../services/pdfaService", () => ({
    convertToPdfA: jest.fn(),
    PdfaConversionError: class PdfaConversionError extends Error {},
}));
jest.mock("../../services/workstationService", () => ({
    DOC_MANAGER_URL: "http://doc-manager.test",
}));
jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return {
        ...actual,
        writeFileSync: jest.fn(),
        unlink: jest.fn((_path: string, cb: (err: any) => void) => cb(null)),
    };
});

import { runArchivalSweep, toFontSafeText } from "../../services/archivalService";
import { getDb } from "../../config/database";
import axios from "axios";
import fs from "fs";
import { convertToPdfA } from "../../services/pdfaService";
import { PDFDocument, StandardFonts } from "pdf-lib";

function thenable<T>(value: T) {
    return { then: (resolve: (v: T) => void) => resolve(value) };
}

function makeArchiveLogQuery(rows: any[]) {
    return {
        whereNull: () => ({
            andWhere: () => ({
                andWhere: () => ({
                    orderBy: () => thenable(rows),
                }),
            }),
        }),
    };
}

// getPbomTypesForOrder derives which PBOM(s) to archive from the distinct
// real workplaces (e.g. "Hardware", "Motor") this order was seen at in
// workstation_log — resolved through the real (unmocked)
// resolvePbomTypeForWorkplace, not a fixed type list anymore.
function makeWorkstationLogQuery(workplaces: string[]) {
    return {
        distinct: () => ({
            where: () => thenable(workplaces.map((w) => ({ workstation_name: w }))),
        }),
    };
}

// getCycleInfoForOrder's three lookups (order_completion_log,
// order_preparation_log, order_cycle_checks) all end in .select() after
// some combination of .where()/.whereIn()/.orderBy() — this generic chain
// accepts any of those in any order and resolves empty by default, which
// is enough for tests that aren't specifically exercising cycle info.
function chainableEmpty(rows: any[] = []) {
    const chain: any = {};
    chain.where = () => chain;
    chain.whereIn = () => chain;
    chain.orderBy = () => chain;
    chain.select = () => thenable(rows);
    return chain;
}

describe("archivalService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    it("does nothing (and does not throw) when no orders are due", async () => {
        const update = jest.fn();
        const db = Object.assign(
            jest.fn((table: string) => {
                if (table === "order_archive_log")
                    return { ...makeArchiveLogQuery([]), update } as any;
                return chainableEmpty();
            }),
            { fn: { now: () => "NOW()" } },
        );
        (getDb as jest.Mock).mockResolvedValue(db);

        await runArchivalSweep();

        expect(axios.get).not.toHaveBeenCalled();
        expect(convertToPdfA).not.toHaveBeenCalled();
    });

    it("resolves the order's actual PBOM type(s) from workstation_log and archives them", async () => {
        const row = {
            id: 1,
            order_id: "order-1",
            project_number: "P123",
            position: "10",
            finished_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
            attempts: 0,
        };
        const updateFn = jest.fn(() => thenable(undefined));
        const db = Object.assign(
            jest.fn((table: string) => {
                if (table === "order_archive_log") {
                    return {
                        ...makeArchiveLogQuery([row]),
                        where: () => ({ update: updateFn }),
                    };
                }
                if (table === "workstation_log") {
                    // This order was seen at both Hardware and Motor —
                    // resolves to two distinct PBOM types (14 and 15).
                    return makeWorkstationLogQuery(["Hardware", "Motor"]);
                }
                return chainableEmpty();
            }),
            { fn: { now: () => "NOW()" } },
        );
        (getDb as jest.Mock).mockResolvedValue(db);

        (axios.get as jest.Mock).mockResolvedValue({
            status: 200,
            headers: {
                "content-disposition": 'attachment; filename="doc.pdf"',
            },
            data: Buffer.from("%PDF-fake"),
        });
        (convertToPdfA as jest.Mock).mockResolvedValue(undefined);

        await runArchivalSweep();

        // Hardware + Motor -> PBOM_HARDWARE + PBOM_MOTOR -> 2 fetches, 2 conversions
        expect(axios.get).toHaveBeenCalledTimes(2);
        expect(convertToPdfA).toHaveBeenCalledTimes(2);
        expect(updateFn).toHaveBeenCalledWith(
            expect.objectContaining({ archived_at: "NOW()", last_error: null }),
        );
    });

    it("names archived files KM-SVM_<salesOrder>_<position>, bumping position by 1 for Motor so it never collides with Hardware's", async () => {
        const row = {
            id: 4,
            order_id: "order-4",
            project_number: "P123",
            position: "10",
            sales_order: "604473",
            finished_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
            attempts: 0,
        };
        const updateFn = jest.fn(() => thenable(undefined));
        const db = Object.assign(
            jest.fn((table: string) => {
                if (table === "order_archive_log") {
                    return {
                        ...makeArchiveLogQuery([row]),
                        where: () => ({ update: updateFn }),
                    };
                }
                if (table === "workstation_log") {
                    return makeWorkstationLogQuery(["Hardware", "Motor"]);
                }
                return chainableEmpty();
            }),
            { fn: { now: () => "NOW()" } },
        );
        (getDb as jest.Mock).mockResolvedValue(db);

        (axios.get as jest.Mock).mockResolvedValue({
            status: 200,
            headers: { "content-disposition": 'attachment; filename="doc.pdf"' },
            data: Buffer.from("%PDF-fake"),
        });
        (convertToPdfA as jest.Mock).mockResolvedValue(undefined);

        await runArchivalSweep();

        const outputPaths = (convertToPdfA as jest.Mock).mock.calls.map((call) => call[1]);
        expect(outputPaths).toEqual(
            expect.arrayContaining([
                expect.stringContaining(`KM-SVM_604473_10.pdf`),
                expect.stringContaining(`KM-SVM_604473_11.pdf`),
            ]),
        );
    });

    it("stamps a per-cycle production record page (prepared/completed/checked by) onto the archived PDF", async () => {
        const row = {
            id: 5,
            order_id: "order-5",
            project_number: "P1",
            position: "10",
            sales_order: "SO1",
            finished_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
            attempts: 0,
        };
        const updateFn = jest.fn(() => thenable(undefined));

        // 2 cycles completed; only cycle 1 was prepared (matches how prep
        // only applies to non-PTL items, not every cycle); both checked.
        const completionRows = [
            { cycle_index: 1, employee_name: "Petr Svoboda" },
            { cycle_index: 2, employee_name: "Petr Svoboda" },
        ];
        const prepRows = [{ cycle_index: 1, employee_name: "Jan Novak" }];
        const checkRows = [
            { cycle_index: 1, employee_name: "Eva Kovacova" },
            { cycle_index: 2, employee_name: "Eva Kovacova" },
        ];

        const db = Object.assign(
            jest.fn((table: string) => {
                if (table === "order_archive_log") {
                    return {
                        ...makeArchiveLogQuery([row]),
                        where: () => ({ update: updateFn }),
                    };
                }
                if (table === "workstation_log") return makeWorkstationLogQuery(["Hardware"]);
                if (table === "order_completion_log") return chainableEmpty(completionRows);
                if (table === "order_preparation_log") return chainableEmpty(prepRows);
                if (table === "order_cycle_checks") return chainableEmpty(checkRows);
                return chainableEmpty();
            }),
            { fn: { now: () => "NOW()" } },
        );
        (getDb as jest.Mock).mockResolvedValue(db);

        // A real (tiny, valid) single-page PDF, built with the same
        // (unmocked) pdf-lib the production code uses — proves the
        // stamping path actually runs, not just falls back on a parse
        // error the way it would for the other tests' fake "%PDF-fake" bytes.
        const basePdf = await PDFDocument.create();
        basePdf.addPage([200, 200]);
        const basePdfBytes = await basePdf.save();

        (axios.get as jest.Mock).mockResolvedValue({
            status: 200,
            headers: { "content-disposition": 'attachment; filename="doc.pdf"' },
            data: Buffer.from(basePdfBytes),
        });
        (convertToPdfA as jest.Mock).mockResolvedValue(undefined);

        await runArchivalSweep();

        expect(convertToPdfA).toHaveBeenCalledTimes(1);
        // The stamped buffer is what gets written to the Ghostscript input
        // temp file — fs.writeFileSync is mocked, so its recorded argument
        // is the actual stamped bytes to inspect.
        const writtenBuffer = (fs.writeFileSync as jest.Mock).mock.calls[0][1];
        const stampedDoc = await PDFDocument.load(writtenBuffer);
        expect(stampedDoc.getPageCount()).toBe(2); // original page + 1 info page
    });

    it("skips (not fails) document types doc_manager 404s on, but still archives the ones that exist", async () => {
        const row = {
            id: 2,
            order_id: "order-2",
            project_number: "P999",
            position: "20",
            finished_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
            attempts: 0,
        };
        const updateFn = jest.fn(() => thenable(undefined));
        const db = Object.assign(
            jest.fn((table: string) => {
                if (table === "order_archive_log") {
                    return {
                        ...makeArchiveLogQuery([row]),
                        where: () => ({ update: updateFn }),
                    };
                }
                if (table === "workstation_log") {
                    return makeWorkstationLogQuery(["Hardware", "Motor"]);
                }
                return chainableEmpty();
            }),
            { fn: { now: () => "NOW()" } },
        );
        (getDb as jest.Mock).mockResolvedValue(db);

        (axios.get as jest.Mock)
            .mockResolvedValueOnce({
                status: 200,
                headers: {
                    "content-disposition": 'attachment; filename="doc.pdf"',
                },
                data: Buffer.from("%PDF-fake"),
            })
            .mockResolvedValueOnce({
                status: 404,
                headers: {},
                data: Buffer.alloc(0),
            });
        (convertToPdfA as jest.Mock).mockResolvedValue(undefined);

        await runArchivalSweep();

        expect(convertToPdfA).toHaveBeenCalledTimes(1);
        expect(updateFn).toHaveBeenCalledWith(
            expect.objectContaining({ archived_at: "NOW()" }),
        );
    });

    it("increments attempts and records the error, but does not mark archived, on failure", async () => {
        const row = {
            id: 3,
            order_id: "order-3",
            project_number: "P1",
            position: "1",
            finished_at: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000),
            attempts: 1,
        };
        const updateFn = jest.fn(() => thenable(undefined));
        const db = Object.assign(
            jest.fn((table: string) => {
                if (table === "order_archive_log") {
                    return {
                        ...makeArchiveLogQuery([row]),
                        where: () => ({ update: updateFn }),
                    };
                }
                if (table === "workstation_log") {
                    // No workplace history on record for this order —
                    // getPbomTypesForOrder falls back to PBOM_HARDWARE, so
                    // one fetch is still attempted (and fails, below).
                    return makeWorkstationLogQuery([]);
                }
                return chainableEmpty();
            }),
            { fn: { now: () => "NOW()" } },
        );
        (getDb as jest.Mock).mockResolvedValue(db);

        (axios.get as jest.Mock).mockRejectedValue(
            new Error("doc_manager unreachable"),
        );

        await runArchivalSweep();

        expect(updateFn).toHaveBeenCalledWith(
            expect.objectContaining({
                attempts: 2,
                last_error: expect.stringContaining("doc_manager unreachable"),
            }),
        );
        expect(updateFn).not.toHaveBeenCalledWith(
            expect.objectContaining({ archived_at: expect.anything() }),
        );
    });
});

describe("toFontSafeText", () => {
    it("keeps what Courier can draw and falls back to the base letter for the rest", async () => {
        const doc = await PDFDocument.create();
        const font = await doc.embedFont(StandardFonts.Courier);
        const supported = new Set(font.getCharacterSet());

        // Š, á, é, í are WinAnsi; ř, č, ě aren't.
        const safe = toFontSafeText("Šťastná Dvořáková Černý", supported);

        expect(safe).toBe("Šťastná Dvořáková Černý".replace("ť", "t").replace("ř", "r").replace("Č", "C"));
        // Must not throw once drawn.
        expect(() => font.encodeText(safe)).not.toThrow();
    });
});
