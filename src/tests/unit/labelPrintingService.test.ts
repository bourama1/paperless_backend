jest.mock("../../config/database");

const sampleCountryCodes = JSON.stringify({
    germany: "DE",
    "czech republic": "CZ",
});

jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return {
        ...actual,
        readFileSync: jest.fn((...args: any[]) => {
            if (typeof args[0] === "string" && args[0].includes("country-codes.json")) {
                return sampleCountryCodes;
            }
            throw new Error("ENOENT: no such file or directory");
        }),
        existsSync: jest.fn().mockReturnValue(true),
        watchFile: jest.fn(),
    };
});
jest.mock("net", () => ({
    Socket: jest.fn().mockImplementation(() => ({
        connect: jest.fn((port, host, cb) => cb && cb()),
        write: jest.fn((_data, cb) => cb && cb()),
        end: jest.fn(),
        destroy: jest.fn(),
        on: jest.fn(),
        setTimeout: jest.fn(),
    })),
}));

import { handleLabelPrinting, handleQrSticker } from "../../services/labelPrintingService";
import { getDb } from "../../config/database";
import fs from "fs";
import { OrderUpdate } from "../../services/workstationService";

function createDbMock() {
    const db = Object.assign(jest.fn(), {
        schema: {
            hasTable: jest.fn().mockResolvedValue(true),
        },
    });
    db.mockReturnValue({
        where: () => ({ first: () => ({ then: (resolve: Function) => resolve(null) }) }),
        insert: () => ({ then: (resolve: Function) => resolve(undefined) }),
    });
    return db;
}

function thenable<T>(value: T) {
    return { then: (resolve: (v: T) => void) => resolve(value) };
}

const mockOrderUpdate: OrderUpdate = {
    order: {
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
    },
    cycleIndex: 1,
    totalCycles: 4,
    _id: "update1",
    datetime: "2026-01-03T12:00:00Z",
    action: "STARTED",
};

const sampleCsvContent = [
    'section;"Customer";"SO-001";"Part1";"1/4";"01";"123456";"789012";"PO-001";"001234";"R1";"Germ.","0.5";"TMP123.TXT";;"Delivery GmbH";"Main St 1";"12345";"Germ."',
    'motor;"Customer";"SO-001";"Part2";"2/4";"01";"123457";"789013";"PO-001";"001235";"R1";"Germ.";"1.0";;;"Delivery GmbH";"Main St 1";"12345";"Germ."',
].join("\n");

describe("Label Printing Service", () => {
    beforeEach(() => {
        jest.clearAllMocks();

        (fs.readFileSync as jest.Mock).mockImplementation((path: string) => {
            if (path.includes("country-codes.json")) return sampleCountryCodes;
            return sampleCsvContent;
        });
        (fs.existsSync as jest.Mock).mockReturnValue(true);
    });

    describe("handleLabelPrinting", () => {
        it("should skip if action does not match trigger (STARTED)", async () => {
            const finishedUpdate = { ...mockOrderUpdate, action: "FINISHED" as const };
            await handleLabelPrinting(finishedUpdate);
            expect(fs.existsSync).not.toHaveBeenCalled();
        });

        it("should skip if workplace is not Hardware", async () => {
            const nonHardwareUpdate = {
                ...mockOrderUpdate,
                order: { ...mockOrderUpdate.order, workplace: "Assembly" },
            };
            await handleLabelPrinting(nonHardwareUpdate);
            expect(fs.existsSync).not.toHaveBeenCalled();
        });

        it("should handle missing CSV file gracefully", async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);
            const db = createDbMock();
            (getDb as jest.Mock).mockResolvedValue(db);

            await handleLabelPrinting(mockOrderUpdate);
            expect(fs.existsSync).toHaveBeenCalled();
        });

        it("should run in dry-run mode without printing to printer", async () => {
            const db = createDbMock();
            (getDb as jest.Mock).mockResolvedValue(db);

            await handleLabelPrinting(mockOrderUpdate);

            expect(fs.readFileSync).toHaveBeenCalled();
            expect(db).toHaveBeenCalledWith("label_print_log");
        });

        it("should skip already-printed labels (deduplication)", async () => {
            let callCount = 0;
            const db = Object.assign(jest.fn(), {
                schema: {
                    hasTable: jest.fn().mockResolvedValue(true),
                },
            });
            db.mockImplementation((table: string) => {
                if (table === "label_print_log") {
                    callCount++;
                    return {
                        where: () => ({
                            first: () => thenable(callCount <= 1 ? { id: 1 } : null),
                        }),
                        insert: () => thenable(undefined),
                    };
                }
                return { insert: () => thenable(undefined) };
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await handleLabelPrinting(mockOrderUpdate);
            expect(db).toHaveBeenCalledWith("label_print_log");
        });

        it("should handle read errors gracefully", async () => {
            (fs.readFileSync as jest.Mock).mockImplementation((path: string) => {
                if (path.includes("country-codes.json")) return sampleCountryCodes;
                throw new Error("Read error");
            });

            await handleLabelPrinting(mockOrderUpdate);
        });
    });

    describe("handleQrSticker", () => {
        it("should skip if not the last cycle", async () => {
            const midCycleUpdate = { ...mockOrderUpdate, cycleIndex: 2, totalCycles: 4 };
            await handleQrSticker(midCycleUpdate, []);
        });

        it("should skip if no TMP file reference in CSV rows", async () => {
            await handleQrSticker(mockOrderUpdate, []);
        });

        it("should skip if TMP file is not found", async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const labelRows = [
                { tmpFile: "TMP123.TXT" } as any,
            ];

            await handleQrSticker(mockOrderUpdate, labelRows);
        });
    });
});
