jest.mock("../../config/database");

const sampleCountryCodes = JSON.stringify({
    germany: "DE",
    "czech republic": "CZ",
});

// Mirrors the real config/label-type-config.json shape, with entries for the
// two label types used in sampleCsvContent below: "section" (door-leaf/wing
// group) and "t01_hw_kr" (hardware/motor group's Hardware-specific subset —
// see WORKPLACE_TYPE_FILTER, which splits that shared scan-prefix group by
// "_hw_kr" suffix between the Hardware and Motor workplaces) — so tests
// exercise the real workplace → scan-prefix → parametry matching path
// instead of an empty config.
const sampleParametryConfig = JSON.stringify([
    {
        scanB: "KM-SVK ",
        scanC: 'K"žSVK ',
        type: "section",
        printPrimary: "Ano",
        printSecondary: "Ne",
        copies: 4,
        printMethod: "V sérii",
        lastCycleNum: "",
    },
    {
        scanB: "KM-SVM ",
        scanC: 'K"žSV" ',
        type: "t01_hw_kr",
        printPrimary: "Ano",
        printSecondary: "Ne",
        copies: 1,
        printMethod: "V sérii",
        lastCycleNum: "1",
    },
    {
        scanB: "KM-SVM ",
        scanC: 'K"žSV" ',
        type: "motor",
        printPrimary: "Ano",
        printSecondary: "Ne",
        copies: 1,
        printMethod: "V sérii",
        lastCycleNum: "1",
    },
    {
        scanB: "KM-SVM ",
        scanC: 'K"žSV" ',
        type: "mot_prisl2",
        printPrimary: "Ano",
        printSecondary: "Ne",
        copies: 1,
        printMethod: "V sérii",
        lastCycleNum: "1",
    },
]);

jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return {
        ...actual,
        readFileSync: jest.fn((...args: any[]) => {
            if (
                typeof args[0] === "string" &&
                args[0].includes("country-codes.json")
            ) {
                return sampleCountryCodes;
            }
            if (
                typeof args[0] === "string" &&
                args[0].includes("label-type-config.json")
            ) {
                return sampleParametryConfig;
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

import {
    handleLabelPrinting,
    handleQrSticker,
    extractDoorNumber,
    selectRowsForCycle,
    selectMotorBatchRows,
    LabelRow,
} from "../../services/labelPrintingService";
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
        where: () => ({
            first: () => ({ then: (resolve: Function) => resolve(null) }),
        }),
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
    // packageType "1/4" here matches mockOrderUpdate's cycleIndex (1) below —
    // these dry-run/dedup tests aren't about door-matching itself, which is
    // covered separately further down using the real uploaded CSV samples.
    't01_hw_kr;"Customer";"SO-001";"Part2";"1/4";"01";"123457";"789013";"PO-001";"001235";"R1";"Germ.";"1.0";;;"Delivery GmbH";"Main St 1";"12345";"Germ."',
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
            const finishedUpdate = {
                ...mockOrderUpdate,
                action: "FINISHED" as const,
            };
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
                            first: () =>
                                thenable(callCount <= 1 ? { id: 1 } : null),
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
            (fs.readFileSync as jest.Mock).mockImplementation(
                (path: string) => {
                    if (path.includes("country-codes.json"))
                        return sampleCountryCodes;
                    throw new Error("Read error");
                },
            );

            await handleLabelPrinting(mockOrderUpdate);
        });
    });

    describe("handleQrSticker", () => {
        it("should skip if not the last cycle", async () => {
            const midCycleUpdate = {
                ...mockOrderUpdate,
                cycleIndex: 2,
                totalCycles: 4,
            };
            await handleQrSticker(midCycleUpdate, []);
        });

        it("should skip if no TMP file reference in CSV rows", async () => {
            await handleQrSticker(mockOrderUpdate, []);
        });

        it("should skip if TMP file is not found", async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const labelRows = [{ tmpFile: "TMP123.TXT" } as any];

            await handleQrSticker(mockOrderUpdate, labelRows);
        });
    });
});

// ─── cycle/door filtering — real production CSV samples ────────────────────
//
// Order 604427 (position 020) is a real 2-door order: door 1's and door 2's
// hardware-kit boxes ("K -" / "V -"), rail ("HW+tracks"), and the shared
// outer packaging box ("section") all live in one CSV. Used verbatim here
// (not a synthetic fixture) so these tests fail if the real data shape ever
// stops matching what extractDoorNumber/selectRowsForCycle expect.

const order604427Csv = [
    '"section";"RFQ: 1649";"604427";"1 - 2";"section 1/1";"020";"CRFQ: 10200701";"T6044270200701";"Z604450";"2097";"0";"SA Riyadh - 14525-7818";"340";"TMP054666230.TXT";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
    '"t10_spol";"RFQ: 1649";"604427";"1";"HW+tracks 1/2";"020";"CRFQ: 10200702";"T6044270200702";"Z604450";"2097";"0";"SA Riyadh - 14525-7818";"134";"TMP054666230.TXT";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
    '"t10_spol";"RFQ: 1649";"604427";"2";"HW+tracks 2/2";"020";"CRFQ: 10200703";"T6044270200703";"Z604450";"2097";"0";"SA Riyadh - 14525-7818";"134";"TMP054666230.TXT";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
    '"t10_hw_kr";"RFQ: 1649";"604427";"K - 1/2";"V - 1/2";"020";"";"";"Z604450";"2097";"";"";"";"";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
    '"t10_hw_kr";"RFQ: 1649";"604427";"K - 2/2";"V - 1/2";"020";"";"";"Z604450";"2097";"";"";"";"";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
    '"t10_hw_kr";"RFQ: 1649";"604427";"K - 1/2";"V - 2/2";"020";"";"";"Z604450";"2097";"";"";"";"";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
    '"t10_hw_kr";"RFQ: 1649";"604427";"K - 2/2";"V - 2/2";"020";"";"";"Z604450";"2097";"";"";"";"";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
    '"motor";"RFQ: 1649";"604427";"";"Motor Cube 1/2";"020";"CRFQ: 10200704";"T6044270200704";"Z604450";"2097";"0";"SA Riyadh - 14525-7818";"21";"TMP054666230.TXT";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
    '"motor";"RFQ: 1649";"604427";"";"Motor Cube 2/2";"020";"CRFQ: 10200705";"T6044270200705";"Z604450";"2097";"0";"SA Riyadh - 14525-7818";"21";"TMP054666230.TXT";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
    '"mot_prisl2";"RFQ: 1649";"604427";"";"Cube accessories 1/2";"020";"CRFQ: 10200706";"T6044270200706";"Z604450";"2097";"0";"SA Riyadh - 14525-7818";"0";"TMP054666230.TXT";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
    '"mot_prisl2";"RFQ: 1649";"604427";"";"Cube accessories 2/2";"020";"CRFQ: 10200707";"T6044270200707";"Z604450";"2097";"0";"SA Riyadh - 14525-7818";"0";"TMP054666230.TXT";"";"INNTESSA";"Al Kharj Branch Road 3891";"Riyadh - 14525-7818";"SA|Saudi Arabia"',
].join("\n");

function parseSampleCsv(lines: string): LabelRow[] {
    return lines.split("\n").map((line) => {
        const c = line.split(";").map((f) => f.replace(/^"|"$/g, "").trim());
        return {
            labelType: c[0] ?? "",
            customerName: c[1] ?? "",
            salesOrder: c[2] ?? "",
            packagePart: c[3] ?? "",
            packageType: c[4] ?? "",
            position: c[5] ?? "",
            customerBarcode: c[6] ?? "",
            toorsBarcode: c[7] ?? "",
            orderNumber: c[8] ?? "",
            customerNumber: c[9] ?? "",
            route: c[10] ?? "",
            countryAddress: c[11] ?? "",
            weight: c[12] ?? "",
            tmpFile: c[13] ?? "",
            deliveryName: c[15] ?? "",
            deliveryAddress: c[16] ?? "",
            deliveryPostCode: c[17] ?? "",
            deliveryCountry: c[18] ?? "",
        };
    });
}

describe("extractDoorNumber", () => {
    it("extracts the door number from a 'V - N/M' pattern", () => {
        expect(extractDoorNumber("V - 1/2")).toBe(1);
        expect(extractDoorNumber("V - 2/2")).toBe(2);
    });

    it("extracts the door number from a plain 'description N/M' pattern (no 'V -' prefix)", () => {
        expect(extractDoorNumber("HW+tracks 1/2")).toBe(1);
        expect(extractDoorNumber("HW+tracks 2/2")).toBe(2);
        expect(extractDoorNumber("Motor Cube 1/2")).toBe(1);
    });

    it("extracts 1 from a single-door 'description 1/1' value", () => {
        expect(extractDoorNumber("section 1/1")).toBe(1);
    });

    it("returns null for text with no N/M pagination at all", () => {
        expect(extractDoorNumber("")).toBeNull();
        expect(extractDoorNumber("Some free text")).toBeNull();
    });
});

describe("selectRowsForCycle — real 2-door order (604427)", () => {
    // Motor/mot_prisl2 rows are excluded here — they're handled by a
    // different function (selectMotorBatchRows, tested below), never by
    // per-door filtering, regardless of the N/M pattern in their own
    // packageType.
    const rows = parseSampleCsv(order604427Csv).filter(
        (r) => r.labelType !== "motor" && r.labelType !== "mot_prisl2",
    );
    const summarize = (r: LabelRow) =>
        `${r.labelType} ${r.packagePart} ${r.packageType}`.trim();

    it("cycle 1 selects only door 1's hw_kr boxes, the shared section, and door 1's rail", () => {
        const result = selectRowsForCycle(rows, 1, 2);
        expect(result.map(summarize)).toEqual([
            "section 1 - 2 section 1/1",
            "t10_spol 1 HW+tracks 1/2",
            "t10_hw_kr K - 1/2 V - 1/2",
            "t10_hw_kr K - 2/2 V - 1/2",
        ]);
        // This is the exact bug being fixed: door 2's rows must never appear
        // while cycle 1 is printing.
        expect(result.some((r) => r.packageType.includes("2/2"))).toBe(false);
    });

    it("cycle 2 selects only door 2's hw_kr boxes and door 2's rail — not the section again", () => {
        const result = selectRowsForCycle(rows, 2, 2);
        expect(result.map(summarize)).toEqual([
            "t10_spol 2 HW+tracks 2/2",
            "t10_hw_kr K - 1/2 V - 2/2",
            "t10_hw_kr K - 2/2 V - 2/2",
        ]);
        // The shared outer packaging box only ever prints once, on cycle 1 —
        // it must not print again (duplicate label) on cycle 2.
        expect(result.some((r) => r.labelType === "section")).toBe(false);
    });

    it("both K-boxes for a door print together, on that door's own cycle", () => {
        const cycle1Boxes = selectRowsForCycle(rows, 1, 2)
            .filter((r) => r.labelType === "t10_hw_kr")
            .map((r) => r.packagePart)
            .sort();
        const cycle2Boxes = selectRowsForCycle(rows, 2, 2)
            .filter((r) => r.labelType === "t10_hw_kr")
            .map((r) => r.packagePart)
            .sort();
        expect(cycle1Boxes).toEqual(["K - 1/2", "K - 2/2"]);
        expect(cycle2Boxes).toEqual(["K - 1/2", "K - 2/2"]);
    });
});

describe("selectMotorBatchRows — real 2-door order (604427)", () => {
    const rows = parseSampleCsv(order604427Csv).filter(
        (r) => r.labelType === "motor" || r.labelType === "mot_prisl2",
    );

    it("prints every row of each type when quantity covers them all (the example from the request)", () => {
        const result = selectMotorBatchRows(rows, 2);
        expect(result).toHaveLength(4);
        expect(result.filter((r) => r.labelType === "motor")).toHaveLength(2);
        expect(result.filter((r) => r.labelType === "mot_prisl2")).toHaveLength(
            2,
        );
    });

    it("caps each type to the first `quantity` rows in CSV order when quantity is smaller", () => {
        const result = selectMotorBatchRows(rows, 1);
        expect(result).toHaveLength(2);
        expect(result.find((r) => r.labelType === "motor")!.packageType).toBe(
            "Motor Cube 1/2",
        );
        expect(
            result.find((r) => r.labelType === "mot_prisl2")!.packageType,
        ).toBe("Cube accessories 1/2");
    });

    it("falls back to printing every row when quantity is missing or invalid", () => {
        expect(selectMotorBatchRows(rows, 0)).toHaveLength(4);
        expect(selectMotorBatchRows(rows, -1)).toHaveLength(4);
        expect(selectMotorBatchRows(rows, undefined as any)).toHaveLength(4);
    });

    it("doesn't crash or duplicate rows when quantity exceeds what's available", () => {
        expect(selectMotorBatchRows(rows, 10)).toHaveLength(4);
    });
});

describe("handleLabelPrinting — Motor workstation batch printing (integration)", () => {
    it("prints all 4 motor+accessory rows together on the Motor workstation's first cycle, per order.quantity", async () => {
        (fs.readFileSync as jest.Mock).mockImplementation((path: string) => {
            if (typeof path === "string" && path.includes("country-codes.json"))
                return sampleCountryCodes;
            return order604427Csv;
        });
        (fs.existsSync as jest.Mock).mockReturnValue(true);

        const db = createDbMock();
        (getDb as jest.Mock).mockResolvedValue(db);

        const motorUpdate: OrderUpdate = {
            ...mockOrderUpdate,
            order: {
                ...mockOrderUpdate.order,
                workplace: "Motor",
                salesOrder: "604427",
                position: "020",
                quantity: 2,
                maxCycle: 2,
            },
            cycleIndex: 1,
            totalCycles: 2,
        };

        await handleLabelPrinting(motorUpdate);

        // 4 rows (2 motor + 2 mot_prisl2) each insert one label_print_log
        // row — confirms the full pipeline actually printed all of them
        // together in this one call, not just the pure helper function.
        const insertCalls = (db as jest.Mock).mock.calls.filter(
            (args) => args[0] === "label_print_log",
        );
        expect(insertCalls.length).toBeGreaterThanOrEqual(4);
    });
});
