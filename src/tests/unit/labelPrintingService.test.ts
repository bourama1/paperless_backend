jest.mock("../../config/database");
// Auto-mocked so isPrintingEnabled defaults to undefined (falsy) unless a
// test sets it — most tests want the REAL default (true), so beforeEach
// resets it to that; only the kill-switch tests below override it.
jest.mock("../../services/printSettingsService");

const sampleCountryCodes = JSON.stringify({
    germany: "DE",
    "czech republic": "CZ",
});

// Mirrors the real config/label-type-config.json shape, with entries for the
// two label types used in sampleCsvContent below: "section" (door-leaf/wing
// group) and "t10_hw_kr" (hardware/motor group's Hardware-specific subset —
// see WORKPLACE_TYPE_FILTER, which splits that shared scan-prefix group by
// explicit per-workplace type lists) — so tests
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
        type: "t10_hw_kr",
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
    resolveTypeFilter,
    resolveWorkplacePrinter,
    selectMotorBatchRows,
    parseTmpContent,
    LabelRow,
} from "../../services/labelPrintingService";
import { getDb } from "../../config/database";
import fs from "fs";
import net from "net";
import { OrderUpdate, motorCycleRange } from "../../services/workstationService";
import { isPrintingEnabled } from "../../services/printSettingsService";

// File-scope so it applies to every describe block below, not just ones
// nested under "Label Printing Service" — printing is enabled by default
// in real life, so that's the default here too; only the kill-switch
// tests further down override it.
beforeEach(() => {
    (isPrintingEnabled as jest.Mock).mockReturnValue(true);
});

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
    't10_hw_kr;"Customer";"SO-001";"Part2";"1/4";"01";"123457";"789013";"PO-001";"001235";"R1";"Germ.";"1.0";;;"Delivery GmbH";"Main St 1";"12345";"Germ."',
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

        // Regression: a real combined CSV has rows for several workplaces
        // (Hardware's "*_hw_kr" rows, plus "section"/"motor"/"mot_prisl2" for
        // other stations) sharing one TMP*.TXT reference — but only some of
        // those rows actually carry the tmpFile column filled in (here:
        // "motor", not the Hardware-matching "t10_hw_kr" row). Printing was
        // narrowing the CSV down to just the current workplace's matching
        // rows BEFORE handing off to the QR sticker step, so a TMP file that
        // only appeared on a row for a different workplace was invisible to
        // it — see the labelRows/matchedRows split in handleLabelPrinting.
        it("finds the TMP*.TXT reference for the QR sticker even when it only appears on a row for a different workplace", async () => {
            const csv = [
                't10_hw_kr;"Customer";"SO-001";"Part1";"1/1";"01";"123456";"789012";"PO-001";"001234";"R1";"Germ.";"0.5";;;"Delivery GmbH";"Main St 1";"12345";"Germ."',
                'motor;"Customer";"SO-001";"";"Motor 1/1";"01";"123457";"789013";"PO-001";"001235";"R1";"Germ.";"1.0";"TMP999.TXT";;"Delivery GmbH";"Main St 1";"12345";"Germ."',
            ].join("\n");
            (fs.readFileSync as jest.Mock).mockImplementation((p: string) => {
                if (p.includes("country-codes.json")) return sampleCountryCodes;
                return csv;
            });
            (fs.existsSync as jest.Mock).mockImplementation(
                (p: string) => !p.includes("TMP999.TXT"), // exists check for the TMP path itself returns false, everything else true
            );
            const db = createDbMock();
            (getDb as jest.Mock).mockResolvedValue(db);

            const lastCycleUpdate = { ...mockOrderUpdate, cycleIndex: 1, totalCycles: 1 };
            await handleLabelPrinting(lastCycleUpdate);

            // handleQrSticker only gets this far (calling parseTmpFile ->
            // fs.existsSync on the TMP path) if it was actually handed a row
            // carrying the tmpFile reference — the pre-fix code would have
            // logged "No TMP file reference" and never reached here.
            expect(fs.existsSync).toHaveBeenCalledWith(
                expect.stringContaining("TMP999.TXT"),
            );
        });
    });

    describe("handleQrSticker", () => {
        it("no longer skips mid-cycle updates — prints one QR per cycle, not doorCount copies on the last cycle only", async () => {
            const midCycleUpdate = {
                ...mockOrderUpdate,
                cycleIndex: 2,
                totalCycles: 4,
            };
            const tmpContent = [
                "pozice|01",
                "x|06210610|x|SL",
                "Objedn\xe1no|4", // door count — must NOT end up in the print count anymore
                "x|x|Cenov\xe1 skupina|B01",
            ].join("\n");
            (fs.readFileSync as jest.Mock).mockImplementation((p: string) => {
                if (p.includes("country-codes.json")) return sampleCountryCodes;
                if (p.includes("TMP123.TXT")) return tmpContent;
                return sampleCsvContent;
            });
            const labelRows = [{ tmpFile: "TMP123.TXT" } as any];
            const logSpy = jest.spyOn(console, "log").mockImplementation(() => {});

            await handleQrSticker(midCycleUpdate, labelRows);

            // QR_IMAGES_PATH is unset in tests, so this hits the dry-run
            // log — enough to prove a mid-cycle update reaches all the way
            // through (not skipped for being non-last), and that exactly
            // 1 copy prints regardless of the TMP file's doorCount=4.
            expect(logSpy).toHaveBeenCalledWith(
                expect.stringContaining("Would print 1x Indy_SL.png"),
            );
            logSpy.mockRestore();
        });

        it("should skip if no TMP file reference in CSV rows", async () => {
            await handleQrSticker(mockOrderUpdate, []);
        });

        it("should skip if TMP file is not found", async () => {
            (fs.existsSync as jest.Mock).mockReturnValue(false);

            const labelRows = [{ tmpFile: "TMP123.TXT" } as any];

            await handleQrSticker(mockOrderUpdate, labelRows);

            expect(fs.existsSync).toHaveBeenCalledWith(
                expect.stringContaining("TMP123.TXT"),
            );
        });

        it("should skip for Motor — QR stickers are Hardware-only", async () => {
            const motorUpdate = {
                ...mockOrderUpdate,
                order: { ...mockOrderUpdate.order, workplace: "Motor" },
            };
            const labelRows = [{ tmpFile: "TMP123.TXT" } as any];

            await handleQrSticker(motorUpdate, labelRows);

            expect(fs.existsSync).not.toHaveBeenCalled();
        });
    });

    describe("print kill switch (isPrintingEnabled)", () => {
        const originalHost = process.env.LABEL_PRINTER_HOST_HARDWARE;

        afterEach(() => {
            if (originalHost === undefined) delete process.env.LABEL_PRINTER_HOST_HARDWARE;
            else process.env.LABEL_PRINTER_HOST_HARDWARE = originalHost;
        });

        it("suppresses the actual print even with a printer configured, when printing is disabled", async () => {
            process.env.LABEL_PRINTER_HOST_HARDWARE = "10.0.0.5";
            (isPrintingEnabled as jest.Mock).mockReturnValue(false);
            const db = createDbMock();
            (getDb as jest.Mock).mockResolvedValue(db);

            await handleLabelPrinting(mockOrderUpdate);

            expect(net.Socket).not.toHaveBeenCalled();
            // Still recorded as printed, matching the existing "no printer
            // configured" dry-run behavior — see the main print loop.
            expect(db).toHaveBeenCalledWith("label_print_log");
        });

        it("prints for real when a printer is configured and printing is enabled", async () => {
            process.env.LABEL_PRINTER_HOST_HARDWARE = "10.0.0.5";
            (isPrintingEnabled as jest.Mock).mockReturnValue(true);
            const db = createDbMock();
            (getDb as jest.Mock).mockResolvedValue(db);

            await handleLabelPrinting(mockOrderUpdate);

            expect(net.Socket).toHaveBeenCalled();
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

    it("selects every row of each type when the range covers them all", () => {
        const result = selectMotorBatchRows(rows, 0, 2);
        expect(result).toHaveLength(4);
        expect(result.filter((r) => r.labelType === "motor")).toHaveLength(2);
        expect(result.filter((r) => r.labelType === "mot_prisl2")).toHaveLength(
            2,
        );
    });

    it("takes only the first row of each type for start=0, count=1", () => {
        const result = selectMotorBatchRows(rows, 0, 1);
        expect(result).toHaveLength(2);
        expect(result.find((r) => r.labelType === "motor")!.packageType).toBe(
            "Motor Cube 1/2",
        );
        expect(
            result.find((r) => r.labelType === "mot_prisl2")!.packageType,
        ).toBe("Cube accessories 1/2");
    });

    it("takes the SECOND row of each type for start=1, count=1 — a later batch's slice", () => {
        const result = selectMotorBatchRows(rows, 1, 1);
        expect(result).toHaveLength(2);
        expect(result.find((r) => r.labelType === "motor")!.packageType).toBe(
            "Motor Cube 2/2",
        );
        expect(
            result.find((r) => r.labelType === "mot_prisl2")!.packageType,
        ).toBe("Cube accessories 2/2");
    });

    it("selects nothing for a non-positive count", () => {
        expect(selectMotorBatchRows(rows, 0, 0)).toHaveLength(0);
        expect(selectMotorBatchRows(rows, 0, -1)).toHaveLength(0);
    });

    it("doesn't crash or duplicate rows when the range exceeds what's available", () => {
        expect(selectMotorBatchRows(rows, 0, 10)).toHaveLength(4);
        expect(selectMotorBatchRows(rows, 5, 10)).toHaveLength(0);
    });
});

describe("motorCycleRange", () => {
    it("splits a 9-unit order into a 5-unit first cycle and a 4-unit remainder second cycle (the reported bug)", () => {
        expect(motorCycleRange(9, 5, 1, 2)).toEqual({ start: 0, count: 5 });
        expect(motorCycleRange(9, 5, 2, 2)).toEqual({ start: 5, count: 4 });
    });

    it("caps every non-last cycle at maxCycle even when more remain", () => {
        expect(motorCycleRange(12, 5, 1, 3)).toEqual({ start: 0, count: 5 });
        expect(motorCycleRange(12, 5, 2, 3)).toEqual({ start: 5, count: 5 });
        expect(motorCycleRange(12, 5, 3, 3)).toEqual({ start: 10, count: 2 });
    });

    it("falls back to the whole quantity in one batch when maxCycle is missing or invalid", () => {
        expect(motorCycleRange(9, undefined, 1, 2)).toEqual({ start: 0, count: 9 });
        expect(motorCycleRange(9, 0, 1, 2)).toEqual({ start: 0, count: 9 });
        expect(motorCycleRange(9, -1, 1, 2)).toEqual({ start: 0, count: 9 });
    });

    it("falls back to the whole quantity when there's only one cycle, even with maxCycle set", () => {
        expect(motorCycleRange(9, 5, 1, 1)).toEqual({ start: 0, count: 9 });
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

    it("prints only THIS cycle's batch of doors, not the whole order, when maxCycle splits it across cycles (the reported bug)", async () => {
        (fs.readFileSync as jest.Mock).mockImplementation((path: string) => {
            if (typeof path === "string" && path.includes("country-codes.json"))
                return sampleCountryCodes;
            return order604427Csv;
        });
        (fs.existsSync as jest.Mock).mockReturnValue(true);

        let inserted: any[] = [];
        const db = Object.assign(jest.fn(), {
            schema: { hasTable: jest.fn().mockResolvedValue(true) },
        });
        db.mockReturnValue({
            where: () => ({ first: () => thenable(null) }),
            insert: (row: any) => {
                inserted.push(row);
                return thenable(undefined);
            },
        });
        (getDb as jest.Mock).mockResolvedValue(db);

        const baseOrder = {
            ...mockOrderUpdate.order,
            workplace: "Motor",
            salesOrder: "604427",
            position: "020",
            quantity: 2,
            maxCycle: 1, // 1 door per cycle — a 2-door order needs 2 cycles
        };

        await handleLabelPrinting({
            ...mockOrderUpdate,
            order: baseOrder,
            cycleIndex: 1,
            totalCycles: 2,
        });
        const cycle1 = inserted.map((r) => r.package_type).sort();
        inserted = [];

        await handleLabelPrinting({
            ...mockOrderUpdate,
            order: baseOrder,
            cycleIndex: 2,
            totalCycles: 2,
        });
        const cycle2 = inserted.map((r) => r.package_type).sort();

        // Each cycle prints exactly one door's labels, and the two cycles
        // print DIFFERENT doors — not the same "all doors" batch twice,
        // which is what order.quantity alone (ignoring maxCycle) produced.
        expect(cycle1).toEqual(["Cube accessories 1/2", "Motor Cube 1/2"]);
        expect(cycle2).toEqual(["Cube accessories 2/2", "Motor Cube 2/2"]);
    });
});

describe("resolveTypeFilter — per-workplace label type narrowing (KM-SVM table)", () => {
    const HARDWARE = ["moutings", "lista_motor", "zavora", "triang. plate", "numbers", "t10_hw_kr", "t21_hw_kr", "t25_hw_kr", "t29_hw_kr", "t11_hw_kr", "t15_hw_kr"];
    const MOTOR = ["motor", "svet_mriz", "mot_prisl", "t29_mot", "ridici_jedn", "t15_mot", "mot_prisl2", "prisl3", "prisl4"];

    it("Hardware prints exactly its own types and none of Motor's", () => {
        const hw = resolveTypeFilter("Hardware")!;
        for (const type of HARDWARE) expect([type, hw(type)]).toEqual([type, true]);
        for (const type of MOTOR) expect([type, hw(type)]).toEqual([type, false]);
    });

    it("Motor prints exactly its own types and none of Hardware's", () => {
        const motor = resolveTypeFilter("Motor")!;
        for (const type of MOTOR) expect([type, motor(type)]).toEqual([type, true]);
        for (const type of HARDWARE) expect([type, motor(type)]).toEqual([type, false]);
    });

    it("the two lists together cover every type configured under KM-SVM, each in exactly one", () => {
        const config = JSON.parse(
            jest.requireActual("fs").readFileSync(require("path").join(__dirname, "../../../config/label-type-config.json"), "utf8"),
        );
        const svm: string[] = config.filter((e: any) => e.scanB === "KM-SVM ").map((e: any) => e.type);
        const hw = resolveTypeFilter("Hardware")!;
        const motor = resolveTypeFilter("Motor")!;
        for (const type of svm) expect([type, hw(type) !== motor(type)]).toEqual([type, true]);
    });
});

describe("resolveWorkplacePrinter — QR sticker language", () => {
    const keys = ["LABEL_PRINTER_LANG_HARDWARE", "LABEL_QR_PRINTER_LANG_HARDWARE"];
    const saved: Record<string, string | undefined> = {};
    beforeEach(() => keys.forEach((k) => { saved[k] = process.env[k]; delete process.env[k]; }));
    afterEach(() => keys.forEach((k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }));

    it("defaults to the workplace's own printer language", () => {
        process.env.LABEL_PRINTER_LANG_HARDWARE = "ezpl";
        expect(resolveWorkplacePrinter("Hardware")).toMatchObject({ lang: "ezpl", qrLang: "ezpl" });
    });

    it("lets a Godex keep EZPL barcode labels while sending its QR sticker as ZPL", () => {
        process.env.LABEL_PRINTER_LANG_HARDWARE = "ezpl";
        process.env.LABEL_QR_PRINTER_LANG_HARDWARE = "zpl";
        expect(resolveWorkplacePrinter("Hardware")).toMatchObject({ lang: "ezpl", qrLang: "zpl" });
    });
});

describe("selectRowsForCycle — single-cycle order", () => {
    it("keeps every box even though packageType reads 'hardware 3/5'", () => {
        const rows = parseSampleCsv(
            [1, 2, 3, 4, 5]
                .map(
                    (n) =>
                        `"moutings";"220286";"604523";"";"hardware ${n}/5";"010";"C${n}";"T${n}";"Z1";"0222";"4";"x";"19";"TMP.TXT";"";"c";"a";"b";"PL|Poland"`,
                )
                .join("\n"),
        );
        expect(selectRowsForCycle(rows, 1, 1)).toHaveLength(5);
    });
});

describe("parseTmpContent — QC requirement (00000040)", () => {
    // Same shape as a real TMP file line:
    // 740|00000040|Speciální technické požadavky |       n|Ne
    const tmp = (qc10: string, qc20: string) =>
        [
            "pozice|010",
            "992|06210610|Vedeni pro stitky             |      HL|High lift",
            `740|00000040|Specialni technicke pozadavky |       ${qc10}|x`,
            "pozice|020",
            "992|06210610|Vedeni pro stitky             |      VL|Vertical lift",
            `740|00000040|Specialni technicke pozadavky |       ${qc20}|x`,
        ].join("\n");

    it("reads j as required and n as not, per position section", () => {
        expect(parseTmpContent(tmp("j", "n"), "10").qcRequired).toBe(true);
        expect(parseTmpContent(tmp("j", "n"), "20").qcRequired).toBe(false);
    });

    it("is case-insensitive", () => {
        expect(parseTmpContent(tmp("J", "n"), "10").qcRequired).toBe(true);
    });

    it("is null when the position has no 00000040 line", () => {
        expect(parseTmpContent("pozice|010\n992|06210610|x|HL|y", "10").qcRequired).toBeNull();
    });
});
