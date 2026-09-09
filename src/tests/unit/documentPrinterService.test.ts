import { buildPrepLabelPdf } from "../../services/documentPrinterService";
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
