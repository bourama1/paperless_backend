process.env.ARCHIVE_SHARE_PATH = "/tmp/test-archive-share";
process.env.ARCHIVE_RETENTION_DAYS = "7";
process.env.ARCHIVE_DOCUMENT_TYPES = "14,4";
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

import { runArchivalSweep } from "../../services/archivalService";
import { getDb } from "../../config/database";
import axios from "axios";
import { convertToPdfA } from "../../services/pdfaService";

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
                return {};
            }),
            { fn: { now: () => "NOW()" } },
        );
        (getDb as jest.Mock).mockResolvedValue(db);

        await runArchivalSweep();

        expect(axios.get).not.toHaveBeenCalled();
        expect(convertToPdfA).not.toHaveBeenCalled();
    });

    it("fetches each configured document type, converts to PDF/A, and marks the order archived", async () => {
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
                return {};
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

        // ARCHIVE_DOCUMENT_TYPES = "14,4" -> 2 fetches, 2 conversions
        expect(axios.get).toHaveBeenCalledTimes(2);
        expect(convertToPdfA).toHaveBeenCalledTimes(2);
        expect(updateFn).toHaveBeenCalledWith(
            expect.objectContaining({ archived_at: "NOW()", last_error: null }),
        );
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
                return {};
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
                return {};
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
