import fs from "fs";
const {
    readCsvFile,
    parametryConfig,
    cycleFilterFromLastCycleNum,
    resolveConfig,
    generateEzpl,
} = require("../src/services/labelPrintingService");

function main() {
    const barcode = process.env.BARCODE || (process.argv[2] && process.argv[2].startsWith("K") ? process.argv[2] : undefined);
    if (!barcode) {
        console.error("Usage: npx ts-node scripts/generate-single-prn.ts <barcode> [output-path]");
        console.error("  or: set BARCODE environment variable");
        process.exit(1);
    }
    const outPath = process.argv[2] && !process.argv[2].startsWith("K") ? process.argv[2] : process.argv[3];

    const salesOrder = barcode.slice(-10, -4);
    const posRaw = barcode.slice(-3, -1);
    const position = String(parseInt(posRaw, 10));

    let allRows;
    try {
        allRows = readCsvFile(salesOrder, position);
    } catch (e: any) {
        console.error("CSV error:", e.message);
        process.exit(1);
    }

    const lastDigit = barcode.slice(-1);
    const prefix = barcode.slice(0, 7);

    const validTypes = new Set(parametryConfig.map((e: any) => e.type));
    const validRows = allRows.filter((r: any) => validTypes.has(r.labelType));

    const parts: string[] = [];

    for (const entry of parametryConfig) {
        if (!(entry.scanC === prefix || entry.scanB === prefix)) continue;

        const cf = cycleFilterFromLastCycleNum(entry.lastCycleNum);

        if (cf === "first" && lastDigit !== "1") continue;
        if (cf === "last" && lastDigit !== "0") continue;

        const copies = entry.copies;
        for (const row of validRows) {
            if (row.labelType !== entry.type) continue;

            for (let c = 0; c < copies; c++) {
                const config = resolveConfig(row.labelType);
                const primary = generateEzpl(row, config.template);
                parts.push(primary.toString("latin1"));

                if (entry.printSecondary === "Ano") {
                    const secondary = generateEzpl(row, "aktualniCMD");
                    parts.push(secondary.toString("latin1"));
                }
            }
        }
    }

    const full = parts.join("\n");
    const buf = Buffer.from(full, "latin1");

    if (outPath) {
        fs.writeFileSync(outPath, buf);
        console.log(`Written: ${outPath} (${parts.length} labels, ${buf.length} bytes)`);
    } else {
        process.stdout.write(buf);
    }
}

main();
process.exit(0);
