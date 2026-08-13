import { buildPrepLabelPdf } from "../../services/documentPrinterService";

// buildPrepLabelPdf builds raw PDF bytes by hand (no PDF library — see its
// comment). No PDF-parsing library is available in this project, so these
// tests check the well-formedness markers a real PDF reader relies on
// (xref table size, /Count, page object count) rather than fully parsing
// it — enough to catch a broken object-numbering regression, which is the
// main risk in generalizing this from a fixed 5-object single page to a
// dynamic N-page layout.
describe("buildPrepLabelPdf", () => {
    it("defaults to a single page with no cycle counter, matching the original one-box label", () => {
        const pdf = buildPrepLabelPdf("P1", "10", "Jan Novak").toString("latin1");

        expect(pdf.startsWith("%PDF-1.4")).toBe(true);
        expect(pdf).toContain("/Count 1");
        expect(pdf).not.toContain("BALENI");
        // 1 catalog + 1 pages + 1 page + 1 content + 1 font = 5 objects
        expect(pdf.match(/\d+ 0 obj/g)).toHaveLength(5);
    });

    it("prints one page per cycle, each labeled cycleIndex/totalCycles", () => {
        const pdf = buildPrepLabelPdf("P1", "10", "Jan Novak", 3).toString("latin1");

        expect(pdf).toContain("/Count 3");
        expect(pdf).toContain("(1/3)");
        expect(pdf).toContain("(2/3)");
        expect(pdf).toContain("(3/3)");
        // 1 catalog + 1 pages + 3 page objs + 3 content streams + 1 font = 9 objects
        expect(pdf.match(/\d+ 0 obj/g)).toHaveLength(9);
        // xref must list exactly one entry per object plus the free-list head
        const xrefMatch = pdf.match(/xref\n0 (\d+)\n/);
        expect(xrefMatch?.[1]).toBe("10");
    });

    it("keeps shared order/position/employee info identical across every page", () => {
        const pdf = buildPrepLabelPdf("P42", "99", "Petr Svoboda", 2).toString("latin1");

        expect(pdf.match(/\(P42\)/g)).toHaveLength(2);
        expect(pdf.match(/\(99\)/g)).toHaveLength(2);
        expect(pdf.match(/Pripravil: Petr Svoboda/g)).toHaveLength(2);
    });
});
