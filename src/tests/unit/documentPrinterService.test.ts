import {
    buildPrepLabelPdf,
    applyDuplexToBuffer,
    parsePbmRaw,
    pbmRawToZplLabel,
    buildPdfFromPngFitted,
    PngInfo,
} from "../../services/documentPrinterService";
import {
    code39Geometry,
    code39VectorOps,
    sanitizeCode39,
} from "../../utils/code39Barcode";

// buildPrepLabelPdf builds raw PDF bytes by hand (no PDF library — see its
// comment). No PDF-parsing library is available in this project, so these
// tests check the well-formedness markers a real PDF reader relies on
// (xref table size, /Count, page object count) rather than fully parsing
// it — enough to catch a broken object-numbering regression, which is the
// main risk in generalizing this from a fixed 5-object single page to a
// dynamic N-page layout.
describe("buildPrepLabelPdf", () => {
    // 1 catalog + 1 pages + 1 page + 1 content + 2 fonts (Helvetica regular
    // + bold) = 6 objects when the BC 3of9 font is NOT found. In the dev/CI
    // environment it isn't, so the barcode falls back to vector bars —
    // which need no extra objects.
    it("defaults to a single page with no cycle counter, matching the original one-box label", () => {
        const pdf = buildPrepLabelPdf("P1", "10", "Jan Novak").toString("latin1");

        expect(pdf.startsWith("%PDF-1.4")).toBe(true);
        expect(pdf).toContain("/Count 1");
        expect(pdf).not.toContain("BALENI");
        expect(pdf.match(/\d+ 0 obj/g)).toHaveLength(6);
    });

    it("prints one page per cycle, each labeled cycleIndex/totalCycles", () => {
        const pdf = buildPrepLabelPdf("P1", "10", "Jan Novak", 3).toString("latin1");

        expect(pdf).toContain("/Count 3");
        expect(pdf).toContain("(1/3)");
        expect(pdf).toContain("(2/3)");
        expect(pdf).toContain("(3/3)");
        // 1 catalog + 1 pages + 3 page objs + 3 content streams + 2 fonts = 10 objects
        expect(pdf.match(/\d+ 0 obj/g)).toHaveLength(10);
        // xref must list exactly one entry per object plus the free-list head
        const xrefMatch = pdf.match(/xref\n0 (\d+)\n/);
        expect(xrefMatch?.[1]).toBe("11");
    });

    it("keeps shared order/position/employee info identical across every page", () => {
        const pdf = buildPrepLabelPdf("P42", "99", "Petr Svoboda", 2).toString("latin1");

        // Twice per page: the big OBJEDNAVKA text and the barcode's
        // human-readable interpretation line.
        expect(pdf.match(/\(P42\)/g)).toHaveLength(4);
        expect(pdf.match(/\(99\)/g)).toHaveLength(2);
        expect(pdf.match(/Pripravil: Petr Svoboda/g)).toHaveLength(2);
    });

    it("sizes the page for the Godex EZ2250i label stock (100 × 130 mm)", () => {
        const pdf = buildPrepLabelPdf("P1", "10", "Jan Novak").toString("latin1");
        // 100 mm = 283.46 pt, 130 mm = 368.50 pt (1 mm = 72/25.4 pt)
        expect(pdf).toContain("/MediaBox [0 0 283.46 368.5]");
    });

    it("encodes the project number as a Code 39 barcode (vector fallback: bar rects + *-delimited human-readable line)", () => {
        const pdf = buildPrepLabelPdf("Z253065", "10", "Jan Novak").toString("latin1");

        // The barcode ops draw filled black rectangles...
        expect(pdf).toContain("0 0 0 rg");
        expect(pdf).toMatch(/re f\n/);
        // ...and the human-readable line under the bars shows the data
        // (without the * delimiters — those are only in the symbol).
        expect(pdf).toContain("(Z253065)");
    });

    it("sanitizes project numbers that contain characters outside the Code 39 alphabet", () => {
        const pdf = buildPrepLabelPdf("čč/12.5", "10", "Jan Novak").toString("latin1");

        // č is not encodable → replaced with '-'; '/' is valid Code 39.
        expect(pdf).toContain("(--/12.5)");
        // The raw, un-encoded text must not appear anywhere.
        expect(pdf).not.toContain("(čč/12.5)");
    });

    it("still produces a structurally valid PDF when the vector barcode is drawn", () => {
        // The q...Q transform around the vector bars must be balanced, or
        // Ghostscript/viewers reject the content stream.
        const pdf = buildPrepLabelPdf("P1", "10", "Jan Novak").toString("latin1");
        const contentMatch = pdf.match(/stream\n([\s\S]*?)\nendstream/);
        expect(contentMatch).not.toBeNull();
        const ops = contentMatch![1]!;
        expect(ops.split("q").length - 1).toBe(ops.split("Q").length - 1);
    });
});

// The vector Code 39 renderer must produce a spec-conformant symbol —
// these tests pin the invariants an actual scanner depends on.
describe("code39 vector encoding", () => {
    it("every character is 9 elements (5 bars + 4 spaces) with exactly 3 wide", () => {
        const chars = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%*";
        for (const ch of chars) {
            const geo = code39Geometry(ch, 1);
            // Last element in the returned list is the inter-character gap
            // (a narrow space), so the character itself is the 9 before it.
            const elements = geo.elementWidths.slice(0, 9);
            expect(elements).toHaveLength(9);
            const bars = elements.filter((_, i) => i % 2 === 0);
            const spaces = elements.filter((_, i) => i % 2 === 1);
            expect(bars).toHaveLength(5);
            expect(spaces).toHaveLength(4);
            expect(elements.filter((w) => w > 1)).toHaveLength(3);
        }
    });

    it("start and stop patterns are identical and flank the data", () => {
        const geo = code39Geometry("A1", 1);
        const first = geo.elementWidths.slice(0, 9).join(",");
        const last = geo.elementWidths.slice(-10, -1).join(",");
        expect(first).toBe(last); // * ... *
        expect(geo.text).toBe("*A1*");
    });

    it("wide elements are 2.5× narrow (the BC 3of9 Light ratio)", () => {
        const geo = code39Geometry("1", 2);
        for (const w of geo.elementWidths) {
            expect([2, 5]).toContain(w); // narrow=2, wide=2.5×2=5
        }
    });

    it("draws exactly one bar rect per bar element, alternating from a bar", () => {
        const { ops } = code39VectorOps("12", 10, 20, 50, 2);
        const rects = ops.match(/re f/g) ?? [];
        // "*" + "1" + "2" + "*" = 4 chars × 5 bars each = 20 bars
        expect(rects).toHaveLength(20);
        expect(ops).toMatch(/^q 0 0 0 rg\n/);
        expect(ops.endsWith("Q")).toBe(true);
    });

    it("sanitizeCode39 uppercases and replaces unsupported characters", () => {
        expect(sanitizeCode39("z-253_065a")).toBe("Z-253-065A");
        expect(sanitizeCode39("ěščřžýáíé")).toBe("---------");
        expect(sanitizeCode39("")).toBe("");
        expect(sanitizeCode39("abc$+/%. ")).toBe("ABC$+/%. ");
    });
});

// ─── duplex buffer injection ──────────────────────────────────────────────────

const FAKE_PCLXL = Buffer.from("\x1b E hello pclxl data", "ascii");
const FAKE_PCL5  = Buffer.from("\x1b E hello pcl5 data", "ascii");
const FAKE_PS    = Buffer.from("%!PS Adobe... data", "ascii");

describe("applyDuplexToBuffer", () => {
    describe("duplex disabled", () => {
        it("returns the buffer unchanged regardless of device", () => {
            for (const device of ["pxlmono", "pxlcolor", "ljet4", "ps2write"]) {
                const result = applyDuplexToBuffer(FAKE_PCLXL, device, false, "LONGEDGE");
                expect(result).toBe(FAKE_PCLXL); // exact same reference
            }
        });
    });

    describe("pxlmono (PCL-XL) duplex", () => {
        it("prepends a PJL header with DUPLEX=ON and BINDING=LONGEDGE", () => {
            const result = applyDuplexToBuffer(FAKE_PCLXL, "pxlmono", true, "LONGEDGE");
            const text = result.toString("ascii");
            expect(text).toMatch(/\x1b%-12345X/);
            expect(text).toContain("@PJL SET DUPLEX=ON");
            expect(text).toContain("@PJL SET BINDING=LONGEDGE");
            expect(text).toContain("@PJL ENTER LANGUAGE=PCLXL");
            expect(text.endsWith(FAKE_PCLXL.toString("ascii"))).toBe(true);
        });

        it("uses BINDING=SHORTEDGE when configured", () => {
            const result = applyDuplexToBuffer(FAKE_PCLXL, "pxlmono", true, "SHORTEDGE");
            const text = result.toString("ascii");
            expect(text).toContain("@PJL SET BINDING=SHORTEDGE");
        });

        it("produces a longer buffer than the original (header was prepended)", () => {
            const result = applyDuplexToBuffer(FAKE_PCLXL, "pxlmono", true, "LONGEDGE");
            expect(result.length).toBeGreaterThan(FAKE_PCLXL.length);
        });

        it("ends with the original PCL-XL payload unchanged", () => {
            const result = applyDuplexToBuffer(FAKE_PCLXL, "pxlmono", true, "LONGEDGE");
            const suffix = result.slice(result.length - FAKE_PCLXL.length);
            expect(suffix.equals(FAKE_PCLXL)).toBe(true);
        });

        it("pxlcolor uses the same PJL approach as pxlmono", () => {
            const result = applyDuplexToBuffer(FAKE_PCLXL, "pxlcolor", true, "LONGEDGE");
            const text = result.toString("ascii");
            expect(text).toContain("@PJL SET DUPLEX=ON");
            expect(text).toContain("@PJL ENTER LANGUAGE=PCLXL");
        });
    });

    describe("ljet4 (PCL5) duplex", () => {
        it("prepends ESC&l2S for long-edge duplex", () => {
            const result = applyDuplexToBuffer(FAKE_PCL5, "ljet4", true, "LONGEDGE");
            const text = result.toString("ascii");
            expect(text.startsWith("\x1b&l2S")).toBe(true);
            expect(text.endsWith(FAKE_PCL5.toString("ascii"))).toBe(true);
        });

        it("prepends ESC&l1S for short-edge (landscape) duplex", () => {
            const result = applyDuplexToBuffer(FAKE_PCL5, "ljet4", true, "SHORTEDGE");
            const text = result.toString("ascii");
            expect(text.startsWith("\x1b&l1S")).toBe(true);
        });
    });

    describe("ps2write (PostScript) duplex", () => {
        it("returns the buffer unchanged — duplex is handled by gs args, not byte prepending", () => {
            const result = applyDuplexToBuffer(FAKE_PS, "ps2write", true, "LONGEDGE");
            expect(result).toBe(FAKE_PS);
        });
    });
});

// ─── Zebra ZPL rendering (raster) ───────────────────────────────────────────

/** Hand-builds a raw PBM (P4) buffer the same shape Ghostscript's pbmraw
 * device would produce — magic, "width height" header, then packed 1bpp
 * row data (MSB-first, each row padded to a whole byte). */
function makePbmRaw(width: number, height: number, rows: number[]): Buffer {
    return Buffer.concat([
        Buffer.from(`P4\n${width} ${height}\n`, "ascii"),
        Buffer.from(rows),
    ]);
}

describe("parsePbmRaw", () => {
    it("parses width/height and the packed pixel data", () => {
        // 8×2 image: row1 = 11110000, row2 = 00001111
        const pbm = makePbmRaw(8, 2, [0xf0, 0x0f]);
        const { width, height, data } = parsePbmRaw(pbm);
        expect(width).toBe(8);
        expect(height).toBe(2);
        expect(data.equals(Buffer.from([0xf0, 0x0f]))).toBe(true);
    });

    it("pads each row to a whole byte for widths not a multiple of 8", () => {
        // 10×1 image → 2 bytes/row even though only 10 bits are meaningful
        const pbm = makePbmRaw(10, 1, [0xff, 0xc0]);
        const { width, height, data } = parsePbmRaw(pbm);
        expect(width).toBe(10);
        expect(height).toBe(1);
        expect(data.length).toBe(2);
    });

    it("throws on a buffer that isn't a raw PBM (P4)", () => {
        expect(() => parsePbmRaw(Buffer.from("P5\n8 2\n", "ascii"))).toThrow();
    });
});

function fakePng(width: number, height: number): PngInfo {
    return {
        width,
        height,
        bitDepth: 8,
        colorType: 0, // gray — simplest valid /ColorSpace, content doesn't matter for these tests
        idat: Buffer.from([1, 2, 3]),
        palette: undefined,
    };
}

// The PNG's own "cm" transform matrix: `q <w> 0 0 <h> <x> <y> cm /Im0 Do Q`.
function extractCm(pdf: string): { w: number; h: number; x: number; y: number } {
    const m = /q ([\d.]+) 0 0 ([\d.]+) ([\d.]+) ([\d.]+) cm/.exec(pdf);
    if (!m) throw new Error("cm transform not found in PDF content stream");
    return { w: Number(m[1]), h: Number(m[2]), x: Number(m[3]), y: Number(m[4]) };
}

describe("buildPdfFromPngFitted", () => {
    // Label stock size in points, same as PREP_LABEL_PAGE_WIDTH_PT/HEIGHT_PT.
    const PAGE_W = 283.46;
    const PAGE_H = 368.5;

    it("sets the MediaBox to the fixed page size, not the image's own size", () => {
        const pdf = buildPdfFromPngFitted(fakePng(200, 100), PAGE_W, PAGE_H).toString("latin1");
        expect(pdf).toContain(`/MediaBox [0 0 ${PAGE_W.toFixed(2)} ${PAGE_H.toFixed(2)}]`);
    });

    it("scales a wide image down to the page width and centers it vertically", () => {
        // 200×100 px @ 96dpi = 150×75 pt — wider (relative to height) than the
        // page, so width is the constraining dimension.
        const pdf = buildPdfFromPngFitted(fakePng(200, 100), PAGE_W, PAGE_H).toString("latin1");
        const { w, h, x, y } = extractCm(pdf);

        expect(w).toBeCloseTo(PAGE_W, 1); // fills the full width
        expect(h).toBeLessThan(PAGE_H); // doesn't fill the height
        expect(x).toBeCloseTo(0, 1); // flush left/right (no horizontal margin)
        expect(y).toBeCloseTo((PAGE_H - h) / 2, 1); // centered vertically
        expect(w / h).toBeCloseTo(200 / 100, 2); // aspect ratio preserved
    });

    it("scales a tall image down to the page height and centers it horizontally", () => {
        // 100×200 px @ 96dpi = 75×150 pt — taller (relative to width) than
        // the page, so height is the constraining dimension.
        const pdf = buildPdfFromPngFitted(fakePng(100, 200), PAGE_W, PAGE_H).toString("latin1");
        const { w, h, x, y } = extractCm(pdf);

        expect(h).toBeCloseTo(PAGE_H, 1); // fills the full height
        expect(w).toBeLessThan(PAGE_W); // doesn't fill the width
        expect(y).toBeCloseTo(0, 1);
        expect(x).toBeCloseTo((PAGE_W - w) / 2, 1); // centered horizontally
        expect(w / h).toBeCloseTo(100 / 200, 2);
    });
});

describe("pbmRawToZplLabel", () => {
    it("wraps the bitmap in a ^XA...^XZ label sized via ^PW/^LL", () => {
        const pbm = makePbmRaw(8, 2, [0xf0, 0x0f]);
        const zpl = pbmRawToZplLabel(pbm).toString("ascii");

        expect(zpl).toContain("^XA");
        expect(zpl).toContain("^PW8");
        expect(zpl).toContain("^LL2");
        expect(zpl.trim().endsWith("^XZ")).toBe(true);
    });

    it("hex-encodes the packed pixel bytes directly into ^GFA (same bit convention, no inversion)", () => {
        const pbm = makePbmRaw(8, 2, [0xf0, 0x0f]);
        const zpl = pbmRawToZplLabel(pbm).toString("ascii");
        // 1 byte/row × 2 rows = 2 total bytes, hex "F00F"
        expect(zpl).toContain("^GFA,2,2,1,F00F");
    });

    it("computes byte-per-row / total-byte counts correctly for a wider bitmap", () => {
        // 16×3: 2 bytes/row, 6 bytes total
        const pbm = makePbmRaw(16, 3, [0xff, 0x00, 0x0f, 0xf0, 0xaa, 0x55]);
        const zpl = pbmRawToZplLabel(pbm).toString("ascii");
        expect(zpl).toContain("^GFA,6,6,2,FF000FF0AA55");
    });
});

// PNG IDAT data is per-scanline filtered; embedding it in a PDF without a
// PNG predictor makes readers decode it as noise (QR printed as a black
// square with white specks).
describe("PNG-in-PDF embedding", () => {
    const png = (colorType: number): PngInfo => ({
        width: 245,
        height: 245,
        bitDepth: 8,
        colorType,
        idat: Buffer.from([0x78, 0x9c]),
        palette: undefined,
    });

    it("declares the PNG predictor with matching colors/columns for RGB", () => {
        const pdf = buildPdfFromPngFitted(png(2), 283.46, 368.5).toString("latin1");
        expect(pdf).toContain(
            "/DecodeParms << /Predictor 15 /Colors 3 /BitsPerComponent 8 /Columns 245 >>",
        );
    });

    it("uses one color component for grayscale", () => {
        const pdf = buildPdfFromPngFitted(png(0), 283.46, 368.5).toString("latin1");
        expect(pdf).toContain("/Predictor 15 /Colors 1 ");
    });
});
