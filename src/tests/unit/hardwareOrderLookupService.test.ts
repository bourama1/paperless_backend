// Set a stable fake base path before any imports run
process.env.PICKBYLIGHT_BASE_PATH = "D:\\PickByLight";

import fs from "fs";
import { resolveHardwareOrders } from "../../services/hardwareOrderLookupService";
import { getPartIds } from "../../services/motorOrderService";

jest.mock("fs", () => ({
    ...jest.requireActual("fs"),
    readdirSync: jest.fn(),
    readFileSync: jest.fn(),
    // File creation times — per-file values set by the "newest wins" tests.
    statSync: jest.fn().mockReturnValue({ birthtimeMs: 1, mtimeMs: 1 }),
    // No parts.xlsx in this test env — motorOrderService.getPartIds() then
    // fails open (every item treated as non-PTL), deterministically rather
    // than depending on whatever happens to be on the machine running this.
    existsSync: jest.fn().mockReturnValue(false),
}));
// Keep isKnownPtlPart's real (pure) implementation but let tests control
// getPartIds() directly — sidesteps mocking the xlsx file-loading path just
// to exercise the actual "is this item in the set" matching logic.
jest.mock("../../services/motorOrderService", () => ({
    ...jest.requireActual("../../services/motorOrderService"),
    getPartIds: jest.fn().mockReturnValue(new Set()),
}));

beforeEach(() => {
    jest.clearAllMocks();
    (getPartIds as jest.Mock).mockReturnValue(new Set());
});

const SAMPLE_FILE = {
    id: "Hardware (Indy)",
    projectNumber: "604618",
    salesOrder: "604594",
    productOrder: "230018",
    position: "10",
    customer: "000229",
    customerDesc: "Easilift Loading Systems Ltd.",
    quantity: 1,
    items: [],
};

function mockDirs(byDir: Record<string, string[]>) {
    (fs.readdirSync as jest.Mock).mockImplementation((dir: string) => {
        for (const [suffix, files] of Object.entries(byDir)) {
            if (dir.endsWith(suffix)) return files;
        }
        return [];
    });
}

describe("resolveHardwareOrders", () => {
    it("finds a matching file, reads productOrder and parses the hardware type from id", () => {
        mockDirs({ STANDARD: ["604594_10_230018_Hardware.json"] });
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(SAMPLE_FILE));

        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);

        const info = result.get("604594::10");
        expect(info).toBeDefined();
        expect(info?.productOrder).toBe("230018");
        expect(info?.hardwareType).toBe("Indy");
    });

    it("parses Guardy the same way", () => {
        mockDirs({ STANDARD: ["604594_10_230018_Hardware.json"] });
        (fs.readFileSync as jest.Mock).mockReturnValue(
            JSON.stringify({ ...SAMPLE_FILE, id: "Hardware (Guardy)" }),
        );

        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);
        expect(result.get("604594::10")?.hardwareType).toBe("Guardy");
    });

    it("checks SEMI and SPARE folders too, not just STANDARD", () => {
        mockDirs({ SPARE: ["604594_10_230018_Hardware.json"] });
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(SAMPLE_FILE));

        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);
        expect(result.get("604594::10")?.productOrder).toBe("230018");
    });

    describe("more than one file for the same sales order + position", () => {
        // Each file reads back as its own productOrder, so the result says
        // which file was picked.
        function mockFiles(files: Record<string, { birthtimeMs: number; mtimeMs?: number } | "unreadable">) {
            (fs.statSync as jest.Mock).mockImplementation((p: string) => {
                const entry = Object.entries(files).find(([name]) => p.endsWith(name))?.[1];
                return entry === "unreadable" ? { birthtimeMs: 9e12, mtimeMs: 9e12 } : { mtimeMs: 0, ...entry };
            });
            (fs.readFileSync as jest.Mock).mockImplementation((p: string) => {
                const [name, entry] = Object.entries(files).find(([n]) => p.endsWith(n))!;
                if (entry === "unreadable") throw new Error("EBUSY");
                return JSON.stringify({ ...SAMPLE_FILE, productOrder: name.split("_")[2] });
            });
        }
        afterEach(() => (fs.statSync as jest.Mock).mockReturnValue({ birthtimeMs: 1, mtimeMs: 1 }));

        it("takes the most recently created file, across folders — not the first or lowest number", () => {
            mockDirs({
                STANDARD: ["604594_10_230018_Hardware.json"],
                SPARE: ["604594_10_229000_Hardware.json"],
            });
            mockFiles({
                "604594_10_230018_Hardware.json": { birthtimeMs: 1000 },
                "604594_10_229000_Hardware.json": { birthtimeMs: 2000 }, // newer, despite the lower number
            });

            const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);

            expect(result.get("604594::10")?.productOrder).toBe("229000");
        });

        it("falls back to the modified time when the filesystem reports no creation time", () => {
            mockDirs({ STANDARD: ["604594_10_230018_Hardware.json", "604594_10_231000_Hardware.json"] });
            mockFiles({
                "604594_10_230018_Hardware.json": { birthtimeMs: 0, mtimeMs: 3000 },
                "604594_10_231000_Hardware.json": { birthtimeMs: 0, mtimeMs: 1000 },
            });

            const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);

            expect(result.get("604594::10")?.productOrder).toBe("230018");
        });

        it("uses the next newest file when the newest one can't be read", () => {
            mockDirs({ STANDARD: ["604594_10_231000_Hardware.json", "604594_10_230018_Hardware.json"] });
            mockFiles({
                "604594_10_231000_Hardware.json": "unreadable",
                "604594_10_230018_Hardware.json": { birthtimeMs: 1000 },
            });

            const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);

            expect(result.get("604594::10")?.productOrder).toBe("230018");
        });
    });

    it("returns an empty map when no file matches any requested pair", () => {
        mockDirs({ STANDARD: ["999999_99_111111_Hardware.json"] });
        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);
        expect(result.size).toBe(0);
    });

    it("ignores non-Hardware files in the same folder", () => {
        mockDirs({ STANDARD: ["604594_10_230018_Motor.json"] });
        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);
        expect(result.size).toBe(0);
        expect(fs.readFileSync).not.toHaveBeenCalled();
    });

    it("returns an empty map immediately when given no pairs, without touching the filesystem", () => {
        const result = resolveHardwareOrders([]);
        expect(result.size).toBe(0);
        expect(fs.readdirSync).not.toHaveBeenCalled();
    });

    it("skips pairs with a missing salesOrder or position", () => {
        mockDirs({ STANDARD: ["604594_10_230018_Hardware.json"] });
        const result = resolveHardwareOrders([
            { salesOrder: null, position: "10" },
            { salesOrder: "604594", position: undefined },
        ]);
        expect(result.size).toBe(0);
        expect(fs.readdirSync).not.toHaveBeenCalled();
    });

    it("fails open (no crash, no match) when a folder can't be listed", () => {
        (fs.readdirSync as jest.Mock).mockImplementation(() => {
            throw new Error("ENOENT: no such file or directory");
        });

        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);
        expect(result.size).toBe(0);
    });

    it("strips a leading UTF-8 BOM before parsing (real order files have one)", () => {
        mockDirs({ STANDARD: ["604594_10_230018_Hardware.json"] });
        (fs.readFileSync as jest.Mock).mockReturnValue("﻿" + JSON.stringify(SAMPLE_FILE));

        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);
        expect(result.get("604594::10")?.hardwareType).toBe("Indy");
    });

    it("captures the order's items as nonPtlItems (parts.xlsx isn't present in this test env, so everything fails open as non-PTL)", () => {
        mockDirs({ STANDARD: ["604594_10_230018_Hardware.json"] });
        const items = [
            { itemID: "X1", itemDesc: "Bracket", itemQuantity: 2, unit: "pcs" },
            { itemID: "X2", itemDesc: "Bolt", itemQuantity: 8, unit: "pcs" },
        ];
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({ ...SAMPLE_FILE, items }));

        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);
        expect(result.get("604594::10")?.nonPtlItems).toEqual(items);
    });

    it("returns an empty nonPtlItems array when the order file has no items", () => {
        mockDirs({ STANDARD: ["604594_10_230018_Hardware.json"] });
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(SAMPLE_FILE));

        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);
        expect(result.get("604594::10")?.nonPtlItems).toEqual([]);
    });

    it("does not flag an item as non-PTL when parts.xlsx only lists its left/right suffixed variants", () => {
        (getPartIds as jest.Mock).mockReturnValue(new Set(["T09-040-35-0031 L", "T09-040-35-0031 R", "PLAIN-001"]));
        mockDirs({ STANDARD: ["604594_10_230018_Hardware.json"] });
        const items = [
            { itemID: "T09-040-35-0031", itemDesc: "Pair bracket", itemQuantity: 1, unit: "pcs" },
            { itemID: "PLAIN-001", itemDesc: "Known part", itemQuantity: 1, unit: "pcs" },
            { itemID: "UNKNOWN-001", itemDesc: "Not in PTL", itemQuantity: 1, unit: "pcs" },
        ];
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify({ ...SAMPLE_FILE, items }));

        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);

        expect(result.get("604594::10")?.nonPtlItems).toEqual([items[2]]);
    });

    it("falls back to the filename's productOrder segment if the file has no productOrder field", () => {
        mockDirs({ STANDARD: ["604594_10_230018_Hardware.json"] });
        (fs.readFileSync as jest.Mock).mockReturnValue(
            JSON.stringify({ id: "Hardware (Indy)" }),
        );

        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);
        expect(result.get("604594::10")?.productOrder).toBe("230018");
    });
});
