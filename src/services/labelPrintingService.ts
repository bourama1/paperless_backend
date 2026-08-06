/**
 * labelPrintingService.ts
 *
 * Replicates the hardware.xlsm VBA macro logic.
 *
 * Flow:
 *  1. Triggered by /order-update (STARTED or FINISHED). The workplace is
 *     mapped to a scan-prefix group (door-leaf/wing, hardware/motor, or
 *     rail/track) via WORKPLACE_TO_SCAN_PREFIX below; unrecognized
 *     workplaces are skipped and logged.
 *  2. Reads the semicolon-delimited CSV from the network share:
 *       \\TOCZ-FS2\510-TOCZ\300 Departments\999 Common\01-FFS-Test\Stítky\{salesOrder} {position}.csv
 *  3. For each label row generates EZPL directly (no .prn template files needed)
 *  4. Sends raw EZPL to the Godex EZ2250i via TCP port 9100
 *  5. Logs every printed label to label_print_log (duplicate guard)
 *
 * Runs on Windows Server — network paths and printing use native Windows
 * mechanisms (UNC paths, cmd.exe copy), exactly like the original Excel macro.
 *
 * Environment variables (.env):
 *   LABEL_PRINT_TRIGGER    STARTED | FINISHED            (default: STARTED)
 *   LABEL_CSV_BASE_PATH    UNC path to the Štítky folder on TOCZ-FS2
 *   LABEL_PRINTER_UNC_PATH UNC path to the printer share, e.g. \\\\tocz2420311\\GodexEZ2250i
 *   LABEL_PRINTER_HOST     (fallback) IP of the Godex for direct TCP printing
 *   LABEL_PRINTER_PORT     (fallback) raw TCP port         (default: 9100)
 *   LABEL_PRINTER_COPIES   override copy count             (optional)
 */

import fs from "fs";
import path from "path";
import net from "net";
import { getDb } from "../config/database";
import { OrderUpdate } from "./workstationService";
import {
    DOCUMENTS_PRINTER_HOST,
    printPngFile,
} from "./documentPrinterService";

// EU countries that use the 47-line simplified label (from parametry AM:AN)
const EU_COUNTRIES = new Set([
    "AT",
    "BE",
    "BG",
    "HR",
    "CY",
    "CZ",
    "DK",
    "EE",
    "FI",
    "FR",
    "DE",
    "GR",
    "HU",
    "IE",
    "IT",
    "LV",
    "LT",
    "LU",
    "MT",
    "NL",
    "PL",
    "PT",
    "RO",
    "SK",
    "SI",
    "ES",
    "SE",
]);

// ─── workplace → scan-prefix mapping ───────────────────────────────────────────
//
// The VBA macro's typKodu came from a physical barcode scan (first 7 chars),
// which really identifies which of 3 packages is being labeled: door-leaf/wing
// (K"žSVK ), hardware/motor (K"žSV" ), or rail/track (K"žSVV ). The automated
// /order-update API has no barcode — instead, order.workplace identifies which
// production station just finished, so we map workplace names to the same 3
// groups here.
//
// Mapping derived from the parametry sheet's own translation table
// (columns U/W/X), cross-checked against live production logs:
//   - "Hardware", "Předmontáž optolišty"                       → hardware/motor
//   - "Předpříprava hřídele" (seen in logs as "PredHridel"),
//     "Mandoor", "2KV", "Balírna (křídlo)", "Křídlo"            → door-leaf/wing
//   - "Vedení", "Vedení INDY", "Vedení GUARDY"                 → rail/track
// "Falešný překlad" ("fake/dummy translation") is a spreadsheet test entry,
// not a real workplace, and is intentionally excluded.
//
// CAUTION: only "Hardware" and "PredHridel" have been confirmed against real
// production payloads so far. The rest are best-effort transliterations of
// the Czech station names in the spreadsheet. Any workplace that doesn't
// normalize to a known key is logged loudly (not silently skipped) so the
// mapping can be corrected once more real workplace names are seen.
const SCAN_PREFIX = {
    KRIDLO: 'K"žSVK ', // door-leaf / wing
    HARDWARE: 'K"žSV" ', // hardware / motor
    VEDENI: 'K"žSVV ', // rail / track
} as const;

export function normalizeWorkplace(name: string): string {
    return name
        .normalize("NFD")
        .replace(/[\u0300-\u036f]/g, "") // strip diacritics
        .replace(/[^a-zA-Z0-9]/g, "") // strip spaces/punctuation
        .toLowerCase();
}

const WORKPLACE_TO_SCAN_PREFIX: Record<string, string> = {
    hardware: SCAN_PREFIX.HARDWARE,
    predmontazoptolisty: SCAN_PREFIX.HARDWARE,
    motor: SCAN_PREFIX.HARDWARE, // "Motor" workplace uses the hardware/motor scan prefix

    predpripravahridele: SCAN_PREFIX.KRIDLO, // full Czech name
    predhridel: SCAN_PREFIX.KRIDLO, // "PredHridel" as logged by production
    mandoor: SCAN_PREFIX.KRIDLO,
    "2kv": SCAN_PREFIX.KRIDLO,
    balirnakridlo: SCAN_PREFIX.KRIDLO,
    kridlo: SCAN_PREFIX.KRIDLO,

    vedeni: SCAN_PREFIX.VEDENI,
    vedeniindy: SCAN_PREFIX.VEDENI,
    vedeniguardy: SCAN_PREFIX.VEDENI,
};

function resolveScanPrefix(workplace: string): string | undefined {
    return WORKPLACE_TO_SCAN_PREFIX[normalizeWorkplace(workplace)];
}

// ─── per-workplace type narrowing ──────────────────────────────────────────
//
// "Motor" and "Hardware" (and "Předmontáž optolišty") all share the same
// SCAN_PREFIX.HARDWARE group, because in the original barcode-driven flow
// they were one physical package. Now that printing is triggered per real
// production station, they need separate label subsets even though they
// resolve to the same scan prefix.
//
// Confirmed against label-type-config.json: of the 20 types under
// SCAN_PREFIX.HARDWARE, the "*_hw_kr" suffixed ones (t10_hw_kr, t21_hw_kr,
// t25_hw_kr, t29_hw_kr, t11_hw_kr, t15_hw_kr) are the hardware+door-leaf
// combo sticker printed at the Hardware station; every other type in that
// group (motor, mot_prisl, lista_motor, zavora, ...) belongs to Motor.
//
// Workplaces not listed here get every type that matches their scan prefix,
// unfiltered — this only narrows within a scan-prefix group that's shared
// by more than one workplace.
const WORKPLACE_TYPE_FILTER: Record<string, (labelType: string) => boolean> =
    {
        motor: (labelType) => !labelType.endsWith("_hw_kr"),
        hardware: (labelType) => labelType.endsWith("_hw_kr"),
        predmontazoptolisty: (labelType) => labelType.endsWith("_hw_kr"),
    };

function resolveTypeFilter(workplace: string): ((labelType: string) => boolean) | undefined {
    return WORKPLACE_TYPE_FILTER[normalizeWorkplace(workplace)];
}

// ─── env ─────────────────────────────────────────────────────────────────────

const LABEL_PRINT_TRIGGER = process.env.LABEL_PRINT_TRIGGER || "STARTED";
const PRINTER_HOST = process.env.LABEL_PRINTER_HOST || "";
const PRINTER_PORT = parseInt(process.env.LABEL_PRINTER_PORT || "9100", 10);
const COPIES_OVERRIDE = process.env.LABEL_PRINTER_COPIES
    ? parseInt(process.env.LABEL_PRINTER_COPIES, 10)
    : null;

// UNC path as mounted on this Linux server (cifs/samba)
// On Windows the share is  n:\300 Departments\999 Common\01-FFS-Test\Štítky
// which maps to UNC        \\TOCZ-FS2\510-TOCZ\300 Departments\999 Common\01-FFS-Test\Štítky
const CSV_BASE_PATH =
    process.env.LABEL_CSV_BASE_PATH ||
    "\\\\TOCZ-FS2\\510-TOCZ\\300 Departments\\999 Common\\01-FFS-Test\\Štítky";

// When packaged as a standalone .exe (pkg), __dirname = exe directory, not dist/
const cfgDir = (process as any).pkg
    ? path.join(path.dirname(process.execPath), "config")
    : path.join(__dirname, "../../config");

const COUNTRY_CODES_PATH =
    process.env.LABEL_COUNTRY_CODES_PATH ||
    path.join(cfgDir, "country-codes.json");

const LABEL_TYPE_CONFIG_PATH =
    process.env.LABEL_TYPE_CONFIG_PATH ||
    path.join(cfgDir, "label-type-config.json");

// Loaded once at startup, reloaded automatically if the file changes
let countryCodeMap: Record<string, string> = {};

function loadCountryCodes() {
    try {
        const raw = fs.readFileSync(COUNTRY_CODES_PATH, "utf-8");
        const parsed = JSON.parse(raw);
        // Strip the _comment/_format/_examples meta keys
        countryCodeMap = Object.fromEntries(
            Object.entries(parsed).filter(([k]) => !k.startsWith("_")),
        ) as Record<string, string>;
        console.log(
            `[LABELS] Loaded ${Object.keys(countryCodeMap).length} country code mappings from ${COUNTRY_CODES_PATH}`,
        );
    } catch (err: any) {
        console.error(
            `[LABELS] Failed to load country codes from ${COUNTRY_CODES_PATH}: ${err.message}`,
        );
    }
}

// Load on startup
loadCountryCodes();

// Watch for changes so you can edit the file without restarting the server
fs.watchFile(COUNTRY_CODES_PATH, { interval: 5000 }, () => {
    console.log("[LABELS] country-codes.json changed, reloading...");
    loadCountryCodes();
});

// ─── barcode prefix → label type matching (from parametry sheet) ────────
//
// Mirrors the VBA: iterate from C4 downwards, match first 7 chars of barcode
// against column C, then column B. The matched row supplies typStitku (D),
// pocetKopii (I), tiskSekundarnihoStitku (H), and other columns.

interface ParametryEntry {
    scanB: string;
    scanC: string;
    type: string;
    printPrimary: string;
    printSecondary: string;
    copies: number;
    printMethod: string;
    lastCycleNum: string;
}

export let parametryConfig: ParametryEntry[] = [];

function loadParametryConfig() {
    try {
        const raw = fs.readFileSync(LABEL_TYPE_CONFIG_PATH, "utf-8");
        parametryConfig = JSON.parse(raw);
        console.log(
            `[LABELS] Loaded ${parametryConfig.length} parametry entries from ${LABEL_TYPE_CONFIG_PATH}`,
        );
    } catch (err: any) {
        console.error(
            `[LABELS] Failed to load parametry config from ${LABEL_TYPE_CONFIG_PATH}: ${err.message}`,
        );
        parametryConfig = [];
    }
}

loadParametryConfig();

fs.watchFile(LABEL_TYPE_CONFIG_PATH, { interval: 5000 }, () => {
    console.log("[LABELS] label-type-config.json changed, reloading...");
    loadParametryConfig();
});

export function cycleFilterFromLastCycleNum(lastCycleNum: string): CycleFilter {
    if (lastCycleNum === "0") return "last";
    if (lastCycleNum === "1") return "first";
    return null;
}

/**
 * Matches a scanned barcode against the parametry config.
 * Mirrors the VBA: first 7 chars of barcode are matched first against scanC,
 * then scanB. The VBA iterates through ALL rows WITHOUT Exit For, so the
 * LAST match wins (allows fallback to catch-all rows at the bottom).
 * Returns null if no match found.
 */
export function matchLabelType(barcode: string): {
    type: string;
    copies: number;
    printSecondary: string;
    cycleFilter: CycleFilter;
} | null {
    const prefix = barcode.slice(0, 7);
    let result: {
        type: string;
        copies: number;
        printSecondary: string;
        cycleFilter: CycleFilter;
    } | null = null;
    for (const entry of parametryConfig) {
        if (entry.scanC === prefix || entry.scanB === prefix) {
            result = {
                type: entry.type,
                copies: entry.copies,
                printSecondary: entry.printSecondary,
                cycleFilter: cycleFilterFromLastCycleNum(entry.lastCycleNum),
            };
        }
    }
    return result;
}

// ─── types ───────────────────────────────────────────────────────────────────

export interface LabelRow {
    labelType: string; // col 0  typStitku
    customerName: string; // col 1  jmenoZakaznika
    salesOrder: string; // col 2  prodejniObjednavka
    packagePart: string; // col 3  balik            e.g. "K - 1/2"
    packageType: string; // col 4  typBaliku        e.g. "V - 3/5"
    position: string; // col 5  pozice
    customerBarcode: string; // col 6  kodZakaznika
    toorsBarcode: string; // col 7  kodToors
    orderNumber: string; // col 8  cisloZakazky     e.g. "Z253065"
    customerNumber: string; // col 9  cisloZakaznika
    route: string; // col 10 trasa
    countryAddress: string; // col 11 zemeAdresa
    weight: string; // col 12 hmotnost
    tmpFile: string; // col 13 tmpSoubor
    // col 14 empty
    deliveryName: string; // col 15 doruceniJmeno
    deliveryAddress: string; // col 16 doruceniAdresa
    deliveryPostCode: string; // col 17 doruceniPSC
    deliveryCountry: string; // col 18 doruceniZeme
}

// ─── label type config (exact copy of parametry sheet) ───────────────────────
//
// Columns from parametry sheet (read directly from hardware.xlsm):
//   template: aktualniCMDinter for *_hw_kr and t10_struct, aktualniCMD for all others
//             (tiskSekundarnihoStitku = "Ne" for ALL types → no secondary block ever printed)
//   copies:   pocetKopii column
//   cycleFilter:
//     null → print on every cycle  (posledniCisloPozice = None)
//     'first' → print only on cycleIndex === 1  (posledniCisloPozice = 1)
//     'last'  → print only on cycleIndex === totalCycles  (posledniCisloPozice = 0)

type CycleFilter = null | "first" | "last";

interface LabelTypeConfig {
    template: string;
    copies: number;
    cycleFilter: CycleFilter;
}

const LABEL_CONFIG: Record<string, LabelTypeConfig> = {
    // labelType         template              copies  cycleFilter
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
    "triang. plate": {
        template: "aktualniCMD",
        copies: 1,
        cycleFilter: "last",
    },
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

export function resolveConfig(labelType: string): LabelTypeConfig {
    if (LABEL_CONFIG[labelType]) return LABEL_CONFIG[labelType]!;
    // Catch-all for any *_hw_kr suffix not explicitly listed
    if (labelType.endsWith("_hw_kr"))
        return { template: "aktualniCMDinter", copies: 1, cycleFilter: "last" };
    return { template: "aktualniCMD", copies: 1, cycleFilter: null };
}

// ─── CSV reading ──────────────────────────────────────────────────────────────

/**
 * Builds the CSV path exactly as the VBA macro did:
 *   pozice = Left(Right(barcode, 3), 2) & "0"
 *   file   = prodejniObjednavka & " " & pozice & ".csv"
 *
 * The API sends position as the numeric value of the VBA's 3-digit pozice
 * (e.g. VBA pozice = "010" → API sends "10"). We simply pad to 3 digits.
 *
 * From the order payload:
 *   salesOrder "602969", position "300"  →  "602969 300.csv"
 */
function buildCsvPath(salesOrder: string, position: string): string {
    const paddedPos = position.padStart(3, "0");
    return path.join(CSV_BASE_PATH, `${salesOrder} ${paddedPos}.csv`);
}

/**
 * Reads and parses the semicolon-delimited CSV.
 * Column order matches what the macro loaded into pracovniTXT.
 */
export function readCsvFile(salesOrder: string, position: string): LabelRow[] {
    const csvPath = buildCsvPath(salesOrder, position);
    if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);

    const raw = fs.readFileSync(csvPath, "latin1"); // CP1250, latin1 preserves bytes
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
            // c[14] empty
            deliveryName: c[15] ?? "",
            deliveryAddress: c[16] ?? "",
            deliveryPostCode: c[17] ?? "",
            deliveryCountry: c[18] ?? "",
        });
    }

    console.log(`[LABELS] Read ${rows.length} rows from ${csvPath}`);
    return rows;
}

// ─── EZPL generation ──────────────────────────────────────────────────────────
//
// Labels are generated directly in EZPL from the CSV field values.
// No external .prn template files are needed.
//
// Field positions are taken from the real .prn output of the aktualniCMD sheet.
// Each label row produces up to two EZPL blocks (primary + secondary sticker).

function padCustomerNumber(n: string): string {
    return n.replace(/\D/g, "").padStart(6, "0");
}

function splitLine(text: string, maxLen: number): [string, string] {
    if (text.length <= maxLen) return [text, ""];
    return [text.slice(0, maxLen).trimEnd(), text.slice(maxLen)];
}

// EZPL uses commas as field separators, so any comma in a value
// would corrupt the command. VBA sanitizes by replacing commas with spaces.
function ezplValue(val: string): string {
    return val.replace(/,/g, " ");
}

// Extracts the 2-letter country code from the deliveryCountry CSV field.
//
// Primary: take the part before "|" if it looks like a 2-letter code.
//   "DE|Germany"          → "DE"
//   "AT|Austria"          → "AT"
//   "NL|The Netherlands"  → "NL"
//
// Fallback: if there is no "|", or the part before "|" is not 2 letters,
// look up the full value in country-codes.json.
//   "Germany"   → "DE"  (via mapping file)
//   "DE"        → "DE"  (via mapping file)
//
// If neither works, logs a warning and returns the raw value so you know
// what to add to country-codes.json.
function countryCode(deliveryCountry: string): string {
    const key = deliveryCountry.trim();

    // Primary: take before "|"
    const beforePipe = key.split("|")[0]?.trim() ?? "";
    if (beforePipe.length === 2 && /^[A-Za-z]{2}$/.test(beforePipe)) {
        return beforePipe.toUpperCase();
    }

    // Fallback: mapping file lookup
    if (countryCodeMap[key]) return countryCodeMap[key]!;

    console.warn(
        `[LABELS] Unknown deliveryCountry value "${key}" – add it to country-codes.json`,
    );
    return (
        beforePipe.slice(0, 2).toUpperCase() || key.slice(0, 2).toUpperCase()
    );
}

// Fixed border lines — identical on every label (from captured .prn)
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

// EZPL printer header — same for every label on this printer config
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

/**
 * SIMPLE sticker — no barcodes, no delivery address (aktualniCMDinter template).
 * Field positions from sheet7 of hardware.xlsm, confirmed against real Excel .prn output.
 */
function generateSimpleBlock(label: LabelRow): string {
    const pos3 = label.position.padStart(3, "0").slice(0, 3);
    const cc = countryCode(label.deliveryCountry);

    let cName1 = label.customerName;
    if (label.customerName.includes("/")) {
        const idx = label.customerName.indexOf("/");
        cName1 = label.customerName.slice(0, idx + 1);
    } else {
        cName1 = splitLine(label.customerName, 10)[0];
    }

    const orderNum = label.orderNumber.replace(/^Z/, "");
    const orderRef = `${orderNum}_${pos3}`;

    return [
        ezplHeader(),
        labelBorders(),
        "Dy2-me-dd",
        "Th:m:s",
        `AE,22,164,2,2,0,0,${ezplValue(label.salesOrder)}`,
        `AE,22,233,2,2,0,0,${pos3}`,
        `AE,151,345,1,1,0,0,${ezplValue(label.packageType)}`,
        `AE,151,413,1,1,0,0,${ezplValue(label.packagePart)}`,
        "AE,14,598,2,2,0,0,INTERNAL PURPOSE",
        `AF,7,893,1,1,0,0,${ezplValue(cName1)}`,
        "AF,7,969,1,1,0,0",
        `AE,58,38,2,2,0,0,${cc}`,
        `AE,188,685,2,2,0,0,${ezplValue(orderRef)}`,
        "E",
    ].join("\n");
}

/**
 * PRIMARY sticker — full delivery label.
 * Field positions from the first block of the captured aktualniCMD .prn.
 */
function generatePrimaryBlock(label: LabelRow): string {
    const pos3 = label.position.padStart(3, "0");
    const custNum = padCustomerNumber(label.customerNumber);
    const cc = countryCode(label.deliveryCountry);

    // AC font width=2 fits ~20 chars
    const [dName1, dName2] = splitLine(label.deliveryName.toUpperCase(), 20);

    // Customer name split on "/" e.g. "WP1055812/WO1010610"
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
        `BA3,473,181,1,3,100,0,3,${ezplValue(label.toorsBarcode)}`,
        `BA3,479,893,1,3,100,0,3,${ezplValue(label.customerBarcode)}`,
        `AE,22,164,2,2,0,0,${ezplValue(label.salesOrder)}`,
        `AE,22,233,2,2,0,0,${pos3}`,
        `AE,151,345,1,1,0,0,${ezplValue(label.packageType)}`,
        ...(label.weight && label.weight !== "0"
            ? [`AE,4,345,1,1,0,0,${ezplValue(label.weight)}kg`]
            : [""]),
        `AC,9,491,2,2,0,0,${ezplValue(dName1)}`,
        `AC,9,569,2,2,0,0,${ezplValue(dName2)}`,
        `AB,11,672,2,2,0,0,${ezplValue(label.deliveryAddress)}`,
        `AB,11,741,2,2,0,0,${ezplValue(label.deliveryPostCode)}`,
        `AB,11,809,2,2,0,0,${ezplValue(label.deliveryCountry)}`,
        `AF,7,893,1,1,0,0,${ezplValue(cName1)}`,
        ...(cName2 ? [`AF,7,969,1,1,0,0,${ezplValue(cName2)}`] : [""]),
        `AE,5,414,1,1,0,0,${custNum}`,
        `AE,151,413,1,1,0,0,${ezplValue(label.packagePart)}`,
        `AE,58,38,2,2,0,0,${cc}`,
        "E",
    ].join("\n");
}

/**
 * OUTSIDE EU sticker — second label from the A1:A86 range of aktualniCMD.
 * Printed when countryAddress starts with a 2-letter non-EU code + space
 * (mirrors the VBA's tisk() country-code template range selection).
 *
 * The VBA template (rows 48-86 of aktualniCMD) has no delivery address or
 * barcodes — just sales order, position, package type, "OUTSIDE EU" text,
 * the countryAddress on AB line, customer name, and country code.
 */
function generateOutsideEuBlock(label: LabelRow): string {
    const pos3 = label.position.padStart(3, "0");
    const cc = countryCode(label.deliveryCountry);

    let cName1 = label.customerName;
    if (label.customerName.includes("/")) {
        const idx = label.customerName.indexOf("/");
        cName1 = label.customerName.slice(0, idx + 1);
    } else {
        [cName1] = splitLine(label.customerName, 10);
    }

    return [
        ezplHeader(),
        labelBorders(),
        `AE,22,164,2,2,0,0,${ezplValue(label.salesOrder)}`,
        `AE,22,233,2,2,0,0,${pos3}`,
        `AE,151,345,1,1,0,0,${ezplValue(label.packageType)}`,
        "AE,50,577,3,3,0,0,OUTSIDE EU",
        `AB,11,741,2,2,0,0,${ezplValue(label.countryAddress)}`,
        `AF,7,893,1,1,0,0,${ezplValue(cName1)}`,
        "", // blank line — present in VBA rows 48-86 template output
        `AE,58,38,2,2,0,0,${cc}`,
        "E",
    ].join("\n");
}

/**
 * Returns true when the VBA would select A1:A86 (full + outside-EU block)
 * instead of A1:A47 (full only).  The condition is:
 *   1. Country code (first 2 chars) is NOT in the EU lookup (AM:AN range)
 *   2. countryAddress has a space at position 3
 */
function needsOutsideEuLabel(label: LabelRow): boolean {
    const prefix2 = label.countryAddress.slice(0, 2);
    const third = label.countryAddress[2];
    return !EU_COUNTRIES.has(prefix2) && third === " ";
}

/**
 * Returns the full EZPL buffer for one label row.
 *
 * Template selection mirrors the VBA:
 * - "aktualniCMDinter" → simple label (no barcodes, no delivery address)
 * - "aktualniCMD"      → full label (with barcodes, delivery address)
 *
 * For non-EU countries where countryAddress has a space at position 3,
 * the VBA copies A1:A86 from aktualniCMD (full + outside-EU block).
 * This function returns the concatenation of both when applicable.
 */
export function generateEzpl(label: LabelRow, template: string): Buffer {
    const block =
        template === "aktualniCMDinter"
            ? generateSimpleBlock(label)
            : generatePrimaryBlock(label);
    const extra =
        template === "aktualniCMD" && needsOutsideEuLabel(label)
            ? "\n" + generateOutsideEuBlock(label)
            : "";
    return Buffer.from(block + extra + "\n", "latin1");
}

// ─── printer I/O ─────────────────────────────────────────────────────
//
// This backend runs on Windows Server, so we can send print jobs the exact
// same way the Excel macro did:
//
//   copy /b file.prn \\tocz2420311\GodexEZ2250i
//
// Node's child_process.exec runs this through cmd.exe, identical to the
// macro's Shell("cmd.exe /S /K copy /b ... \\tocz2420311\GodexEZ2250i").
//
// Alternative: raw TCP socket to the printer's own IP (LABEL_PRINTER_HOST),
// used only if LABEL_PRINTER_UNC_PATH is not set.

const PRINTER_UNC_PATH = process.env.LABEL_PRINTER_UNC_PATH || ""; // e.g. \\tocz2420311\GodexEZ2250i

/**
 * Sends the EZPL buffer to the printer via the same UNC copy command the
 * Excel macro uses:  copy /b file.prn \\tocz2420311\GodexEZ2250i
 */
async function sendViaWindowsCopy(ezplData: Buffer): Promise<void> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const os = await import("os");
    const execFileAsync = promisify(execFile);

    const tmpFile = path.join(
        os.tmpdir(),
        `label_${Date.now()}_${Math.random().toString(36).slice(2)}.prn`,
    );
    fs.writeFileSync(tmpFile, ezplData);

    try {
        // /b = binary copy, exactly as the VBA macro does
        const cmd = `copy /b "${tmpFile}" "${PRINTER_UNC_PATH}"`;
        console.log(`[LABELS] cmd.exe /c ${cmd}`);
        const { stdout, stderr } = await execFileAsync("cmd.exe", ["/c", cmd]);
        if (stderr && stderr.trim())
            console.warn(`[LABELS] copy stderr: ${stderr.trim()}`);
        if (stdout && stdout.trim())
            console.log(`[LABELS] copy stdout: ${stdout.trim()}`);
    } finally {
        fs.unlink(tmpFile, () => {}); // best-effort cleanup
    }
}

/**
 * Sends the EZPL buffer via raw TCP socket to the printer's own IP (port 9100).
 * Fallback method if LABEL_PRINTER_UNC_PATH is not configured.
 */
function sendViaTcp(ezplData: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
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

/**
 * Dispatches to whichever printer method is configured.
 * UNC copy (matches Excel exactly) takes priority if LABEL_PRINTER_UNC_PATH is set.
 */
async function sendToLabelPrinter(ezplData: Buffer): Promise<void> {
    if (PRINTER_UNC_PATH) {
        return sendViaWindowsCopy(ezplData);
    }
    if (PRINTER_HOST) {
        return sendViaTcp(ezplData);
    }
    console.warn(
        "[LABELS] Neither LABEL_PRINTER_UNC_PATH nor LABEL_PRINTER_HOST set – skipping print",
    );
}

// ─── duplicate guard (PostgreSQL via Knex) ────────────────────────────────────

async function ensurePrintLogTable() {
    const db = await getDb();
    const exists = await db.schema.hasTable("label_print_log");
    if (!exists) {
        await db.schema.createTable("label_print_log", (table: any) => {
            table.increments("id").primary();
            table.string("order_id").notNullable();
            table.string("sales_order").notNullable();
            table.string("position").notNullable();
            table.string("label_type").notNullable();
            table.string("package_part").notNullable();
            table.string("package_type").notNullable();
            table.string("toors_barcode");
            table.integer("copies").notNullable().defaultTo(1);
            table.integer("cycle_index").notNullable().defaultTo(1);
            table.timestamp("printed_at").defaultTo(db.fn.now());
        });
    }
    // Note: if the table already exists without cycle_index, config/database.ts's
    // startup migration (step 8) is responsible for adding the column — this
    // function only handles the fresh-install case.
}

// Duplicate guard is keyed per-cycle. Label rows for shared items configured
// with cycleFilter === null are meant to print on EVERY cycle (see
// selectRowsForCycle's doc comment above) and have identical
// label_type/package_part/package_type across cycles since they carry no
// door number — without cycle_index in the key, cycle 2+ would always look
// like a duplicate of cycle 1 and get skipped.
async function isAlreadyPrinted(
    orderId: string,
    row: LabelRow,
    cycleIndex: number,
): Promise<boolean> {
    const db = await getDb();
    const hit = await db("label_print_log")
        .where({
            order_id: orderId,
            label_type: row.labelType,
            package_part: row.packagePart,
            package_type: row.packageType,
            cycle_index: cycleIndex,
        })
        .first();
    return !!hit;
}

async function recordPrint(
    orderId: string,
    row: LabelRow,
    copies: number,
    cycleIndex: number,
) {
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
        cycle_index: cycleIndex,
    });
}

/**
 * Selects which CSV rows belong to a given production cycle (door).
 *
 * Confirmed behaviour: every door prints its own labels during its own
 * cycle — there is no batching to the first/last cycle. Each row's door
 * number is read from packageType (col 4), e.g.:
 *   "Sektion 2/2"   → door 2
 *   "V - 1/2"       → door 1
 *   "Tormatic 2/2"  → door 2
 *
 * A row prints when its door number matches cycleIndex.
 *
 * Rows with NO door number in packageType (no "N/M" pattern — a genuinely
 * shared item not tied to any single door) fall back to the cycleFilter
 * from the parametry sheet (posledniCisloPozice column), since we have no
 * other signal for when they should print:
 *   null    → print on every cycle
 *   'first' → print only on cycleIndex === 1
 *   'last'  → print only on cycleIndex === totalCycles
 *
 * Extracted as a standalone, side-effect-free function so it can be tested
 * directly against real CSV samples without needing a database, printer, or
 * network share — see scripts/test-label-preview.ts.
 */
/**
 * Returns the cycleFilter for a label type by checking parametryConfig
 * (which mirrors the VBA's posledniCisloPozice column), falling back
 * to the hardcoded LABEL_CONFIG.
 */
function getCycleFilter(labelType: string): CycleFilter {
    // Find the LAST parametry entry matching this type (mirrors VBA iteration)
    let lastCycleNum: string | undefined;
    for (const entry of parametryConfig) {
        if (entry.type === labelType) {
            lastCycleNum = entry.lastCycleNum;
        }
    }
    if (lastCycleNum !== undefined) {
        return cycleFilterFromLastCycleNum(lastCycleNum);
    }
    return resolveConfig(labelType).cycleFilter;
}

export function selectRowsForCycle(
    labelRows: LabelRow[],
    barcodeLastDigit: string,
): LabelRow[] {
    return labelRows.filter((row) => {
        const cf = getCycleFilter(row.labelType);
        if (cf === "first") return barcodeLastDigit === "1";
        if (cf === "last") return barcodeLastDigit === "0";
        return true;
    });
}

// ─── main export ─────────────────────────────────────────────────────────────

export async function handleLabelPrinting(update: OrderUpdate): Promise<void> {
    if (update.action !== LABEL_PRINT_TRIGGER) {
        console.log(
            `[LABELS] action=${update.action} – not trigger (${LABEL_PRINT_TRIGGER}), skip`,
        );
        return;
    }
    const prefix = resolveScanPrefix(update.order.workplace);
    if (!prefix) {
        console.log(
            `[LABELS] workplace="${update.order.workplace}" not recognized ` +
                `(normalized: "${normalizeWorkplace(update.order.workplace)}") – skip. ` +
                `If this IS a label-relevant workplace, add it to WORKPLACE_TO_SCAN_PREFIX.`,
        );
        return;
    }

    await ensurePrintLogTable();

    const { order } = update;
    console.log(
        `[LABELS] Order ${order.productOrder} (${order.salesOrder}/${order.position})`,
    );

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

    // Some workplaces (Motor, Hardware, ...) share the same scan-prefix
    // group but still need distinct label subsets — see WORKPLACE_TYPE_FILTER.
    const typeFilter = resolveTypeFilter(order.workplace);

    // Parametry matching — mirrors VBA scan of parametry sheet, but keyed off
    // the workplace-derived prefix instead of a physically-scanned barcode.
    // Find ALL matching parametry entries (not just the last one).
    const matchingTypes = new Map<
        string,
        { copies: number; cycleFilter: CycleFilter }
    >();
    for (const entry of parametryConfig) {
        if (entry.scanC === prefix && (!typeFilter || typeFilter(entry.type))) {
            matchingTypes.set(entry.type, {
                copies: entry.copies,
                cycleFilter: cycleFilterFromLastCycleNum(entry.lastCycleNum),
            });
        }
    }

    if (matchingTypes.size === 0) {
        console.log(
            `[LABELS] workplace="${order.workplace}" (prefix "${prefix}") — no parametry match, nothing to print`,
        );
        return;
    }

    console.log(
        `[LABELS] workplace="${order.workplace}" → ${matchingTypes.size} matching types in parametry`,
    );

    // Keep only CSV rows whose type exists in the parametry match set.
    labelRows = labelRows.filter((row) => matchingTypes.has(row.labelType));
    if (labelRows.length === 0) {
        console.log(
            `[LABELS] No CSV rows match parametry types for this barcode, nothing to print`,
        );
        return;
    }

    const { cycleIndex, totalCycles } = update;
    const isFirstCycle = cycleIndex === 1;
    const isLastCycle = cycleIndex === totalCycles;
    console.log(
        `[LABELS] cycle ${cycleIndex}/${totalCycles} (first=${isFirstCycle}, last=${isLastCycle})`,
    );

    // Build a set of all known parametry types for CSV row filtering
    const allParametryTypes = new Set(parametryConfig.map((e: any) => e.type));
    const cycleRows = labelRows.filter((r) =>
        allParametryTypes.has(r.labelType),
    );

    console.log(
        `[LABELS] ${cycleRows.length} rows for cycle ${cycleIndex}/${totalCycles} (${labelRows.length} matching in CSV)`,
    );

    let printed = 0;
    let skipped = 0;

    // VBA iterates parametry entries FIRST, then CSV rows — maintain parametry order
    for (const entry of parametryConfig) {
        // Only process entries matching the workplace-derived prefix (each entry checked independently)
        if (entry.scanC !== prefix) continue;
        if (typeFilter && !typeFilter(entry.type)) continue;

        const cf = cycleFilterFromLastCycleNum(entry.lastCycleNum);

        // Cycle filter — mirrors VBA, driven by the real cycleIndex/totalCycles
        // fields instead of a barcode's last digit.
        if (cf === "first" && !isFirstCycle) continue;
        if (cf === "last" && !isLastCycle) continue;

        for (const row of cycleRows) {
            if (row.labelType !== entry.type) continue;

            // Duplicate guard – mirrors Databaze sheet check in VBA, scoped to this cycle
            if (await isAlreadyPrinted(order._id, row, cycleIndex)) {
                console.log(
                    `[LABELS] SKIP already printed: ${row.labelType} ${row.packagePart} ${row.packageType}`,
                );
                skipped++;
                continue;
            }

            const config = resolveConfig(row.labelType);
            const copies = COPIES_OVERRIDE ?? entry.copies ?? config.copies;

            const printerConfigured = !!(PRINTER_UNC_PATH || PRINTER_HOST);

            try {
                const ezplData = generateEzpl(row, config.template);

                if (!printerConfigured) {
                    console.log(
                        `[LABELS] [DRY RUN] ${copies}x ${config.template} | ` +
                            `${row.labelType} | ${row.salesOrder}/${row.position} | ` +
                            `${row.packagePart} ${row.packageType} | ${row.customerName}`,
                    );
                } else {
                    for (let i = 0; i < copies; i++) {
                        await sendToLabelPrinter(ezplData);
                    }
                }

                await recordPrint(order._id, row, copies, cycleIndex);
                printed++;
                console.log(
                    `[LABELS] ${printerConfigured ? "Printed" : "Dry-run"} ${copies}x ` +
                        `${config.template} – ${row.labelType} ${row.packagePart} ${row.packageType}`,
                );
            } catch (err: any) {
                console.error(
                    `[LABELS] Error printing ${row.labelType}: ${err.message}`,
                );
            }
        }
    }

    console.log(
        `[LABELS] Done – printed: ${printed}, skipped: ${skipped}, total: ${cycleRows.length}`,
    );

    // QR sticker – last cycle only, mirrors TiskQRKodu
    try {
        await handleQrSticker(update, labelRows);
    } catch (err: any) {
        console.error(`[QR] Error: ${err.message}`);
    }
}

// ─── QR sticker printing ──────────────────────────────────────────────────────
//
// Mirrors the VBA TiskQRKodu sub.
//
// Triggered only on the LAST cycle (cycleIndex === totalCycles).
// Reads the TMP*.TXT file from the network share to find:
//   - characteristic 6210610 → rail type (e.g. "GSL", "VL", "SL")
//   - "Objednáno" row → PocetVrat (number of doors to print)
//   - "Cenová skupina" → if "C01" skip entirely
// Maps rail type → QR PNG filename, prints PocetVrat copies.
//
// Printed on the SAME printer as documents (DOCUMENTS_PRINTER_HOST) via
// documentPrinterService — the PNG is wrapped into a one-page PDF and sent
// through the identical Ghostscript → raw-TCP pipeline. There is no
// separate QR printer env var anymore.
//
// Environment variables:
//   LABEL_TMP_FILES_PATH   path to the TMP*.TXT files
//                          default: //TOCZ-FS2/510-TOCZ/300 Departments/300 Technical Services/Dokumentace B/NACTENO
//   LABEL_QR_IMAGES_PATH   path to the folder containing QR PNG files

const TMP_FILES_PATH =
    process.env.LABEL_TMP_FILES_PATH ||
    "\\\\TOCZ-FS2\\510-TOCZ\\300 Departments\\300 Technical Services\\Dokumentace B\\NACTENO";

const QR_IMAGES_PATH = process.env.LABEL_QR_IMAGES_PATH || "";

// Rail type → QR PNG filename (mirrors the VBA Select Case TypVedeni block)
const QR_CODE_MAP: Record<string, string> = {
    // Indy
    SL: "Indy_SL",
    HL: "Indy_HL",
    VL: "Indy_VL",
    "LL-DT": "Indy_LL-DT",
    "LL-I": "Indy_LL-I",
    "HL-T": "Indy_HL-T",
    "VL-T": "Indy_VL-T",
    "VL-TL": "Indy_VL-T_ECO",
    "LL-CE": "LL-CE",
    // Guardy
    GSL: "Guardy_SL",
    "LHF-C": "Guardy_LHF-C",
    "LHR-C": "Guardy_LHR-C",
    // GT-R
    "SL-GT": "GTR_SL",
    "HL-GT": "GTR_HL",
    "VL-GT": "GTR_VL",
    // EXT
    "EXT-B": "Guardy_EXT_Behind",
    "EXT-O": "Guardy_EXT_In",
};

/**
 * Parses a TMP*.TXT file (pipe-delimited) to extract rail type, door count,
 * and price group — exactly as the VBA macro did via QueryTables.
 *
 * The file is grouped by "pozice" sections. We look in the section whose
 * position matches the order position (col F of pracovniTXT = position field).
 *
 * Within that section:
 *   col B = "6210610"  → col D = rail type (TypVedeni)
 *   col A = "Objednáno" → col B = door count (PocetVrat)
 *   col C = "Cenová skupina" → col D = price group (CenovaSkupina)
 */
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

    // Find the section for our position (line where col A = "pozice" and col B = position)
    const paddedPos = position.padStart(3, "0");
    let inSection = false;
    let railType = "";
    let doorCount = 0;
    let priceGroup = "";

    for (const line of lines) {
        const cols = line.split("|").map((c) => c.trim());

        // Section boundary: "pozice | <value>"
        if (cols[0]?.toLowerCase() === "pozice") {
            inSection = cols[1] === position || cols[1] === paddedPos;
            continue;
        }

        if (!inSection) continue;

        // Rail type: col B = "6210610" → col D = value
        if (cols[1] === "6210610" && cols[3]) {
            railType = cols[3].trim();
        }

        // Door count: col A = "Objednáno" → col B = value
        if (cols[0] === "Objednáno" && cols[1]) {
            doorCount = parseInt(cols[1], 10) || 0;
        }

        // Price group: col C = "Cenová skupina" → col D = value
        if (cols[2]?.includes("Cenová skupina") && cols[3]) {
            priceGroup = cols[3].trim();
        }
    }

    if (!railType) {
        console.warn(
            `[QR] Could not find rail type (6210610) in ${filePath} for position ${position}`,
        );
        return null;
    }

    return { railType, doorCount, priceGroup };
}

/**
 * Prints a QR PNG file N times, using the same printer and pipeline as
 * document printing (documentPrinterService: PNG → one-page PDF →
 * Ghostscript → raw TCP to DOCUMENTS_PRINTER_HOST).
 *
 * Equivalent to VBA: wordDoc.PrintOut repeated PocetVrat times.
 */
async function printQrPng(pngPath: string, copies: number): Promise<void> {
    if (!DOCUMENTS_PRINTER_HOST) {
        console.log(
            `[QR] No printer configured (DOCUMENTS_PRINTER_HOST empty) — would print ${copies}x "${pngPath}"`,
        );
        return;
    }
    console.log(
        `[QR] Printing ${copies}x "${pngPath}" to ${DOCUMENTS_PRINTER_HOST}`,
    );
    await printPngFile(pngPath, copies);
}

/**
 * Main QR sticker handler — called only on the last cycle.
 * Mirrors TiskQRKodu from QRKody.bas.
 */
export async function handleQrSticker(
    update: OrderUpdate,
    labelRows: LabelRow[],
): Promise<void> {
    const { order, cycleIndex, totalCycles } = update;

    // Only on the last cycle (VBA: Right(nactenyKodCely, 1) = 0 → last scan of position)
    if (cycleIndex !== totalCycles) return;

    // Find the TMP*.TXT filename from the CSV rows (col 13, any row that has it)
    const tmpFile = labelRows.find((r) =>
        r.tmpFile?.toLowerCase().startsWith("tmp"),
    )?.tmpFile;
    if (!tmpFile) {
        console.log(
            "[QR] No TMP file reference in CSV rows, skipping QR sticker",
        );
        return;
    }

    const tmpFilePath = path.join(TMP_FILES_PATH, tmpFile);
    console.log(`[QR] Reading TMP file: ${tmpFilePath}`);

    const data = parseTmpFile(tmpFilePath, order.position);
    if (!data) return;

    // C01 price group → no QR sticker (VBA: Exit Sub)
    if (data.priceGroup === "C01") {
        console.log("[QR] Price group C01 – skipping QR sticker");
        return;
    }

    const qrName = QR_CODE_MAP[data.railType];
    if (!qrName) {
        console.warn(
            `[QR] Unknown rail type "${data.railType}" – no QR mapping found`,
        );
        return;
    }

    if (!QR_IMAGES_PATH) {
        console.log(
            `[QR] [DRY RUN] Would print ${data.doorCount}x ${qrName}.png (rail: ${data.railType})`,
        );
        return;
    }

    const pngPath = path.join(QR_IMAGES_PATH, `${qrName}.png`);
    if (!fs.existsSync(pngPath)) {
        console.error(`[QR] PNG not found: ${pngPath}`);
        return;
    }

    console.log(
        `[QR] Printing ${data.doorCount}x ${qrName}.png for rail type "${data.railType}"`,
    );
    await printQrPng(pngPath, data.doorCount);
}
