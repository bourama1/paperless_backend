import fs from "fs";
import path from "path";
import net from "net";
import { getDb } from "../config/database";
import { OrderUpdate } from "./workstationService";

const LABEL_PRINT_TRIGGER = process.env.LABEL_PRINT_TRIGGER || "STARTED";
const PRINTER_HOST = process.env.LABEL_PRINTER_HOST || "";
const PRINTER_PORT = parseInt(process.env.LABEL_PRINTER_PORT || "9100", 10);
const COPIES_OVERRIDE = process.env.LABEL_PRINTER_COPIES ? parseInt(process.env.LABEL_PRINTER_COPIES, 10) : null;

const CSV_BASE_PATH =
    process.env.LABEL_CSV_BASE_PATH || "//TOCZ-FS2/510-TOCZ/300 Departments/999 Common/01-FFS-Test/Štítky";

const COUNTRY_CODES_PATH =
    process.env.LABEL_COUNTRY_CODES_PATH || path.join(__dirname, "../../config/country-codes.json");

let countryCodeMap: Record<string, string> = {};

function loadCountryCodes() {
    try {
        const raw = fs.readFileSync(COUNTRY_CODES_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        countryCodeMap = Object.fromEntries(
            Object.entries(parsed)
                .filter(([k]) => !k.startsWith("_"))
                .map(([k, v]) => [k.toLowerCase(), v]),
        ) as Record<string, string>;
        console.log(
            `[LABELS] Loaded ${Object.keys(countryCodeMap).length} country code mappings from ${COUNTRY_CODES_PATH}`,
        );
    } catch (err: any) {
        console.error(`[LABELS] Failed to load country codes from ${COUNTRY_CODES_PATH}: ${err.message}`);
    }
}

loadCountryCodes();

fs.watchFile(COUNTRY_CODES_PATH, { interval: 5000 }, () => {
    console.log("[LABELS] country-codes.json changed, reloading...");
    loadCountryCodes();
});

export interface LabelRow {
    labelType: string;
    customerName: string;
    salesOrder: string;
    packagePart: string;
    packageType: string;
    position: string;
    customerBarcode: string;
    toorsBarcode: string;
    orderNumber: string;
    customerNumber: string;
    route: string;
    countryAddress: string;
    weight: string;
    tmpFile: string;
    deliveryName: string;
    deliveryAddress: string;
    deliveryPostCode: string;
    deliveryCountry: string;
}

type CycleFilter = null | "first" | "last";

interface LabelTypeConfig {
    template: string;
    copies: number;
    cycleFilter: CycleFilter;
}

const LABEL_CONFIG: Record<string, LabelTypeConfig> = {
    section: { template: "aktualniCMD", copies: 4, cycleFilter: null },
    moutings: { template: "aktualniCMD", copies: 2, cycleFilter: "last" },
    motor: { template: "aktualniCMD", copies: 1, cycleFilter: "first" },
    lista_motor: { template: "aktualniCMD", copies: 1, cycleFilter: "last" },
    zavora: { template: "aktualniCMD", copies: 1, cycleFilter: "last" },
    "Man door": { template: "aktualniCMD", copies: 2, cycleFilter: null },
    "man door": { template: "aktualniCMD", copies: 2, cycleFilter: null },
    svet_mriz: { template: "aktualniCMD", copies: 1, cycleFilter: "first" },
    mot_prisl: { template: "aktualniCMD", copies: 1, cycleFilter: "first" },
    t50_ram: { template: "aktualniCMD", copies: 1, cycleFilter: null },
    t50_kri: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t51_pra: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t51_lev: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t51_pro: { template: "aktualniCMD", copies: 1, cycleFilter: null },
    t29_kri: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t29_r_hw: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t29_mot: { template: "aktualniCMD", copies: 1, cycleFilter: "first" },
    t21_spol: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t25_spol: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t71_md: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    rail: { template: "aktualniCMD", copies: 1, cycleFilter: null },
    "triang. plate": { template: "aktualniCMD", copies: 1, cycleFilter: "last" },
    "sleve profile": { template: "aktualniCMD", copies: 1, cycleFilter: null },
    strut: { template: "aktualniCMD", copies: 1, cycleFilter: null },
    springs: { template: "aktualniCMD", copies: 1, cycleFilter: null },
    numbers: { template: "aktualniCMD", copies: 1, cycleFilter: "last" },
    "rail + hw ext": { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t10_spol: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t10_hw_kr: { template: "aktualniCMDinter", copies: 1, cycleFilter: "last" },
    t21_hw_kr: { template: "aktualniCMDinter", copies: 1, cycleFilter: "last" },
    t25_hw_kr: { template: "aktualniCMDinter", copies: 1, cycleFilter: "last" },
    t29_hw_kr: { template: "aktualniCMDinter", copies: 1, cycleFilter: "last" },
    ridici_jedn: { template: "aktualniCMD", copies: 1, cycleFilter: "first" },
    t10_struct: { template: "aktualniCMDinter", copies: 1, cycleFilter: null },
    t15_kri: { template: "aktualniCMD", copies: 4, cycleFilter: null },
    t15_r: { template: "aktualniCMD", copies: 1, cycleFilter: null },
    t15_mot: { template: "aktualniCMD", copies: 1, cycleFilter: "first" },
    mot_prisl2: { template: "aktualniCMD", copies: 1, cycleFilter: "first" },
    prisl3: { template: "aktualniCMD", copies: 1, cycleFilter: "first" },
    prisl4: { template: "aktualniCMD", copies: 1, cycleFilter: "first" },
    t11_spol: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t11_hw_kr: { template: "aktualniCMDinter", copies: 1, cycleFilter: "last" },
    t15_r_hw: { template: "aktualniCMD", copies: 2, cycleFilter: null },
    t15_hw_kr: { template: "aktualniCMDinter", copies: 1, cycleFilter: "last" },
};

function resolveConfig(labelType: string): LabelTypeConfig {
    if (LABEL_CONFIG[labelType]) return LABEL_CONFIG[labelType]!;
    if (labelType.endsWith("_hw_kr")) return { template: "aktualniCMDinter", copies: 1, cycleFilter: "last" };
    return { template: "aktualniCMD", copies: 1, cycleFilter: null };
}

function buildCsvPath(salesOrder: string, position: string): string {
    const paddedPos = position.padStart(2, "0") + "0";
    return path.join(CSV_BASE_PATH, `${salesOrder} ${paddedPos}.csv`);
}

function readCsvFile(salesOrder: string, position: string): LabelRow[] {
    const csvPath = buildCsvPath(salesOrder, position);
    if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

    const raw = fs.readFileSync(csvPath, "latin1");
    const rows: LabelRow[] = [];

    for (const line of raw.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const c = trimmed.split(";").map((f) => f.replace(/^"|"$/g, "").trim());
        const labelType = c[0] ?? "";
        if (!labelType) continue;

        rows.push({
            labelType,
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
        });
    }

    console.log(`[LABELS] Read ${rows.length} rows from ${csvPath}`);
    return rows;
}

function padCustomerNumber(n: string): string {
    return n.replace(/\D/g, "").padStart(6, "0");
}

function splitLine(text: string, maxLen: number): [string, string] {
    if (text.length <= maxLen) return [text, ""];
    return [text.slice(0, maxLen), text.slice(maxLen)];
}

function countryCode(deliveryCountry: string): string {
    const key = deliveryCountry.trim();

    const beforePipe = key.split("|")[0]?.trim() ?? "";
    if (beforePipe.length === 2 && /^[A-Za-z]{2}$/.test(beforePipe)) {
        return beforePipe.toUpperCase();
    }

    if (countryCodeMap[key.toLowerCase()]) return countryCodeMap[key.toLowerCase()]!;

    console.warn(`[LABELS] Unknown deliveryCountry value "${key}" – add it to country-codes.json`);
    return beforePipe.slice(0, 2).toUpperCase() || key.slice(0, 2).toUpperCase();
}

function labelBorders(): string {
    return [
        "Lo,2,878,793,881",
        "Lo,2,870,793,871",
        "Lo,2,168,793,171",
        "Lo,2,160,793,161",
        "Lo,2,401,793,402",
        "Lo,2,330,793,333",
        "Lo,2,322,793,323",
        "Lo,398,171,399,322",
        "Lo,398,882,399,1033",
        "Lo,208,3,209,158",
        "Lo,140,332,141,400",
        "Lo,3,477,794,480",
        "Lo,3,469,794,470",
        "Lo,140,400,141,468",
    ].join("\n");
}

function ezplHeader(): string {
    return [
        "^Q130,3",
        "^W100",
        "^H5",
        "^P1",
        "^S2",
        "^AD",
        "^C1",
        "^R0",
        "~Q+0",
        "^O0",
        "^D0",
        "^E12",
        "~R255",
        "^L",
        "Dy2-me-dd",
        "Th:m:s",
    ].join("\n");
}

function generatePrimaryBlock(label: LabelRow): string {
    const pos3 = label.position.padStart(3, "0");
    const custNum = padCustomerNumber(label.customerNumber);
    const cc = countryCode(label.deliveryCountry);

    const [dName1, dName2] = splitLine(label.deliveryName.toUpperCase(), 20);

    let cName1 = label.customerName;
    let cName2 = "";
    if (label.customerName.includes("/")) {
        const idx = label.customerName.indexOf("/");
        cName1 = label.customerName.slice(0, idx + 1);
        cName2 = label.customerName.slice(idx + 1);
    } else {
        [cName1, cName2] = splitLine(label.customerName, 10);
    }

    return [
        ezplHeader(),
        labelBorders(),
        `BA3,473,181,1,3,100,0,3,${label.toorsBarcode}`,
        `BA3,479,893,1,3,100,0,3,${label.customerBarcode}`,
        `AE,22,164,2,2,0,0,${label.salesOrder}`,
        `AE,22,233,2,2,0,0,${pos3}`,
        `AE,151,345,1,1,0,0,${label.packageType}`,
        `AC,9,491,2,2,0,0,${dName1}`,
        `AC,9,569,2,2,0,0,${dName2}`,
        `AB,11,672,2,2,0,0,${label.deliveryAddress}`,
        `AB,11,741,2,2,0,0,${label.deliveryPostCode}`,
        `AB,11,809,2,2,0,0,${label.deliveryCountry}`,
        `AF,7,893,1,1,0,0,${cName1}`,
        `AF,7,969,1,1,0,0,${cName2}`,
        `AE,5,414,1,1,0,0,${custNum}`,
        `AE,151,413,1,1,0,0,${label.packagePart}`,
        `AE,58,38,2,2,0,0,${cc}`,
        "E",
    ].join("\n");
}

function generateEzpl(label: LabelRow, _template: string): Buffer {
    return Buffer.from(generatePrimaryBlock(label) + "\n", "latin1");
}

function sendToLabelPrinter(ezplData: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!PRINTER_HOST) {
            console.warn("[LABELS] LABEL_PRINTER_HOST not set – skipping print");
            return resolve();
        }
        const socket = new net.Socket();
        socket.connect(PRINTER_PORT, PRINTER_HOST, () => {
            socket.write(ezplData, (err) => {
                if (err) {
                    socket.destroy();
                    reject(err);
                } else {
                    socket.end();
                    resolve();
                }
            });
        });
        socket.on("error", (err) => {
            socket.destroy();
            reject(err);
        });
        socket.setTimeout(10000, () => {
            socket.destroy();
            reject(new Error("Label printer timed out"));
        });
    });
}

async function ensurePrintLogTable() {
    const db = await getDb();
    const exists = await db.schema.hasTable("label_print_log");
    if (!exists) {
        await db.schema.createTable("label_print_log", (table) => {
            table.increments("id").primary();
            table.string("order_id").notNullable();
            table.string("sales_order").notNullable();
            table.string("position").notNullable();
            table.string("label_type").notNullable();
            table.string("package_part").notNullable();
            table.string("package_type").notNullable();
            table.string("toors_barcode");
            table.integer("copies").notNullable().defaultTo(1);
            table.timestamp("printed_at").defaultTo(db.fn.now());
        });
    }
}

async function isAlreadyPrinted(orderId: string, row: LabelRow): Promise<boolean> {
    const db = await getDb();
    const hit = await db("label_print_log")
        .where({
            order_id: orderId,
            label_type: row.labelType,
            package_part: row.packagePart,
            package_type: row.packageType,
        })
        .first();
    return !!hit;
}

async function recordPrint(orderId: string, row: LabelRow, copies: number) {
    const db = await getDb();
    await db("label_print_log").insert({
        order_id: orderId,
        sales_order: row.salesOrder,
        position: row.position,
        label_type: row.labelType,
        package_part: row.packagePart,
        package_type: row.packageType,
        toors_barcode: row.toorsBarcode,
        copies,
    });
}

export async function handleLabelPrinting(update: OrderUpdate): Promise<void> {
    if (update.action !== LABEL_PRINT_TRIGGER) {
        console.log(`[LABELS] action=${update.action} – not trigger (${LABEL_PRINT_TRIGGER}), skip`);
        return;
    }
    if (update.order.workplace !== "Hardware") {
        console.log(`[LABELS] workplace=${update.order.workplace} – not Hardware, skip`);
        return;
    }

    await ensurePrintLogTable();

    const { order } = update;
    console.log(`[LABELS] Order ${order.productOrder} (${order.salesOrder}/${order.position})`);

    let labelRows: LabelRow[];
    try {
        labelRows = readCsvFile(order.salesOrder, order.position);
    } catch (err: any) {
        console.error(`[LABELS] ${err.message}`);
        return;
    }

    if (labelRows.length === 0) {
        console.warn(`[LABELS] No rows in CSV for order ${order.productOrder}`);
        return;
    }

    const { cycleIndex, totalCycles } = update;
    const isLastCycle = cycleIndex === totalCycles;
    console.log(`[LABELS] Cycle ${cycleIndex}/${totalCycles} (last=${isLastCycle})`);

    const cycleRows = labelRows.filter((row) => {
        const match = row.packageType.match(/(\d+)\s*\/\s*(\d+)/);
        if (match && parseInt(match[1]!, 10) !== cycleIndex) return false;

        const { cycleFilter } = resolveConfig(row.labelType);
        if (cycleFilter === "first") return cycleIndex === 1;
        if (cycleFilter === "last") return cycleIndex === totalCycles;
        return true;
    });

    console.log(
        `[LABELS] ${cycleRows.length} rows for cycle ${cycleIndex}/${totalCycles} (${labelRows.length} total in CSV)`,
    );

    let printed = 0;
    let skipped = 0;

    for (const row of cycleRows) {
        if (await isAlreadyPrinted(order._id, row)) {
            console.log(`[LABELS] SKIP already printed: ${row.labelType} ${row.packagePart} ${row.packageType}`);
            skipped++;
            continue;
        }

        const config = resolveConfig(row.labelType);
        const copies = COPIES_OVERRIDE ?? config.copies;

        try {
            const ezplData = generateEzpl(row, config.template);

            if (!PRINTER_HOST) {
                console.log(
                    `[LABELS] [DRY RUN] ${copies}x ${config.template} | ` +
                        `${row.labelType} | ${row.salesOrder}/${row.position} | ` +
                        `${row.packagePart} ${row.packageType} | ${row.customerName}`,
                );
            } else {
                for (let i = 0; i < copies; i++) {
                    await sendToLabelPrinter(ezplData);
                    if (copies > 1 && i < copies - 1) {
                        await new Promise((r) => setTimeout(r, 1000));
                    }
                }
            }

            await recordPrint(order._id, row, copies);
            printed++;
            console.log(
                `[LABELS] ${PRINTER_HOST ? "Printed" : "Dry-run"} ${copies}x ` +
                    `${config.template} – ${row.labelType} ${row.packagePart} ${row.packageType}`,
            );
        } catch (err: any) {
            console.error(`[LABELS] Error printing ${row.labelType}: ${err.message}`);
        }
    }

    console.log(`[LABELS] Done – printed: ${printed}, skipped: ${skipped}, total: ${labelRows.length}`);

    try {
        await handleQrSticker(update, labelRows);
    } catch (err: any) {
        console.error(`[QR] Error: ${err.message}`);
    }
}

const TMP_FILES_PATH =
    process.env.LABEL_TMP_FILES_PATH ||
    "//TOCZ-FS2/510-TOCZ/300 Departments/300 Technical Services/Dokumentace B/NACTENO";

const QR_IMAGES_PATH = process.env.LABEL_QR_IMAGES_PATH || "";
const QR_PRINTER = process.env.LABEL_QR_PRINTER || "";

const QR_CODE_MAP: Record<string, string> = {
    SL: "Indy_SL",
    HL: "Indy_HL",
    VL: "Indy_VL",
    "LL-DT": "Indy_LL-DT",
    "LL-I": "Indy_LL-I",
    "HL-T": "Indy_HL-T",
    "VL-T": "Indy_VL-T",
    "VL-TL": "Indy_VL-T_ECO",
    "LL-CE": "LL-CE",
    GSL: "Guardy_SL",
    "LHF-C": "Guardy_LHF-C",
    "LHR-C": "Guardy_LHR-C",
    "SL-GT": "GTR_SL",
    "HL-GT": "GTR_HL",
    "VL-GT": "GTR_VL",
    "EXT-B": "Guardy_EXT_Behind",
    "EXT-O": "Guardy_EXT_In",
};

interface TmpFileData {
    railType: string;
    doorCount: number;
    priceGroup: string;
}

function parseTmpFile(filePath: string, position: string): TmpFileData | null {
    if (!fs.existsSync(filePath)) {
        console.error(`[QR] TMP file not found: ${filePath}`);
        return null;
    }

    const raw = fs.readFileSync(filePath, "latin1");
    const lines = raw
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);

    const paddedPos = position.padStart(3, "0");
    let inSection = false;
    let railType = "";
    let doorCount = 0;
    let priceGroup = "";

    for (const line of lines) {
        const cols = line.split("|").map((c) => c.trim());

        if (cols[0]?.toLowerCase() === "pozice") {
            inSection = cols[1] === position || cols[1] === paddedPos;
            continue;
        }

        if (!inSection) continue;

        if (cols[1] === "6210610" && cols[3]) {
            railType = cols[3].trim();
        }

        if (cols[0] === "Objednáno" && cols[1]) {
            doorCount = parseInt(cols[1], 10) || 0;
        }

        if (cols[2]?.includes("Cenová skupina") && cols[3]) {
            priceGroup = cols[3].trim();
        }
    }

    if (!railType) {
        console.warn(`[QR] Could not find rail type (6210610) in ${filePath} for position ${position}`);
        return null;
    }

    return { railType, doorCount, priceGroup };
}

async function printQrPng(pngPath: string, copies: number): Promise<void> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const args = ["-n", String(copies)];
    if (QR_PRINTER) args.push("-d", QR_PRINTER);
    args.push(pngPath);

    console.log(`[QR] lp ${args.join(" ")}`);
    await execFileAsync("lp", args);
}

export async function handleQrSticker(update: OrderUpdate, labelRows: LabelRow[]): Promise<void> {
    const { order, cycleIndex, totalCycles } = update;

    if (cycleIndex !== totalCycles) return;

    const tmpFile = labelRows.find((r) => r.tmpFile?.toLowerCase().startsWith("tmp"))?.tmpFile;
    if (!tmpFile) {
        console.log("[QR] No TMP file reference in CSV rows, skipping QR sticker");
        return;
    }

    const tmpFilePath = path.join(TMP_FILES_PATH, tmpFile);
    console.log(`[QR] Reading TMP file: ${tmpFilePath}`);

    const data = parseTmpFile(tmpFilePath, order.position);
    if (!data) return;

    if (data.priceGroup === "C01") {
        console.log("[QR] Price group C01 – skipping QR sticker");
        return;
    }

    const qrName = QR_CODE_MAP[data.railType];
    if (!qrName) {
        console.warn(`[QR] Unknown rail type "${data.railType}" – no QR mapping found`);
        return;
    }

    if (!QR_IMAGES_PATH) {
        console.log(`[QR] [DRY RUN] Would print ${data.doorCount}x ${qrName}.png (rail: ${data.railType})`);
        return;
    }

    const pngPath = path.join(QR_IMAGES_PATH, `${qrName}.png`);
    if (!fs.existsSync(pngPath)) {
        console.error(`[QR] PNG not found: ${pngPath}`);
        return;
    }

    console.log(`[QR] Printing ${data.doorCount}x ${qrName}.png for rail type "${data.railType}"`);
    await printQrPng(pngPath, data.doorCount);
}
