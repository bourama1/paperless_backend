// Set a stable fake base path before any imports run
process.env.PICKBYLIGHT_BASE_PATH = "D:\\PickByLight";
process.env.PTL_PARTS_XLSX_PATH = "D:\\PickByLight\\parts.xlsx";

import fs from "fs";
import {
    resolveOrderFilePath,
    readOrderFile,
    isNonPtlOrder,
    isKnownPtlPart,
    checkMotorOrderForAutoFinish,
    clearPartsCache,
} from "../../services/motorOrderService";

jest.mock("fs", () => ({
    ...jest.requireActual("fs"),
    existsSync: jest.fn(),
    readFileSync: jest.fn(),
}));

// jest.mock is hoisted before variable declarations, so we can't reference
// mockSheetToJson in the factory. Use jest.fn() inline and grab a reference
// to it via the mocked module instead.
jest.mock("xlsx", () => ({
    readFile: jest.fn(),
    utils: { sheet_to_json: jest.fn() },
}));
import * as XLSXMock from "xlsx";
const mockSheetToJson = XLSXMock.utils.sheet_to_json as jest.Mock;

beforeEach(() => {
    jest.clearAllMocks();
    clearPartsCache(); // Reset the in-memory parts cache between tests
});

const SAMPLE_ORDER = {
    id: "Motor (Guardy)",
    projectNumber: "604760",
    salesOrder: "604736",
    productOrder: "230910",
    position: "10",
    quantity: 1,
    maxCycle: 5,
    items: [
        { itemID: "T09-051-10-0045", itemDesc: "motor", itemQuantity: 1, unit: "pcs" },
        { itemID: "T09-010-80-0023", itemDesc: "label", itemQuantity: 1, unit: "pcs" },
    ],
};

const SAMPLE_UPDATE: any = {
    _id: "update1",
    datetime: "2026-09-10T11:21:38.550Z",
    action: "STARTED",
    cycleIndex: 1,
    totalCycles: 1,
    order: {
        _id: "order1",
        productOrder: "230910",
        projectNumber: "604760",
        salesOrder: "604736",
        position: "10",
        workplace: "Motor",
        filename: "/home/pickalvat/Data/order_data/PRODUCED/STANDARD/604736_10_230910_Motor.json",
        quantity: 1,
        maxCycle: 5,
        type: "STANDARD",
        schedule: "",
        customer: "000504",
        customerDesc: "Vrata Novák s.r.o.",
        productDesc: "Motor (Guardy)",
        createdAt: "",
        updatedAt: "",
    },
};

function mockPartsXlsx(ids: string[]) {
    (fs.existsSync as jest.Mock).mockReturnValue(true);
    (XLSXMock.readFile as jest.Mock).mockReturnValue({ SheetNames: ["Sheet1"], Sheets: { Sheet1: {} } });
    mockSheetToJson.mockReturnValue([["ItemID"], ...ids.map((id) => [id])]);
}

describe("resolveOrderFilePath", () => {
    const LINUX_PATH = "/home/pickalvat/Data/order_data/PRODUCED/STANDARD/604736_10_230910_Motor.json";

    it("returns the primary path when it exists", () => {
        (fs.existsSync as jest.Mock).mockImplementation((p: string) => !p.includes("HISTORY"));
        const result = resolveOrderFilePath(LINUX_PATH);
        expect(result).not.toBeNull();
        expect(result).toContain("PRODUCED");
        expect(result).not.toContain("HISTORY");
    });

    it("falls back to HISTORY\\OK path when primary doesn't exist", () => {
        (fs.existsSync as jest.Mock).mockImplementation((p: string) => p.includes("HISTORY"));
        const result = resolveOrderFilePath(LINUX_PATH);
        expect(result).not.toBeNull();
        expect(result).toContain("HISTORY");
        expect(result).toContain("OK");
    });

    it("returns null when neither path exists", () => {
        (fs.existsSync as jest.Mock).mockReturnValue(false);
        expect(resolveOrderFilePath(LINUX_PATH)).toBeNull();
    });
});

describe("readOrderFile", () => {
    it("parses a valid order JSON file", () => {
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(SAMPLE_ORDER));
        const result = readOrderFile("/some/path.json");
        expect(result?.productOrder).toBe("230910");
        expect(result?.items).toHaveLength(2);
    });

    it("returns null and doesn't throw on invalid JSON", () => {
        (fs.readFileSync as jest.Mock).mockImplementation(() => { throw new Error("ENOENT"); });
        expect(readOrderFile("/some/missing.json")).toBeNull();
    });

    it("strips a leading UTF-8 BOM before parsing (real order files have one)", () => {
        (fs.readFileSync as jest.Mock).mockReturnValue("﻿" + JSON.stringify(SAMPLE_ORDER));
        const result = readOrderFile("/some/path.json");
        expect(result?.productOrder).toBe("230910");
    });
});

describe("isNonPtlOrder", () => {
    it("returns true (non-PTL) when none of the order items appear in parts.xlsx", () => {
        mockPartsXlsx(["SOME-OTHER-PART-001", "SOME-OTHER-PART-002"]);
        expect(isNonPtlOrder(SAMPLE_ORDER)).toBe(true);
    });

    it("returns false (normal PTL) when at least one item is found in parts.xlsx", () => {
        mockPartsXlsx(["T09-051-10-0045", "SOMETHING-ELSE"]);
        expect(isNonPtlOrder(SAMPLE_ORDER)).toBe(false);
    });

    it("returns true when parts.xlsx is missing (fail-safe: don't block orders)", () => {
        (fs.existsSync as jest.Mock).mockReturnValue(false);
        expect(isNonPtlOrder(SAMPLE_ORDER)).toBe(true);
    });

    it("returns false (normal PTL) when an item is only listed as a left/right pair", () => {
        // parts.xlsx has no bare "T09-051-10-0045", only the suffixed
        // variants — the part is still handled by PTL, just stocked as a pair.
        mockPartsXlsx(["T09-051-10-0045 L", "T09-051-10-0045 R"]);
        expect(isNonPtlOrder(SAMPLE_ORDER)).toBe(false);
    });
});

describe("isKnownPtlPart", () => {
    it("matches an exact id", () => {
        const partIds = new Set(["T09-040-35-0031"]);
        expect(isKnownPtlPart(partIds, "T09-040-35-0031")).toBe(true);
    });

    it("matches a bare id against its left/right suffixed variants in parts.xlsx", () => {
        const partIds = new Set(["T09-040-35-0031 L", "T09-040-35-0031 R"]);
        expect(isKnownPtlPart(partIds, "T09-040-35-0031")).toBe(true);
    });

    it("still returns false for a genuinely unknown id", () => {
        const partIds = new Set(["T09-040-35-0031 L", "T09-040-35-0031 R"]);
        expect(isKnownPtlPart(partIds, "T09-999-99-9999")).toBe(false);
    });

    it("trims the id before matching", () => {
        const partIds = new Set(["T09-040-35-0031"]);
        expect(isKnownPtlPart(partIds, "  T09-040-35-0031  ")).toBe(true);
    });
});

describe("checkMotorOrderForAutoFinish", () => {
    it("returns a synthetic FINISHED event for a non-PTL order", async () => {
        (fs.existsSync as jest.Mock).mockImplementation((p: string) => !p.includes("HISTORY"));
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(SAMPLE_ORDER));
        mockPartsXlsx(["UNRELATED-PART"]);

        const result = await checkMotorOrderForAutoFinish(SAMPLE_UPDATE);

        expect(result).not.toBeNull();
        expect(result?.action).toBe("FINISHED");
        expect(result?.order._id).toBe(SAMPLE_UPDATE.order._id);
        expect(result?._id).toMatch(/^synthetic_finish_/);
    });

    it("returns null for a normal PTL order (item found in parts.xlsx)", async () => {
        (fs.existsSync as jest.Mock).mockImplementation((p: string) => !p.includes("HISTORY"));
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(SAMPLE_ORDER));
        mockPartsXlsx(["T09-051-10-0045"]);

        const result = await checkMotorOrderForAutoFinish(SAMPLE_UPDATE);
        expect(result).toBeNull();
    });

    it("returns null gracefully when the order file is not found", async () => {
        (fs.existsSync as jest.Mock).mockReturnValue(false);
        const result = await checkMotorOrderForAutoFinish(SAMPLE_UPDATE);
        expect(result).toBeNull();
    });

    it("returns null when the update has no filename", async () => {
        const noFilename = { ...SAMPLE_UPDATE, order: { ...SAMPLE_UPDATE.order, filename: "" } };
        expect(await checkMotorOrderForAutoFinish(noFilename)).toBeNull();
    });
});
