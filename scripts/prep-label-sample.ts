// Temporary verification script — generates sample prep labels for a
// Ghostscript parse/render check, then deletes itself (run via bash).
import fs from "fs";
import { buildPrepLabelPdf } from "../src/services/documentPrinterService";

const outDir = path_resolve();
function path_resolve(): string {
    return process.cwd();
}

fs.mkdirSync("test-fixtures/output", { recursive: true });
fs.writeFileSync(
    "test-fixtures/output/prep-label-single.pdf",
    buildPrepLabelPdf("Z253065", "10", "Jan Novak"),
);
fs.writeFileSync(
    "test-fixtures/output/prep-label-multi.pdf",
    buildPrepLabelPdf("WP1055812/WO1010610", "300", "Petr Svoboda", 3),
);
console.log("written: test-fixtures/output/prep-label-single.pdf, prep-label-multi.pdf");
