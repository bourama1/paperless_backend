/**
 * documentPrinterService.ts
 *
 * Shared "print to a network printer by IP" pipeline. Used by:
 *   - workstationService.ts   → PBOM/declaration/confirmation PDFs, always
 *                               via this pipeline to DOCUMENTS_PRINTER_HOST.
 *   - labelPrintingService.ts → QR stickers (PNG, wrapped into a one-page
 *                               PDF). For a ZPL-language workplace this is
 *                               only the RENDER step (renderPngAsZplLabel) —
 *                               the sticker is then sent over that
 *                               workplace's own label-printer connection, so
 *                               it comes out of the SAME printer as the
 *                               barcode label, not DOCUMENTS_PRINTER_HOST.
 *                               An EZPL-language workplace has no such path
 *                               yet and falls back to DOCUMENTS_PRINTER_HOST
 *                               (see labelPrintingService.printQrPng).
 *
 * Godex/Zebra label printing is otherwise unrelated and keeps its own
 * UNC-share config in labelPrintingService.ts.
 *
 * How it works:
 *   1. Ghostscript renders the PDF into the printer's native page-
 *      description language (PCL XL by default).
 *   2. The rendered bytes are streamed raw over a TCP socket to the
 *      printer's JetDirect/raw port (9100 by default) — no Windows
 *      printer object, driver, or spooler needed.
 *
 * Env vars:
 *   DOCUMENTS_PRINTER_HOST    printer's IP address (empty = dry run)
 *   DOCUMENTS_PRINTER_PORT    raw TCP port                (default: 9100)
 *   DOCUMENTS_PRINTER_DEVICE  gs output device: pxlmono | pxlcolor |
 *                             ljet4 | ps2write             (default: pxlmono)
 *   DOCUMENTS_PRINTER_DUPLEX  "true" to print double-sided, anything else
 *                             (or unset) for single-sided               (default: false)
 *   DOCUMENTS_PRINTER_BINDING "LONGEDGE" (default, flip on long/left edge,
 *                             normal portrait duplex) or "SHORTEDGE"
 *                             (flip on short/top edge, used for landscape)
 */

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import crypto from "crypto";
import { GHOSTSCRIPT_BIN } from "./pdfaService";
import { isPrintingEnabled } from "./printSettingsService";
import {
    buildTrueTypeFontObjects,
    code39Geometry,
    code39VectorOps,
    escapePdfString,
    findCode39FontFile,
    parseTrueType,
    sanitizeCode39,
    stringAdvance,
    TrueTypeFontInfo,
} from "../utils/code39Barcode";

export const DOCUMENTS_PRINTER_HOST = process.env.DOCUMENTS_PRINTER_HOST || "";
export const DOCUMENTS_PRINTER_PORT = parseInt(
    process.env.DOCUMENTS_PRINTER_PORT || "9100",
    10,
);
export const DOCUMENTS_PRINTER_DEVICE =
    process.env.DOCUMENTS_PRINTER_DEVICE || "pxlmono";
export const DOCUMENTS_PRINTER_DUPLEX =
    process.env.DOCUMENTS_PRINTER_DUPLEX === "true";
export const DOCUMENTS_PRINTER_BINDING =
    (process.env.DOCUMENTS_PRINTER_BINDING || "LONGEDGE").toUpperCase() as
        | "LONGEDGE"
        | "SHORTEDGE";
// DPI for Ghostscript rasterisation. Default 300 gives good quality for
// PBOM/declaration documents (text + line graphics) while being ~4× faster
// to render than the Ghostscript default of 600. Set to 600 if you need
// photo-quality output.
export const DOCUMENTS_PRINTER_DPI = parseInt(
    process.env.DOCUMENTS_PRINTER_DPI || "300",
    10,
);

// 100 mm × 130 mm label stock in points (1 mm = 72/25.4 pt) — the prep
// label's own page size (see the "prep-station label PDF" section below),
// and also the physical media loaded in the ZPL-language label printers
// (e.g. Hardware's — EZPL ^W100/^Q130 in labelPrintingService.ts maps to
// the same ≈794 × 1033 dot canvas at 203 dpi). Exported so a QR sticker PNG
// can be fitted to this exact page size and printed on that SAME printer
// right after the barcode label (see renderPngAsZplLabel).
export const PREP_LABEL_PAGE_WIDTH_PT = 283.46;
export const PREP_LABEL_PAGE_HEIGHT_PT = 368.5;

// ─── Prep label printer (Godex / Zebra) ────────────────────────────────────────
// Separate printer config for the prep label (project number barcode, employee
// name, etc.) — these are thermal labels, not A4 documents on the HP. The
// prep label PDF is rendered and sent via raw TCP, same "no driver/spooler
// needed" approach as the documents printer but targeting a different
// machine — with one difference: unlike the HP and the Godex EZ2250i, a
// Zebra ZD230 has no PCL/PostScript engine at all, only its own ZPL command
// language, so a PCL-XL stream just makes it blink an error instead of
// printing. Set PREP_LABEL_PRINTER_DEVICE=zpl for that class of printer —
// see renderPdfToZplBuffer below — instead of a Ghostscript device name.
//
//   PREP_LABEL_PRINTER_HOST    printer IP address (empty = return PDF to mobile instead)
//   PREP_LABEL_PRINTER_PORT    raw TCP port                 (default: 9100)
//   PREP_LABEL_PRINTER_DEVICE  gs output device, or "zpl" for a Zebra
//                              ZPL-native printer (e.g. ZD230)   (default: pxlmono)
//   PREP_LABEL_PRINTER_DPI     render resolution            (default: 203)
//     203 DPI matches most Godex/Zebra desktop thermal printers' native
//     resolution. Use 300 if your model is 300 DPI (check the spec sheet) —
//     for "zpl" mode this must match the printer's actual configured DPI,
//     since ^PW/^LL are emitted in dots at that resolution.

export const PREP_LABEL_PRINTER_HOST = process.env.PREP_LABEL_PRINTER_HOST || "";
export const PREP_LABEL_PRINTER_PORT = parseInt(
    process.env.PREP_LABEL_PRINTER_PORT || "9100",
    10,
);
export const PREP_LABEL_PRINTER_DEVICE =
    process.env.PREP_LABEL_PRINTER_DEVICE || "pxlmono";
export const PREP_LABEL_PRINTER_DPI = parseInt(
    process.env.PREP_LABEL_PRINTER_DPI || "203",
    10,
);

/**
 * Prepends duplex instructions to a rendered printer-language job buffer.
 *
 * Duplex support per printer language:
 *
 * pxlmono / pxlcolor (PCL-XL / PCL6, the default):
 *   A PJL (Printer Job Language) header goes before the PCL-XL data. PJL
 *   is a meta-language that HP-compatible printers process before handing
 *   the rest of the stream to the page-language parser. The UEL (Universal
 *   Exit Language) escape sequence \x1b%-12345X is the required preamble;
 *   the printer uses it to detect that what follows is PJL rather than raw
 *   PCL. ENTER LANGUAGE=PCLXL hands control back to the PCL-XL engine so
 *   the actual page content prints normally.
 *
 * ljet4 (PCL5):
 *   A PCL escape sequence sets the duplex mode. \x1b&l2S = duplex long-
 *   edge, \x1b&l1S = duplex short-edge. This goes at the very start of the
 *   stream (before any page data) and takes effect for the whole job.
 *
 * ps2write (PostScript):
 *   Ghostscript can embed the duplex request directly in the render step
 *   via -dDuplex=true and -dTumble=false/true — no byte prepending needed.
 *   This function returns the buffer unchanged for ps2write; the calling
 *   code adds the relevant gs args in renderPdfForPrinter() instead.
 */
export function applyDuplexToBuffer(
    data: Buffer,
    device: string,
    duplex: boolean,
    binding: "LONGEDGE" | "SHORTEDGE",
): Buffer {
    if (!duplex) return data;

    const normalizedDevice = device.toLowerCase();

    if (normalizedDevice === "pxlmono" || normalizedDevice === "pxlcolor") {
        // PJL header — must be the very first bytes in the TCP stream
        const pjlHeader = Buffer.from(
            `\x1b%-12345X` +
                `@PJL\n` +
                `@PJL SET DUPLEX=ON\n` +
                `@PJL SET BINDING=${binding}\n` +
                `@PJL ENTER LANGUAGE=PCLXL\n`,
            "ascii",
        );
        return Buffer.concat([pjlHeader, data]);
    }

    if (normalizedDevice === "ljet4") {
        // PCL5 escape: &l2S = duplex long-edge, &l1S = duplex short-edge
        const simplexCode = 2; // 2 = duplex long-edge (portrait flip on left)
        const shortEdgeCode = 1; // 1 = duplex short-edge (landscape flip on top)
        const code = binding === "SHORTEDGE" ? shortEdgeCode : simplexCode;
        const pclDuplex = Buffer.from(`\x1b&l${code}S`, "ascii");
        return Buffer.concat([pclDuplex, data]);
    }

    // ps2write: duplex is set as Ghostscript args in renderPdfForPrinter,
    // not as a byte header, so there's nothing to prepend here.
    return data;
}

// ─── Zebra ZPL rendering (raster) ───────────────────────────────────────────
//
// Ghostscript has no ZPL output device, so instead of typesetting each field
// in ZPL directly, the whole rendered page is rasterized to a 1-bit bitmap
// and wrapped in a single ZPL ^GFA "Graphic Field" command — the label
// prints as one image. This trades a little print sharpness on curves for
// reusing the exact same PDF-building code (and font/barcode rendering) that
// already exists for every other printer, with no per-field ZPL translation
// needed.
//
// Ghostscript's pbmraw device (raw Netpbm PBM, 1 bit/pixel, MSB-first, rows
// padded to a whole byte, 1=black/0=white) uses the exact same bit
// convention as ZPL's Graphic Field, so this is a direct hex re-encoding —
// no pixel inversion or bit-order shuffling needed.

/**
 * Parses a raw PBM (P4) buffer — as produced by Ghostscript's pbmraw device
 * — into its pixel dimensions and packed 1bpp row data.
 */
export function parsePbmRaw(
    pbm: Buffer,
): { width: number; height: number; data: Buffer; bytesConsumed: number } {
    if (pbm[0] !== 0x50 || pbm[1] !== 0x34) {
        // "P4"
        throw new Error("Expected a raw PBM (P4) buffer from Ghostscript's pbmraw device");
    }

    // Netpbm header: magic, then whitespace-separated width/height tokens
    // (comment lines starting with '#' may appear between tokens), followed
    // by exactly one whitespace byte before the binary pixel data.
    let offset = 2;
    const dims: number[] = [];
    while (dims.length < 2) {
        while (offset < pbm.length && /\s/.test(String.fromCharCode(pbm[offset]!))) offset++;
        if (pbm[offset] === 0x23) {
            while (offset < pbm.length && pbm[offset] !== 0x0a) offset++;
            continue;
        }
        const start = offset;
        while (offset < pbm.length && !/\s/.test(String.fromCharCode(pbm[offset]!))) offset++;
        dims.push(parseInt(pbm.toString("ascii", start, offset), 10));
    }
    offset++; // the single whitespace byte separating header from pixel data

    const [width, height] = dims as [number, number];
    const bytesPerRow = Math.ceil(width / 8);
    const bytesConsumed = offset + bytesPerRow * height;
    const data = pbm.subarray(offset, bytesConsumed);
    return { width, height, data, bytesConsumed };
}

/**
 * Splits a Ghostscript pbmraw stream into its individual per-page PBM
 * buffers. For a multi-page PDF, pbmraw emits one "P4\n<w> <h>\n<data>"
 * image per page, back-to-back with no separator — reading only the first
 * one (as parsePbmRaw/pbmRawToZplLabel alone would) silently drops every
 * page after it.
 */
export function splitPbmRawPages(pbm: Buffer): Buffer[] {
    const pages: Buffer[] = [];
    let offset = 0;
    while (offset < pbm.length) {
        const { bytesConsumed } = parsePbmRaw(pbm.subarray(offset));
        pages.push(pbm.subarray(offset, offset + bytesConsumed));
        offset += bytesConsumed;
    }
    return pages;
}

/**
 * Wraps a raw PBM (P4) buffer into a complete Zebra ZPL label job: a ^GFA
 * graphic field holding the whole bitmap, inside a minimal ^XA...^XZ label
 * sized to the bitmap via ^PW/^LL. Pure/sync so it's directly testable
 * against a hand-built PBM buffer, same as applyDuplexToBuffer above.
 */
export function pbmRawToZplLabel(pbm: Buffer): Buffer {
    const { width, height, data } = parsePbmRaw(pbm);
    const bytesPerRow = Math.ceil(width / 8);
    const totalBytes = bytesPerRow * height;
    const hex = data.toString("hex").toUpperCase();

    return Buffer.from(
        [
            "^XA",
            `^PW${width}`,
            `^LL${height}`,
            "^FO0,0",
            `^GFA,${totalBytes},${totalBytes},${bytesPerRow},${hex}`,
            "^FS",
            "^XZ",
            "",
        ].join("\n"),
        "ascii",
    );
}

/**
 * Renders a PDF to a complete Zebra ZPL label job: rasterizes it via
 * Ghostscript's pbmraw device at `dpi`, then wraps the bitmap via
 * pbmRawToZplLabel. The returned buffer is plain ASCII — send it straight
 * to the printer's raw TCP port, no PJL/PCL wrapping involved.
 */
export async function renderPdfToZplBuffer(pdfPath: string, dpi: number): Promise<Buffer> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const { stdout } = await execFileAsync(
        GHOSTSCRIPT_BIN,
        ["-dBATCH", "-dNOPAUSE", "-dQUIET", "-sDEVICE=pbmraw", `-r${dpi}`, "-sOutputFile=-", pdfPath],
        { timeout: 60_000, encoding: "buffer" as any, maxBuffer: 1024 * 1024 * 50 },
    );

    // One ^XA...^XZ label per PDF page (see splitPbmRawPages) — a
    // multi-page prep label (one page per door/box) must print every page,
    // not just the first.
    const pages = splitPbmRawPages(stdout as unknown as Buffer);
    return Buffer.concat(pages.map(pbmRawToZplLabel));
}

/**
 * Renders a PDF into the printer's native language via Ghostscript,
 * returning the raw bytes ready to stream to the printer's socket.
 */
export async function renderPdfForPrinter(pdfPath: string): Promise<Buffer> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    const args = [
        "-dBATCH",
        "-dNOPAUSE",
        "-dQUIET",
        `-sDEVICE=${DOCUMENTS_PRINTER_DEVICE}`,
        `-r${DOCUMENTS_PRINTER_DPI}`,   // resolution — lower = faster render, same print quality for text/graphics
        "-sOutputFile=-", // stream to stdout instead of writing a file
    ];

    // For PostScript output, duplex is embedded as a gs argument rather
    // than a byte header — the other devices (pxlmono, pxlcolor, ljet4)
    // get their duplex instructions prepended to the rendered bytes later
    // in applyDuplexToBuffer.
    if (DOCUMENTS_PRINTER_DUPLEX && DOCUMENTS_PRINTER_DEVICE.toLowerCase() === "ps2write") {
        args.push("-dDuplex=true");
        args.push(
            DOCUMENTS_PRINTER_BINDING === "SHORTEDGE"
                ? "-dTumble=true"
                : "-dTumble=false",
        );
    }

    args.push(pdfPath);

    const { stdout } = await execFileAsync(GHOSTSCRIPT_BIN, args, {
        timeout: 120_000,
        encoding: "buffer" as any,
        maxBuffer: 1024 * 1024 * 200,
    });
    return stdout as unknown as Buffer;
}

/** Sends already-rendered printer-language bytes over a raw TCP socket. */
export function sendToDocumentsPrinter(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        const socket = new net.Socket();
        socket.connect(DOCUMENTS_PRINTER_PORT, DOCUMENTS_PRINTER_HOST, () => {
            socket.write(data, (err?: Error | null) => {
                if (err) {
                    socket.destroy();
                    reject(err);
                } else {
                    socket.end();
                    resolve();
                }
            });
        });
        socket.on("error", (err: Error) => {
            socket.destroy();
            reject(err);
        });
        socket.setTimeout(30000, () => {
            socket.destroy();
            reject(new Error("Documents printer timed out"));
        });
    });
}

/** Renders a PDF and sends it to the printer in one step. */
export async function printPdfFile(pdfPath: string): Promise<void> {
    const rendered = await renderPdfForPrinter(pdfPath);
    const withDuplex = applyDuplexToBuffer(
        rendered,
        DOCUMENTS_PRINTER_DEVICE,
        DOCUMENTS_PRINTER_DUPLEX,
        DOCUMENTS_PRINTER_BINDING,
    );
    await sendToDocumentsPrinter(withDuplex);
}

/**
 * Renders an in-memory PDF buffer and sends it to the prep label Godex
 * printer (PREP_LABEL_PRINTER_HOST). Used for the prep label (project number
 * barcode, employee name, etc.) which is a different physical printer from the
 * A4 documents printer.
 *
 * The buffer is written to a temp file so Ghostscript can read it (gs only
 * accepts file paths, not stdin). The temp file is cleaned up afterward
 * regardless of success or failure.
 *
 * Returns true if the label was sent to the printer, false if
 * PREP_LABEL_PRINTER_HOST is not configured OR printing is disabled via
 * the live switch (see printSettingsService) — callers can then decide
 * whether to fall back to returning the PDF to the mobile app instead.
 */
export async function printPrepLabelBuffer(pdfBuffer: Buffer): Promise<boolean> {
    if (!PREP_LABEL_PRINTER_HOST || !isPrintingEnabled()) {
        return false;
    }

    const os = await import("os");
    const tmpPath = path.join(
        os.tmpdir(),
        `prep_label_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`,
    );

    try {
        fs.writeFileSync(tmpPath, pdfBuffer);

        const rendered: Buffer =
            PREP_LABEL_PRINTER_DEVICE.toLowerCase() === "zpl"
                ? await renderPdfToZplBuffer(tmpPath, PREP_LABEL_PRINTER_DPI)
                : await (async () => {
                      const { execFile } = await import("child_process");
                      const { promisify } = await import("util");
                      const execFileAsync = promisify(execFile);
                      const args = [
                          "-dBATCH",
                          "-dNOPAUSE",
                          "-dQUIET",
                          `-sDEVICE=${PREP_LABEL_PRINTER_DEVICE}`,
                          `-r${PREP_LABEL_PRINTER_DPI}`,
                          "-sOutputFile=-",
                          tmpPath,
                      ];
                      const { stdout } = await execFileAsync(GHOSTSCRIPT_BIN, args, {
                          timeout: 60_000,
                          encoding: "buffer" as any,
                          maxBuffer: 1024 * 1024 * 50,
                      });
                      return stdout as unknown as Buffer;
                  })();

        await new Promise<void>((resolve, reject) => {
            const socket = new net.Socket();
            socket.connect(PREP_LABEL_PRINTER_PORT, PREP_LABEL_PRINTER_HOST, () => {
                socket.write(rendered, (err?: Error | null) => {
                    if (err) { socket.destroy(); reject(err); }
                    else { socket.end(); resolve(); }
                });
            });
            socket.on("error", (err: Error) => { socket.destroy(); reject(err); });
            socket.setTimeout(15000, () => {
                socket.destroy();
                reject(new Error("Prep label printer timed out"));
            });
        });

        console.log(
            `[PREP] Sent prep label (${PREP_LABEL_PRINTER_DEVICE}) to ${PREP_LABEL_PRINTER_HOST}:${PREP_LABEL_PRINTER_PORT}`,
        );
        return true;
    } finally {
        fs.unlink(tmpPath, () => {});
    }
}

// ─── PNG → one-page PDF ─────────────────────────────────────────────────────
//
// QR stickers arrive as flat PNG files. To go through the same Ghostscript
// pipeline as documents, we first wrap the PNG in a minimal, hand-built
// one-page PDF (no external dependency needed — a PDF with a single raw
// image XObject is only a few dozen lines of well-defined syntax). PNG's
// own IDAT stream is zlib/Deflate-compressed, which PDF's FlateDecode
// filter consumes directly, so the compressed PNG pixel data can be
// embedded byte-for-byte without re-encoding it.

export interface PngInfo {
    width: number;
    height: number;
    bitDepth: number;
    colorType: number; // 0=gray 2=rgb 3=palette 4=gray+alpha 6=rgb+alpha
    idat: Buffer; // concatenated, still-compressed IDAT payload
    palette: Buffer | undefined; // PLTE chunk, for colorType 3
}

function parsePng(buf: Buffer): PngInfo {
    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (!buf.subarray(0, 8).equals(sig)) {
        throw new Error("Not a valid PNG file");
    }

    let offset = 8;
    let width = 0,
        height = 0,
        bitDepth = 0,
        colorType = 0;
    const idatParts: Buffer[] = [];
    let palette: Buffer | undefined;

    while (offset < buf.length) {
        const len = buf.readUInt32BE(offset);
        const type = buf.toString("ascii", offset + 4, offset + 8);
        const dataStart = offset + 8;
        const data = buf.subarray(dataStart, dataStart + len);

        if (type === "IHDR") {
            width = data.readUInt32BE(0);
            height = data.readUInt32BE(4);
            bitDepth = data.readUInt8(8);
            colorType = data.readUInt8(9);
            const compression = data.readUInt8(10);
            const filter = data.readUInt8(11);
            const interlace = data.readUInt8(12);
            if (compression !== 0 || filter !== 0 || interlace !== 0) {
                throw new Error(
                    "Unsupported PNG encoding (interlaced or non-standard filter/compression)",
                );
            }
        } else if (type === "PLTE") {
            palette = Buffer.from(data);
        } else if (type === "IDAT") {
            idatParts.push(Buffer.from(data));
        } else if (type === "IEND") {
            break;
        }

        offset = dataStart + len + 4; // skip data + CRC
    }

    if (!width || !height) throw new Error("PNG missing IHDR data");
    if (colorType === 4 || colorType === 6) {
        throw new Error(
            "PNG alpha channel not supported for QR stickers — export the PNG without transparency",
        );
    }

    return {
        width,
        height,
        bitDepth,
        colorType,
        idat: Buffer.concat(idatParts),
        palette,
    };
}

function pngColorSpace(png: PngInfo): string {
    if (png.colorType === 0) return "/DeviceGray";
    if (png.colorType === 2) return "/DeviceRGB";
    if (png.colorType === 3) {
        if (!png.palette) throw new Error("PNG palette (PLTE) chunk missing");
        const hex = png.palette.toString("hex");
        return `[/Indexed /DeviceRGB ${png.palette.length / 3 - 1} <${hex}>]`;
    }
    throw new Error(`Unsupported PNG colorType ${png.colorType}`);
}

/**
 * Assembles a minimal single-page PDF embedding the PNG's still-compressed
 * IDAT stream directly (PDF's FlateDecode filter consumes it byte-for-byte,
 * no re-encoding needed), on a page of the given size with the image placed
 * via `contentStream`'s transform matrix. Shared by buildPdfFromPng (image's
 * own native size) and buildPdfFromPngFitted (a fixed label page size).
 */
function assemblePngPdf(
    png: PngInfo,
    pageWidthPt: number,
    pageHeightPt: number,
    contentStream: string,
): Buffer {
    // PNG prefixes every scanline with a filter-type byte; the PDF predictor
    // (15 = PNG, per-row) is what strips/undoes it. Without DecodeParms the
    // decoder treats those bytes as pixel data, every row is shifted by one
    // byte, and the image comes out as speckled noise (a QR code printed as
    // a black square with a few white dots).
    const colors = png.colorType === 2 ? 3 : 1; // RGB vs gray / indexed
    const imageDictParts = [
        "<< /Type /XObject /Subtype /Image",
        `/Width ${png.width} /Height ${png.height}`,
        `/BitsPerComponent ${png.bitDepth}`,
        `/ColorSpace ${pngColorSpace(png)}`,
        "/Filter /FlateDecode",
        `/DecodeParms << /Predictor 15 /Colors ${colors} /BitsPerComponent ${png.bitDepth} /Columns ${png.width} >>`,
        `/Length ${png.idat.length}`,
        ">>",
    ].join(" ");

    const ptWidth = pageWidthPt;
    const ptHeight = pageHeightPt;

    const objects: string[] = [];
    objects.push("<< /Type /Catalog /Pages 2 0 R >>"); // 1
    objects.push("<< /Type /Pages /Kids [3 0 R] /Count 1 >>"); // 2
    objects.push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${ptWidth.toFixed(2)} ${ptHeight.toFixed(2)}] ` +
            `/Resources << /XObject << /Im0 5 0 R >> >> /Contents 4 0 R >>`,
    ); // 3
    objects.push(
        `<< /Length ${contentStream.length} >>\nstream\n${contentStream}\nendstream`,
    ); // 4
    // object 5 (the image) is written separately below because it has binary content

    const chunks: Buffer[] = [];
    const offsets: number[] = [0]; // offsets[0] unused (object 0 is free)
    let pos = 0;

    const push = (s: string | Buffer) => {
        const b = typeof s === "string" ? Buffer.from(s, "latin1") : s;
        chunks.push(b);
        pos += b.length;
    };

    push("%PDF-1.4\n");

    for (let i = 0; i < objects.length; i++) {
        offsets.push(pos);
        push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
    }

    // object 5: the image, written with raw binary IDAT data
    offsets.push(pos);
    push(`5 0 obj\n${imageDictParts}\nstream\n`);
    push(png.idat);
    push("\nendstream\nendobj\n");

    const xrefStart = pos;
    const totalObjs = 6; // objects 1-5 + object 0
    push(`xref\n0 ${totalObjs}\n`);
    push("0000000000 65535 f \n");
    for (let i = 1; i < totalObjs; i++) {
        const offset = offsets[i] ?? 0;
        push(`${offset.toString().padStart(10, "0")} 00000 n \n`);
    }
    push(
        `trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`,
    );

    return Buffer.concat(chunks);
}

/**
 * Builds a minimal single-page PDF containing the PNG at its native pixel
 * size, converted to points at 96 DPI (matches how the PNGs were exported).
 */
function buildPdfFromPng(png: PngInfo): Buffer {
    const DPI = 96;
    const ptWidth = (png.width * 72) / DPI;
    const ptHeight = (png.height * 72) / DPI;
    const contentStream = `q ${ptWidth.toFixed(2)} 0 0 ${ptHeight.toFixed(2)} 0 0 cm /Im0 Do Q`;
    return assemblePngPdf(png, ptWidth, ptHeight, contentStream);
}

/**
 * Builds a single-page PDF with the PNG scaled to FIT (preserving aspect
 * ratio, centered — never distorted or cropped) inside a fixed
 * pageWidthPt × pageHeightPt page, instead of the image's own native size.
 * Used to print a QR sticker on the SAME physical label stock as the
 * barcode label that triggered it (see PREP_LABEL_PAGE_WIDTH_PT/HEIGHT_PT
 * and renderPngAsZplLabel), whatever resolution the source PNG was made at.
 */
export function buildPdfFromPngFitted(
    png: PngInfo,
    pageWidthPt: number,
    pageHeightPt: number,
): Buffer {
    const DPI = 96;
    const imgWidthPt = (png.width * 72) / DPI;
    const imgHeightPt = (png.height * 72) / DPI;
    const scale = Math.min(pageWidthPt / imgWidthPt, pageHeightPt / imgHeightPt);
    const drawWidth = imgWidthPt * scale;
    const drawHeight = imgHeightPt * scale;
    const offsetX = (pageWidthPt - drawWidth) / 2;
    const offsetY = (pageHeightPt - drawHeight) / 2;
    const contentStream =
        `q ${drawWidth.toFixed(2)} 0 0 ${drawHeight.toFixed(2)} ` +
        `${offsetX.toFixed(2)} ${offsetY.toFixed(2)} cm /Im0 Do Q`;
    return assemblePngPdf(png, pageWidthPt, pageHeightPt, contentStream);
}

/**
 * Converts a PNG file into a temp one-page PDF and returns its path.
 * Caller is responsible for deleting it (see printPngFile).
 */
function pngFileToTempPdf(pngPath: string): string {
    const pngBuf = fs.readFileSync(pngPath);
    const png = parsePng(pngBuf);
    const pdfBuf = buildPdfFromPng(png);
    const tmpPath = path.join(
        os.tmpdir(),
        `qr-${crypto.randomBytes(8).toString("hex")}.pdf`,
    );
    fs.writeFileSync(tmpPath, pdfBuf);
    return tmpPath;
}

/**
 * Prints a PNG file N times to the configured document printer.
 * Renders once via Ghostscript, then streams the same rendered bytes to
 * the printer `copies` times (no need to re-render per copy).
 */
export async function printPngFile(
    pngPath: string,
    copies: number,
): Promise<void> {
    const tmpPdfPath = pngFileToTempPdf(pngPath);
    try {
        const rendered = await renderPdfForPrinter(tmpPdfPath);
        for (let i = 0; i < copies; i++) {
            await sendToDocumentsPrinter(rendered);
        }
    } finally {
        fs.unlink(tmpPdfPath, () => {});
    }
}

/**
 * Converts a PNG file into a temp one-page PDF fitted to a fixed label
 * page size (see buildPdfFromPngFitted) and returns its path. Caller is
 * responsible for deleting it (see renderPngAsZplLabel).
 */
function pngFileToLabelPdf(
    pngPath: string,
    pageWidthPt: number,
    pageHeightPt: number,
): string {
    const pngBuf = fs.readFileSync(pngPath);
    const png = parsePng(pngBuf);
    const pdfBuf = buildPdfFromPngFitted(png, pageWidthPt, pageHeightPt);
    const tmpPath = path.join(
        os.tmpdir(),
        `qr-label-${crypto.randomBytes(8).toString("hex")}.pdf`,
    );
    fs.writeFileSync(tmpPath, pdfBuf);
    return tmpPath;
}

/**
 * Renders a PNG (e.g. a QR sticker) as a complete ZPL label job — fitted to
 * pageWidthPt × pageHeightPt at `dpi` via Ghostscript's pbmraw device, then
 * wrapped into a ^GFA graphic field by renderPdfToZplBuffer/pbmRawToZplLabel
 * — for printing on a Zebra/ZPL-language label printer, same media as
 * whatever barcode label triggered it. Caller sends the returned buffer
 * (see labelPrintingService.sendToLabelPrinter); this only renders.
 */
export async function renderPngAsZplLabel(
    pngPath: string,
    pageWidthPt: number,
    pageHeightPt: number,
    dpi: number,
): Promise<Buffer> {
    const tmpPdfPath = pngFileToLabelPdf(pngPath, pageWidthPt, pageHeightPt);
    try {
        return await renderPdfToZplBuffer(tmpPdfPath, dpi);
    } finally {
        fs.unlink(tmpPdfPath, () => {});
    }
}

// ─── prep-station label PDF ─────────────────────────────────────────────────
//
// Label PDF for the external-items prep station, sized for the Godex
// EZ2250i label printer: 100 × 130 mm — the same stock the production
// labels use (EZPL ^W100 / ^Q130 in labelPrintingService.ts; at the
// printer's 203 dpi that maps to ≈796 × 1034 dots, matching the ≈794 ×
// 1033 dot canvas of the captured aktualniCMD .prn). Ghostscript renders
// this PDF with the same pipeline as every other document
// (renderPdfForPrinter), so no EZPL is needed here.
//
// The label carries the order/project number, position, who prepared it,
// a timestamp, the box counter (when the order has more than one), and a
// Code 39 ("3 of 9") barcode of the project number rendered with the
// BC 3of9 Light barcode font — see utils/code39Barcode.ts. When that font
// file can't be found, the barcode falls back to vector-drawn bars so the
// label stays scannable regardless.
//
// Built by hand (no PDF library) the same way buildPdfFromPng is, using
// PDF built-in fonts plus (when available) the embedded TrueType barcode
// font — embedding is what makes the barcode print correctly on the
// printer, which otherwise has no BC 3of9 Light installed.

function escapePdfText(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Builds the barcode block content ops for one label page.
 *
 * Font path (BC 3of9 Light found): the sanitized project number wrapped in
 * * delimiters is drawn with the embedded TrueType font, sized so the
 * symbol fits the printable width (the exact advance widths come from the
 * font's hmtx table, so the fit is precise, not estimated).
 *
 * Vector fallback: bars are drawn from the Code 39 element table at a
 * narrow-element width chosen to fit the same printable width.
 *
 * Both paths add a small human-readable line under the bars. Returns an
 * empty string when there is nothing to encode.
 */
function buildBarcodeOps(
    font: TrueTypeFontInfo | null,
    projectNumber: string,
): string {
    const sanitized = sanitizeCode39(projectNumber);
    if (!sanitized) return "";

    const printableWidth = PREP_LABEL_PAGE_WIDTH_PT - 24; // 12pt margins
    const ops: string[] = [];

    if (font) {
        try {
            const text = `*${sanitized}*`;
            const advance = stringAdvance(font, text);
            if (advance > 0) {
                const fitSize =
                    (printableWidth * font.unitsPerEm) / advance;
                const size = Math.max(8, Math.min(72, fitSize));
                const widthPt = (advance * size) / font.unitsPerEm;
                const x = (PREP_LABEL_PAGE_WIDTH_PT - widthPt) / 2;
                const baselineY = PREP_LABEL_PAGE_HEIGHT_PT - 212;
                ops.push(
                    `BT /F2 ${size.toFixed(2)} Tf ${x.toFixed(2)} ${baselineY.toFixed(2)} Td (${escapePdfString(text)}) Tj ET`,
                );
                // Human-readable interpretation line, centered (Helvetica
                // average advance ≈ 0.55 em — estimate is fine for centering).
                const readableSize = 11;
                const readableWidth = sanitized.length * readableSize * 0.55;
                const rx = (PREP_LABEL_PAGE_WIDTH_PT - readableWidth) / 2;
                ops.push(
                    `BT /F1 ${readableSize} Tf ${rx.toFixed(2)} ${(PREP_LABEL_PAGE_HEIGHT_PT - 230).toFixed(2)} Td (${escapePdfString(sanitized)}) Tj ET`,
                );
            }
        } catch (err: any) {
            // Font parse/measure failure — fall through to vector bars
            // rather than printing a label without a barcode.
            console.warn(
                `[PRINT] Barcode font unusable (${err.message}) — drawing vector barcode`,
            );
        }
    }

    if (ops.length === 0) {
        // Vector fallback (or font embedding failed above). The narrow
        // element width is auto-sized so the WHOLE symbol fits the
        // printable width — Code 39 grows ~15 narrow units per character,
        // so a fixed width would clip longer project numbers off the
        // label edge. 2.6pt is the cap for short numbers (≈8px at the
        // Godex's 203 dpi — comfortably above the 2px minimum printers
        // resolve reliably).
        const units = code39Geometry(sanitized, 1).totalWidth; // narrow = 1pt baseline
        const narrowPt = Math.min(2.6, printableWidth / units);
        const { ops: barOps, totalWidth } = code39VectorOps(
            sanitized,
            0,
            PREP_LABEL_PAGE_HEIGHT_PT - 214,
            46,
            narrowPt,
        );
        // code39VectorOps draws from its x argument; shift the whole symbol
        // so it's centered by translating: emit a cm transform around it.
        const x = (PREP_LABEL_PAGE_WIDTH_PT - totalWidth) / 2;
        ops.push(
            `q 1 0 0 1 ${x.toFixed(2)} 0 cm`,
            barOps,
            "Q",
        );
        const readableSize = 11;
        const readableWidth = sanitized.length * readableSize * 0.55;
        const rx = (PREP_LABEL_PAGE_WIDTH_PT - readableWidth) / 2;
        ops.push(
            `BT /F1 ${readableSize} Tf ${rx.toFixed(2)} ${(PREP_LABEL_PAGE_HEIGHT_PT - 230).toFixed(2)} Td (${escapePdfString(sanitized)}) Tj ET`,
        );
    }

    return ops.join("\n");
}

/**
 * Builds a 100 × 130 mm Godex label PDF identifying an order/position and
 * who prepared it, with a timestamp and a Code 39 barcode of the project
 * number — one page per cycle (box) when totalCycles > 1, each labeled
 * "cycleIndex/totalCycles" so a batch of physical boxes for the same
 * order/position/project can be told apart. totalCycles defaults to 1
 * for a single-box order. Uses WinAnsiEncoding so common accented Latin
 * characters (á, é, í, ó, ú, ý, ...) render correctly — NOTE: Czech-specific
 * letters not present in WinAnsi (č, ř, š, ž, ě, ď, ť, ň) will not render
 * correctly with these base fonts; a real Czech name may show those letters
 * missing or wrong. Proper support would need an embedded TrueType text
 * font (the barcode font IS embedded when found — see
 * utils/code39Barcode.ts).
 */
export function buildPrepLabelPdf(
    projectNumber: string,
    position: string,
    employeeName: string,
    totalCycles: number = 1,
    salesOrder: string | null = null,
    productionOrderNumber: string | null = null,
): Buffer {
    const now = new Date();
    const dateStr = now.toLocaleDateString("cs-CZ");
    const timeStr = now.toLocaleTimeString("cs-CZ", {
        hour: "2-digit",
        minute: "2-digit",
    });

    const pageWidth = PREP_LABEL_PAGE_WIDTH_PT;
    const pageHeight = PREP_LABEL_PAGE_HEIGHT_PT;
    const pageCount = Math.max(1, totalCycles);

    // Locate + parse the barcode font once per call; null → the barcode
    // is drawn as vector bars instead (see buildBarcodeOps).
    let barcodeFont: TrueTypeFontInfo | null = null;
    const fontPath = findCode39FontFile();
    if (fontPath) {
        try {
            barcodeFont = parseTrueType(fs.readFileSync(fontPath));
        } catch (err: any) {
            console.warn(
                `[PRINT] Barcode font ${fontPath} unusable (${err.message}) — drawing vector barcode`,
            );
        }
    }
    // Use the production order number in the barcode when available (it's
    // what warehouse scanners read to identify the physical job). Fall back
    // to the project number if the Norms lookup didn't find a match.
    const barcodeValue = productionOrderNumber || projectNumber;
    const barcodeOps = buildBarcodeOps(barcodeFont, barcodeValue);

    // y values are measured from the TOP of the label here and converted to
    // PDF user space (origin bottom-left) at emit time.
    function pageContentOps(cycleIndex: number): string {
        const lines: { text: string; size: number; y: number; bold?: boolean }[] = [
            { text: "ZAK\xc1ZKA", size: 10, y: 22 },
            { text: projectNumber, size: 22, y: 46, bold: true },
        ];

        if (salesOrder) {
            lines.push(
                { text: "PRODEJN\xcd OBJ.", size: 10, y: 76 },
                { text: salesOrder, size: 18, y: 98, bold: true },
            );
        }

        const posYLabel = salesOrder ? 122 : 76;
        const posYVal = salesOrder ? 146 : 98;
        lines.push(
            { text: "POZICE", size: 10, y: posYLabel },
            { text: position, size: 22, y: posYVal, bold: true },
        );

        if (productionOrderNumber) {
            // intentionally empty — the number is already encoded in the
            // barcode and printed as the human-readable line beneath it
        }

        lines.push(
            { text: `Pripravil: ${employeeName}`, size: 10, y: 264 },
            { text: `${dateStr} ${timeStr}`, size: 9, y: 279 },
        );

        if (pageCount > 1) {
            lines.push(
                { text: "VRATA", size: 10, y: 295 },
                { text: `${cycleIndex}/${pageCount}`, size: 20, y: 318, bold: true },
            );
        }

        return lines
            .map(
                (l) =>
                    `BT /F${l.bold ? "3" : "1"} ${l.size} Tf 40 ${(pageHeight - l.y).toFixed(2)} Td (${escapePdfText(l.text)}) Tj ET`,
            )
            .concat(barcodeOps ? [barcodeOps] : [])
            .join("\n");
    }

    // The parsed font carries its raw TTF bytes for embedding. When present
    // it adds three objects: /Font F2, its /FontDescriptor and the
    // /FontFile2 stream with the raw TTF bytes.
    const barcodeFontFile = barcodeFont ? barcodeFont.fontData : null;

    // Object layout (N = pageCount):
    //   1 = Catalog, 2 = Pages,
    //   3..3+N-1 = Page objects, 3+N..3+2N-1 = per-page Content streams,
    //   then F1 (Helvetica), F3 (Helvetica-Bold), and — when the barcode
    //   font is available — F2 (TrueType), FontDescriptor, FontFile2.
    // Kept dynamic (not hardcoded object numbers) so this generalizes
    // cleanly from the original fixed 5-object single-page layout to N pages.
    const pageObjBase = 3;
    const contentObjBase = pageObjBase + pageCount;
    const f1ObjNum = contentObjBase + pageCount;
    const f3ObjNum = f1ObjNum + 1;
    const f2ObjNum = f3ObjNum + 1; // only allocated when barcodeFontFile
    const descObjNum = f2ObjNum + 1;
    const fileObjNum = descObjNum + 1;

    const pageKids = Array.from(
        { length: pageCount },
        (_, i) => `${pageObjBase + i} 0 R`,
    ).join(" ");

    const fontResources = barcodeFontFile
        ? `<< /F1 ${f1ObjNum} 0 R /F3 ${f3ObjNum} 0 R /F2 ${f2ObjNum} 0 R >>`
        : `<< /F1 ${f1ObjNum} 0 R /F3 ${f3ObjNum} 0 R >>`;

    const objects: (string | { dict: string; data: Buffer })[] = [];
    objects.push(`<< /Type /Catalog /Pages 2 0 R >>`); // 1
    objects.push(
        `<< /Type /Pages /Kids [${pageKids}] /Count ${pageCount} >>`,
    ); // 2

    for (let i = 0; i < pageCount; i++) {
        const contentObjNum = contentObjBase + i;
        objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
                `/Resources << /Font ${fontResources} >> /Contents ${contentObjNum} 0 R >>`,
        ); // pageObjBase + i
    }

    for (let i = 0; i < pageCount; i++) {
        const textOps = pageContentOps(i + 1);
        objects.push(
            `<< /Length ${Buffer.byteLength(textOps, "latin1")} >>\nstream\n${textOps}\nendstream`,
        ); // contentObjBase + i
    }

    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ); // f1ObjNum
    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>",
    ); // f3ObjNum

    if (barcodeFont && barcodeFontFile) {
        const { descriptorDict, fontFileDict, fontDict } =
            buildTrueTypeFontObjects(barcodeFont);
        objects.push(fontDict.replace("%FONT_DESC_OBJ%", String(descObjNum))); // f2ObjNum
        objects.push(descriptorDict.replace("%FONT_FILE_OBJ%", String(fileObjNum))); // descObjNum
        // One object = dict + binary stream. The TTF bytes must never pass
        // through a latin1 string (they'd be mangled), so they stay a Buffer
        // and are written verbatim between stream/endstream.
        objects.push({ dict: fontFileDict, data: barcodeFontFile }); // fileObjNum
    }

    const chunks: Buffer[] = [];
    const offsets: number[] = [0];
    let pos = 0;
    const push = (s: string | Buffer) => {
        const b = typeof s === "string" ? Buffer.from(s, "latin1") : s;
        chunks.push(b);
        pos += b.length;
    };

    push("%PDF-1.4\n");
    for (let i = 0; i < objects.length; i++) {
        offsets.push(pos);
        const obj = objects[i]!;
        if (typeof obj === "string") {
            push(`${i + 1} 0 obj\n${obj}\nendobj\n`);
        } else {
            // Binary stream object (FontFile2).
            push(`${i + 1} 0 obj\n${obj.dict}\nstream\n`);
            push(obj.data);
            push("\nendstream\nendobj\n");
        }
    }

    const xrefStart = pos;
    const totalObjs = objects.length + 1;
    push(`xref\n0 ${totalObjs}\n`);
    push("0000000000 65535 f \n");
    for (let i = 1; i < totalObjs; i++) {
        const offset = offsets[i] ?? 0;
        push(`${offset.toString().padStart(10, "0")} 00000 n \n`);
    }
    push(`trailer\n<< /Size ${totalObjs} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF`);

    return Buffer.concat(chunks);
}
