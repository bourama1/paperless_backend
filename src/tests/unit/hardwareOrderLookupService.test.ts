// Set a stable fake base path before any imports run
process.env.PICKBYLIGHT_BASE_PATH = "D:\\PickByLight";

import fs from "fs";
import { resolveHardwareOrders } from "../../services/hardwareOrderLookupService";

jest.mock("fs", () => ({
    ...jest.requireActual("fs"),
    readdirSync: jest.fn(),
    readFileSync: jest.fn(),
}));

beforeEach(() => {
    jest.clearAllMocks();
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

    it("falls back to the filename's productOrder segment if the file has no productOrder field", () => {
        mockDirs({ STANDARD: ["604594_10_230018_Hardware.json"] });
        (fs.readFileSync as jest.Mock).mockReturnValue(
            JSON.stringify({ id: "Hardware (Indy)" }),
        );

        const result = resolveHardwareOrders([{ salesOrder: "604594", position: "10" }]);
        expect(result.get("604594::10")?.productOrder).toBe("230018");
    });
});
