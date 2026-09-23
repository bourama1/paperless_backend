/**
 * code39Barcode.ts
 *
 * Code 39 (aka "3 of 9") support for the prep-station label PDF, built for
 * the "BC 3 of 9 Light" barcode font family (classic BC C39 3 of 9 —
 * "Light" is one of its weights).
 *
 * Two rendering paths, chosen automatically by buildPrepLabelPdf:
 *
 *   1. Font file found (PREP_LABEL_BARCODE_FONT_PATH env var → config/
 *      folder → C:\Windows\Fonts) → the barcode text is drawn with that
 *      font, embedded into the PDF as a TrueType simple font (FontFile2).
 *      Embedding matters: the *printer* needs the glyph outlines — a font
 *      that merely exists on the server (or a non-embedded reference)
 *      prints substituted/garbled glyphs or nothing at all. Code 39 fonts
 *      render each character as bars and carry the inter-character gap in
 *      the glyph advance, so plain text drawing is all that's needed.
 *
 *   2. Font file not found → vector fallback: the barcode is drawn as PDF
 *      rectangle operators (bar/space pattern from the symbology spec) with
 *      the human-readable text in Helvetica underneath. Looks slightly
 *      different, scans identically.
 *
 * Code 39 reference (ISO/IEC 16388):
 *   - Character set: A-Z, 0-9, and - . space $ / + % (43 chars)
 *   - Every character = 9 elements (5 bars + 4 spaces), exactly 3 wide
 *   - Data is delimited by * (start/stop) on both sides
 *   - Discrete symbology: a narrow inter-character gap separates characters
 *   - No check digit required
 *
 * Encoding table source: the widely-deployed JsBarcode implementation
 * (github.com/lindell/JsBarcode, src/barcodes/CODE39). Each value is the
 * symbol's module bitmap (bar=1/space=0, narrow=1 module, wide=3 modules)
 * as a decimal number; the per-element wide/narrow flags are derived by
 * run-length decoding at module load, so there are no hand-transcribed
 * bar patterns to get wrong. tests/unit/code39Barcode.test.ts validates
 * the decoded table against the spec invariants (9 elements, 5 bars,
 * 4 spaces, exactly 3 wide).
 */

import fs from "fs";
import path from "path";

// ─── character set ───────────────────────────────────────────────────────────

/** The characters Code 39 can encode (plus the * start/stop delimiter). */
const CODE39_CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ-. $/+%";

/**
 * Per-character module bitmap as a decimal number (see file comment). Index
 * into this record = the character itself; "*" is the start/stop pattern.
 */
const CODE39_ENCODINGS: Record<string, number> = {
    "0": 20957, "1": 29783, "2": 23639, "3": 30485, "4": 20951,
    "5": 29813, "6": 23669, "7": 20855, "8": 29789, "9": 23645,
    A: 29975, B: 23831, C: 30533, D: 22295, E: 30149, F: 24005,
    G: 21623, H: 29981, I: 23837, J: 22301, K: 30023, L: 23879,
    M: 30545, N: 22343, O: 30161, P: 24017, Q: 21959, R: 30065,
    S: 23921, T: 22385, U: 29015, V: 18263, W: 29141, X: 17879,
    Y: 29045, Z: 18293, "-": 17783, ".": 29021, " ": 18269,
    $: 17477, "/": 17489, "+": 17681, "%": 20753,
    "*": 35770, // start/stop — its decimal includes the trailing gap bit
};

/**
 * Decodes one character's bitmap into its 9 element widths in "narrow
 * units" (1 = narrow, 2.5 = wide — the classic BC 3of9 "Light" ratio; the
 * spec allows wide:narrow between 2:1 and 3:1). Elements alternate
 * bar, space, bar, ... starting with a bar.
 */
function elementsFor(ch: string): number[] {
    let bits = (CODE39_ENCODINGS[ch] ?? CODE39_ENCODINGS["-"]!).toString(2);
    // "*" is stored with its trailing inter-character gap bit — strip it.
    if (bits.length === 16) bits = bits.slice(0, 15);
    bits = bits.padStart(15, "0"); // 6 narrow + 3 wide(3×) = 15 modules

    const runs = bits.match(/1+|0+/g) ?? [];
    if (runs.length !== 9) {
        // Can only happen if CODE39_ENCODINGS is corrupted — fall back to
        // the "-" pattern rather than emitting a broken symbol.
        return elementsFor("-");
    }
    // narrow = 1 module, wide = 3 modules → scale wide to 2.5 units
    return runs.map((run) => (run.length > 1 ? 2.5 : 1));
}

// Pre-decode once at module load (44 chars + "*").
const CODE39_ELEMENTS: Record<string, number[]> = Object.fromEntries(
    Object.keys(CODE39_ENCODINGS).map((ch) => [ch, elementsFor(ch)]),
);

/**
 * Replaces anything outside Code 39's character set with '-' and uppercases
 * the result. Returns an empty string for empty input so callers can skip
 * the barcode block entirely instead of printing a lone "*" pair.
 */
export function sanitizeCode39(input: string): string {
    return input
        .toUpperCase()
        .split("")
        .map((ch) => (CODE39_CHARS.includes(ch) ? ch : "-"))
        .join("");
}

// ─── symbol geometry ─────────────────────────────────────────────────────────

export interface Code39Geometry {
    /** element widths in points, alternating bar/space starting with a bar */
    elementWidths: number[];
    /** human-readable content incl. the * delimiters */
    text: string;
    /** total symbol width in points (incl. inter-character gaps) */
    totalWidth: number;
}

/**
 * Computes the full geometry of a Code 39 symbol for `data` with the given
 * narrow-element width in points. Wide elements are 2.5× narrow and each
 * character is followed by a narrow inter-character gap (part of the spec).
 */
export function code39Geometry(
    data: string,
    narrowPt: number,
): Code39Geometry {
    const text = `*${sanitizeCode39(data)}*`;
    const elementWidths: number[] = [];

    for (const ch of text) {
        const elements = CODE39_ELEMENTS[ch] ?? CODE39_ELEMENTS["-"]!;
        for (const units of elements) {
            elementWidths.push(units * narrowPt);
        }
        elementWidths.push(narrowPt); // inter-character gap (a space)
    }

    return {
        elementWidths,
        text,
        totalWidth: elementWidths.reduce((a, b) => a + b, 0),
    };
}

/**
 * Emits the PDF content-stream operators that draw a Code 39 symbol as
 * black bars at (x, y) (PDF user space, y = bottom of the bars) with the
 * given bar height. Returns the ops and the symbol's total width so the
 * caller can center it.
 */
export function code39VectorOps(
    data: string,
    x: number,
    y: number,
    barHeight: number,
    narrowPt: number,
): { ops: string; totalWidth: number } {
    const geo = code39Geometry(data, narrowPt);
    let cursor = x;
    const ops: string[] = ["q 0 0 0 rg"];
    for (let i = 0; i < geo.elementWidths.length; i++) {
        const w = geo.elementWidths[i]!;
        if (i % 2 === 0) {
            // even index = bar (odd = space)
            ops.push(
                `${cursor.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${barHeight.toFixed(2)} re f`,
            );
        }
        cursor += w;
    }
    ops.push("Q");
    return { ops: ops.join("\n"), totalWidth: geo.totalWidth };
}

// ─── font discovery ──────────────────────────────────────────────────────────

const FONT_CANDIDATES = [
    "BC C39 3 of 9 Light.ttf",
    "BC C39 3 of 9 Light Narrow.ttf",
    "bc c39 3 of 9 light.ttf",
    "BC3OF9L.TTF",
    "bcc3939l.ttf",
    "c39light.ttf",
];

/**
 * Looks for the BC 3of9 Light font file — see findFontFile. Returns null
 * when nothing is found (the caller falls back to vector bars).
 */
export function findCode39FontFile(): string | null {
    return findFontFile(process.env.PREP_LABEL_BARCODE_FONT_PATH, FONT_CANDIDATES);
}

/**
 * Looks for a font file: the explicit path (usually an env var) first, then
 * each of `names` in the backend's config/ folder, then in the standard
 * Windows font directories. Returns null when nothing is found.
 */
export function findFontFile(explicitPath: string | undefined, names: string[]): string | null {
    const candidates: string[] = [];

    if (explicitPath) {
        candidates.push(explicitPath);
    }

    // When packaged as a standalone .exe (pkg), __dirname isn't dist/ —
    // same pattern as labelPrintingService.ts's cfgDir.
    const cfgDir = (process as any).pkg
        ? path.join(path.dirname(process.execPath), "config")
        : path.join(__dirname, "../../config");
    for (const name of names) {
        candidates.push(path.join(cfgDir, name));
    }

    const windowsFonts = [
        process.env.windir ? path.join(process.env.windir, "Fonts") : "",
        "C:\\Windows\\Fonts",
    ].filter(Boolean) as string[];
    for (const dir of windowsFonts) {
        for (const name of names) {
            candidates.push(path.join(dir, name));
        }
    }

    for (const candidate of candidates) {
        try {
            if (fs.existsSync(candidate)) return candidate;
        } catch {
            // unreadable path — keep looking
        }
    }
    return null;
}

// ─── minimal TrueType parser (only what font embedding needs) ────────────────

export interface TrueTypeFontInfo {
    unitsPerEm: number;
    /** glyph id → advance width, in font units */
    advanceWidths: Map<number, number>;
    /** character code → glyph id (ASCII range; see parseCmap) */
    charToGlyph: Map<number, number>;
    fontData: Buffer;
}

function readUInt16(buf: Buffer, off: number): number {
    return buf.readUInt16BE(off);
}

function readInt16(buf: Buffer, off: number): number {
    return buf.readInt16BE(off);
}

function readUInt32(buf: Buffer, off: number): number {
    return buf.readUInt32BE(off);
}

/**
 * Parses just enough of the TTF to (a) map ASCII byte codes to glyph ids
 * and (b) know every glyph's advance width, so the PDF's /Widths array is
 * correct (viewers and some printer drivers use it for text layout even
 * when the outlines are embedded).
 */
export function parseTrueType(data: Buffer): TrueTypeFontInfo {
    const numTables = readUInt16(data, 4);
    const tables: Record<string, { offset: number; length: number }> = {};
    for (let i = 0; i < numTables; i++) {
        const rec = 12 + i * 16;
        const tag = data.toString("latin1", rec, rec + 4);
        tables[tag] = {
            offset: readUInt32(data, rec + 8),
            length: readUInt32(data, rec + 12),
        };
    }

    const head = tables.head;
    if (!head) throw new Error("TTF missing head table");
    const unitsPerEm = readUInt16(data, head.offset + 18);

    const hmtx = tables.hmtx;
    const hhea = tables.hhea;
    if (!hmtx || !hhea) throw new Error("TTF missing hmtx/hhea tables");
    const numberOfHMetrics = readUInt16(data, hhea.offset + 34);

    const cmap = tables.cmap;
    if (!cmap) throw new Error("TTF missing cmap table");
    const charToGlyph = parseCmap(data, cmap.offset);

    const advanceWidths = new Map<number, number>();
    for (let gid = 0; gid < numberOfHMetrics; gid++) {
        advanceWidths.set(gid, readUInt16(data, hmtx.offset + gid * 4));
    }

    return { unitsPerEm, advanceWidths, charToGlyph, fontData: data };
}

/**
 * Walks the cmap subtables and builds an ASCII char → glyph id map.
 * Preference order: (3,1) Windows Unicode BMP, (1,0) Mac Roman, then any
 * platform-3 subtable (e.g. (3,0) symbol — barcode fonts are often symbol
 * fonts whose ASCII glyphs live at 0xF000+code; those get remapped below).
 */
function parseCmap(data: Buffer, cmapOffset: number): Map<number, number> {
    const map = new Map<number, number>();
    const numSubtables = readUInt16(data, cmapOffset + 2);
    let chosenOffset = -1;
    for (let i = 0; i < numSubtables; i++) {
        const rec = cmapOffset + 4 + i * 8;
        const platformId = readUInt16(data, rec);
        const offset = readUInt32(data, rec + 4);
        if (platformId === 3) {
            // (3,1) preferred; remember the first platform-3 table as a
            // fallback but keep scanning for a (3,1).
            const encodingId = readUInt16(data, rec + 2);
            if (encodingId === 1) {
                chosenOffset = cmapOffset + offset;
                break;
            }
            if (chosenOffset === -1) chosenOffset = cmapOffset + offset;
        } else if (platformId === 1 && chosenOffset === -1) {
            chosenOffset = cmapOffset + offset;
        }
    }
    if (chosenOffset === -1) {
        throw new Error("TTF cmap has no usable subtable");
    }

    const format = readUInt16(data, chosenOffset);
    if (format === 4) {
        const segCountX2 = readUInt16(data, chosenOffset + 6);
        const segCount = segCountX2 / 2;
        const endCodesOff = chosenOffset + 14;
        const startCodesOff = endCodesOff + segCountX2 + 2;
        const idDeltaOff = startCodesOff + segCountX2;
        const idRangeOffsetOff = idDeltaOff + segCountX2;

        for (let seg = 0; seg < segCount; seg++) {
            const end = readUInt16(data, endCodesOff + seg * 2);
            const start = readUInt16(data, startCodesOff + seg * 2);
            const idDelta = readInt16(data, idDeltaOff + seg * 2);
            const idRangeOffset = readUInt16(data, idRangeOffsetOff + seg * 2);
            for (let c = start; c <= end && c !== 0xffff; c++) {
                let gid: number;
                if (idRangeOffset === 0) {
                    gid = (c + idDelta) & 0xffff;
                } else {
                    const glyphOffset =
                        idRangeOffsetOff + seg * 2 + idRangeOffset + (c - start) * 2;
                    if (glyphOffset + 1 >= data.length) continue;
                    gid = readUInt16(data, glyphOffset);
                    if (gid !== 0) gid = (gid + idDelta) & 0xffff;
                }
                if (gid !== 0 && !map.has(c)) map.set(c, gid);
            }
        }

        // Symbol (3,0) fonts keep ASCII glyphs at 0xF000+code — remap so
        // plain ASCII byte codes resolve.
        for (let c = 32; c <= 126; c++) {
            if (!map.has(c) && map.has(0xf000 + c)) {
                map.set(c, map.get(0xf000 + c)!);
            }
        }
    } else if (format === 0) {
        for (let c = 0; c < 256; c++) {
            const gid = data[chosenOffset + 6 + c]!;
            if (gid !== 0) map.set(c, gid);
        }
    } else {
        throw new Error(`Unsupported cmap format ${format}`);
    }
    return map;
}

/** Advance width of a character in font units; 0 when unknown. */
export function glyphAdvance(font: TrueTypeFontInfo, charCode: number): number {
    const gid = font.charToGlyph.get(charCode);
    if (gid === undefined) return 0;
    return font.advanceWidths.get(gid) ?? 0;
}

/** Total advance width of a string in font units. */
export function stringAdvance(
    font: TrueTypeFontInfo,
    text: string,
): number {
    let total = 0;
    for (const ch of text) total += glyphAdvance(font, ch.charCodeAt(0));
    return total;
}

// ─── PDF embedding ───────────────────────────────────────────────────────────

/**
 * Builds the three PDF objects needed to embed the font:
 *   [0] /Type /FontDescriptor (+ /FontFile2 reference)
 *   [1] /Type /FontFile2 dict (the raw TTF is appended by the caller —
 *       it's binary, so it can't live in a string)
 *   [2] /Type /Font — the simple TrueType font the text ops reference
 * The caller assigns object numbers and wires the two cross-references
 * (descriptor→FontFile2, Font→FontDescriptor) to the numbers it chose.
 */
export function buildTrueTypeFontObjects(
    font: TrueTypeFontInfo,
): {
    descriptorDict: string;
    fontFileDict: string;
    fontDict: string;
    fontFile: Buffer;
} {
    // Locate hhea for ascent/descent (same scan as parseTrueType).
    let hheaOffset = -1;
    const numTables = readUInt16(font.fontData, 4);
    for (let i = 0; i < numTables; i++) {
        const rec = 12 + i * 16;
        if (font.fontData.toString("latin1", rec, rec + 4) === "hhea") {
            hheaOffset = readUInt32(font.fontData, rec + 8);
            break;
        }
    }
    const ascent = hheaOffset >= 0 ? readInt16(font.fontData, hheaOffset + 4) : 1000;
    const descent = hheaOffset >= 0 ? readInt16(font.fontData, hheaOffset + 6) : -300;

    const scale = 1000 / font.unitsPerEm;
    const yMin = Math.floor(descent * scale);
    const yMax = Math.ceil(ascent * scale);

    // Bit 3 (symbolic) is the safest flag for a barcode font: its cmap may
    // be a (3,0) symbol table rather than a clean WinAnsi match.
    const descriptorDict =
        "<< /Type /FontDescriptor /FontName /BC39Light /Flags 4 " +
        `/FontBBox [0 ${yMin} 1000 ${yMax}] /ItalicAngle 0 ` +
        `/Ascent ${yMax} /Descent ${yMin} /CapHeight ${yMax} /StemV 80 ` +
        "/FontFile2 %FONT_FILE_OBJ% 0 R >>";

    const fontFile = font.fontData;
    const fontFileDict =
        `<< /Length ${fontFile.length} /Length1 ${fontFile.length} >>`;

    // Widths for the printable ASCII range; unknown glyphs get 0 (viewers
    // then use the font's own metrics — the embedded outlines are exact).
    const widths = Array.from({ length: 95 }, (_, i) => {
        const gid = font.charToGlyph.get(32 + i);
        const w = gid !== undefined ? font.advanceWidths.get(gid) ?? 0 : 0;
        return String(Math.round(w * scale));
    }).join(" ");

    const fontDict =
        "<< /Type /Font /Subtype /TrueType /BaseFont /BC39Light " +
        "/FirstChar 32 /LastChar 126 " +
        `/Widths [${widths}] ` +
        "/Encoding /WinAnsiEncoding /FontDescriptor %FONT_DESC_OBJ% 0 R >>";

    return { descriptorDict, fontFileDict, fontDict, fontFile };
}

/** PDF string literal escaping (backslash and parens). */
export function escapePdfString(s: string): string {
    return s
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)");
}
