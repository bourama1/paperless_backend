// Isolated test file for the EZPL -> ZPL translation (generateZpl), kept
// separate from labelPrintingService.test.ts so it doesn't need that file's
// fs/net mocking setup — generateZpl is a pure string-building function.
jest.mock("../../config/database");
jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return {
        ...actual,
        readFileSync: jest.fn((...args: any[]) => {
            if (typeof args[0] === "string" && args[0].includes("country-codes.json")) {
                return JSON.stringify({});
            }
            if (typeof args[0] === "string" && args[0].includes("label-type-config.json")) {
                return JSON.stringify([]);
            }
            throw new Error("ENOENT: no such file or directory");
        }),
        existsSync: jest.fn().mockReturnValue(true),
        watchFile: jest.fn(),
    };
});

import { generateZpl, LabelRow } from "../../services/labelPrintingService";

const baseRow: LabelRow = {
    labelType: "section",
    customerName: "Vrata Novak s.r.o.",
    salesOrder: "604657",
    packagePart: "K - 1/2",
    packageType: "V - 3/5",
    position: "20",
    customerBarcode: "CUST12345",
    toorsBarcode: "TOORS98765",
    orderNumber: "Z253065",
    customerNumber: "001336",
    route: "",
    countryAddress: "DE Germany",
    weight: "12.5",
    tmpFile: "",
    deliveryName: "Vabog BVBA",
    deliveryAddress: "Main street 1",
    deliveryPostCode: "1000",
    deliveryCountry: "DE|Germany",
};

const DPI = 203;

describe("generateZpl — primary (full) label", () => {
    it("wraps everything in a single ^XA...^XZ format", () => {
        const zpl = generateZpl(baseRow, "aktualniCMD", DPI).toString("ascii");
        expect(zpl.trimStart().startsWith("^XA")).toBe(true);
        // Exactly one label format for a plain (non outside-EU) row
        expect((zpl.match(/\^XA/g) ?? []).length).toBe(1);
        expect((zpl.match(/\^XZ/g) ?? []).length).toBe(1);
    });

    it("encodes both barcodes as Code 39 full ASCII (^B3) with the narrow/wide ratio from the EZPL source (1,3)", () => {
        const zpl = generateZpl(baseRow, "aktualniCMD", DPI).toString("ascii");
        expect(zpl).toContain("^BY1,3^B3N,N,100,Y,N^FDTOORS98765^FS");
        expect(zpl).toContain("^BY1,3^B3N,N,100,Y,N^FDCUST12345^FS");
    });

    it("positions barcodes at the same dot coordinates as the EZPL BA3 commands", () => {
        const zpl = generateZpl(baseRow, "aktualniCMD", DPI).toString("ascii");
        expect(zpl).toContain("^FO473,181^BY1,3");
        expect(zpl).toContain("^FO479,893^BY1,3");
    });

    it("converts font E (14pt) at 203dpi to 39 dots, scaled by the EZPL magnification factor", () => {
        const zpl = generateZpl(baseRow, "aktualniCMD", DPI).toString("ascii");
        // AE,22,164,2,2,... -> font E base = round(14*203/72) = 39, x2 mag = 78
        expect(zpl).toContain("^FO22,164^A0N,78,78^FD604657^FS");
    });

    it("scales font size proportionally to a different DPI", () => {
        const zpl = generateZpl(baseRow, "aktualniCMD", 300).toString("ascii");
        // round(14*300/72) = 58, x2 mag = 116
        expect(zpl).toContain("^FO22,164^A0N,116,116^FD604657^FS");
    });

    it("draws the fixed border lines as filled ^GB graphic boxes, preserving span and thickness", () => {
        const zpl = generateZpl(baseRow, "aktualniCMD", DPI).toString("ascii");
        // Lo,2,878,793,881 -> width=791 height=3 thickness=min(791,3)=3
        expect(zpl).toContain("^FO2,878^GB791,3,3^FS");
        // Lo,398,171,399,322 -> width=1 height=151 thickness=1 (vertical line)
        expect(zpl).toContain("^FO398,171^GB1,151,1^FS");
    });

    it("strips ZPL control characters (^ and ~) out of field data", () => {
        // No "/" in this name, so splitLine(...,10) splits it into two ^FD
        // fields ("Weird^Name" / "~Co") — check each is sanitized separately.
        const dirty = { ...baseRow, customerName: "Weird^Name~Co" };
        const zpl = generateZpl(dirty, "aktualniCMD", DPI).toString("ascii");
        expect(zpl).not.toContain("Weird^Name");
        expect(zpl).not.toContain("~Co");
        expect(zpl).toContain("^FDWeird Name^FS");
        expect(zpl).toContain("^FD Co^FS");
    });

    it("omits the weight field when weight is \"0\"", () => {
        const noWeight = { ...baseRow, weight: "0" };
        const zpl = generateZpl(noWeight, "aktualniCMD", DPI).toString("ascii");
        expect(zpl).not.toContain("kg^FS");
    });
});

describe("generateZpl — simple (aktualniCMDinter) label", () => {
    it("has no barcode fields (matches the EZPL simple block)", () => {
        const zpl = generateZpl(baseRow, "aktualniCMDinter", DPI).toString("ascii");
        expect(zpl).not.toContain("^B3");
        expect(zpl).toContain("INTERNAL PURPOSE");
    });
});

describe("generateZpl — outside-EU addendum", () => {
    it("appends a second ^XA...^XZ block for a non-EU country address", () => {
        // "US" is not in the module's hardcoded EU_COUNTRIES set
        const nonEu = { ...baseRow, countryAddress: "US New York" };
        const zpl = generateZpl(nonEu, "aktualniCMD", DPI).toString("ascii");
        expect((zpl.match(/\^XA/g) ?? []).length).toBe(2);
        expect(zpl).toContain("OUTSIDE EU");
    });
});
