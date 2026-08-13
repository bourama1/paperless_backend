/**
 * documentPrinterService.ts
 *
 * Shared "print to a network printer by IP" pipeline. Used by:
 *   - workstationService.ts   → PBOM/declaration/confirmation PDFs
 *   - labelPrintingService.ts → QR stickers (PNG, wrapped into a one-page PDF)
 *
 * Both target the SAME printer (DOCUMENTS_PRINTER_HOST) — there is
 * intentionally only one set of printer env vars now. Godex label printing
 * is unrelated and keeps its own UNC-share config in labelPrintingService.ts.
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
 */

import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import crypto from "crypto";
import { GHOSTSCRIPT_BIN } from "./pdfaService";

export const DOCUMENTS_PRINTER_HOST = process.env.DOCUMENTS_PRINTER_HOST || "";
export const DOCUMENTS_PRINTER_PORT = parseInt(
    process.env.DOCUMENTS_PRINTER_PORT || "9100",
    10,
);
export const DOCUMENTS_PRINTER_DEVICE =
    process.env.DOCUMENTS_PRINTER_DEVICE || "pxlmono";

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
        "-sOutputFile=-", // stream to stdout instead of writing a file
        pdfPath,
    ];

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
    await sendToDocumentsPrinter(rendered);
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

interface PngInfo {
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

/**
 * Builds a minimal single-page PDF containing the PNG at its native pixel
 * size, converted to points at 96 DPI (matches how the PNGs were exported).
 */
function buildPdfFromPng(png: PngInfo): Buffer {
    const DPI = 96;
    const ptWidth = (png.width * 72) / DPI;
    const ptHeight = (png.height * 72) / DPI;

    let colorSpace: string;
    if (png.colorType === 0) {
        colorSpace = "/DeviceGray";
    } else if (png.colorType === 2) {
        colorSpace = "/DeviceRGB";
    } else if (png.colorType === 3) {
        if (!png.palette) throw new Error("PNG palette (PLTE) chunk missing");
        const hex = png.palette.toString("hex");
        colorSpace = `[/Indexed /DeviceRGB ${png.palette.length / 3 - 1} <${hex}>]`;
    } else {
        throw new Error(`Unsupported PNG colorType ${png.colorType}`);
    }

    const imageDictParts = [
        "<< /Type /XObject /Subtype /Image",
        `/Width ${png.width} /Height ${png.height}`,
        `/BitsPerComponent ${png.bitDepth}`,
        `/ColorSpace ${colorSpace}`,
        "/Filter /FlateDecode",
        `/Length ${png.idat.length}`,
        ">>",
    ].join(" ");

    const contentStream = `q ${ptWidth.toFixed(2)} 0 0 ${ptHeight.toFixed(2)} 0 0 cm /Im0 Do Q`;

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

// ─── prep-station label PDF ─────────────────────────────────────────────────
//
// A plain, generic PDF for the external-items prep station — deliberately
// NOT tied to any specific printer (Godex/EZPL or otherwise), since the
// target printer for this station hasn't been decided yet. Whoever prints
// it can just send this PDF to whatever printer ends up being used.
//
// Built by hand (no PDF library) the same way buildPdfFromPng is, but using
// PDF's built-in Helvetica font instead of an embedded image — a base-14
// font needs no embedding, so this stays tiny and dependency-free.

function escapePdfText(s: string): string {
    return s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

/**
 * Builds an A4 PDF identifying an order/position and who prepared it, with
 * a timestamp — one page per cycle (box) when totalCycles > 1, each
 * labeled "cycleIndex/totalCycles" so a batch of physical boxes for the
 * same order/position/project can be told apart. totalCycles defaults to 1
 * for a single-box order. Uses WinAnsiEncoding so common accented Latin
 * characters (á, é, í, ó, ú, ý, ...) render correctly — NOTE: Czech-specific
 * letters not present in WinAnsi (č, ř, š, ž, ě, ď, ť, ň) will not render
 * correctly with this base font; a real Czech name may show those letters
 * missing or wrong. Proper support would need an embedded TrueType font —
 * fine for now given this is a provisional label until the real printer
 * (and label format) is decided.
 */
export function buildPrepLabelPdf(
    projectNumber: string,
    position: string,
    employeeName: string,
    totalCycles: number = 1,
): Buffer {
    const now = new Date();
    const dateStr = now.toLocaleDateString("cs-CZ");
    const timeStr = now.toLocaleTimeString("cs-CZ", {
        hour: "2-digit",
        minute: "2-digit",
    });

    const pageWidth = 595.28; // A4, points
    const pageHeight = 841.89;
    const pageCount = Math.max(1, totalCycles);

    function pageContentOps(cycleIndex: number): string {
        const lines: { text: string; size: number; y: number }[] = [
            { text: "OBJEDNAVKA", size: 20, y: pageHeight - 120 },
            { text: projectNumber, size: 48, y: pageHeight - 175 },
            { text: "POZICE", size: 20, y: pageHeight - 260 },
            { text: position, size: 48, y: pageHeight - 315 },
            { text: `Pripravil: ${employeeName}`, size: 16, y: pageHeight - 380 },
            { text: `${dateStr} ${timeStr}`, size: 12, y: pageHeight - 405 },
        ];
        // Only show the cycle/box counter when there's more than one box —
        // a single-box order's label stays exactly as it was before.
        if (pageCount > 1) {
            lines.push(
                { text: "BALENI", size: 20, y: pageHeight - 460 },
                { text: `${cycleIndex}/${pageCount}`, size: 36, y: pageHeight - 505 },
            );
        }
        return lines
            .map(
                (l) =>
                    `BT /F1 ${l.size} Tf 60 ${l.y.toFixed(2)} Td (${escapePdfText(l.text)}) Tj ET`,
            )
            .join("\n");
    }

    // Object layout: 1 = Catalog, 2 = Pages, 3..3+N-1 = Page objects,
    // 3+N..3+2N-1 = per-page Content streams, 3+2N = shared Font. Kept
    // dynamic (not hardcoded object numbers) so this generalizes cleanly
    // from the original fixed 5-object single-page layout to N pages.
    const pageObjBase = 3;
    const contentObjBase = pageObjBase + pageCount;
    const fontObjNum = contentObjBase + pageCount;

    const pageKids = Array.from(
        { length: pageCount },
        (_, i) => `${pageObjBase + i} 0 R`,
    ).join(" ");

    const objects: string[] = [];
    objects.push(`<< /Type /Catalog /Pages 2 0 R >>`); // 1
    objects.push(
        `<< /Type /Pages /Kids [${pageKids}] /Count ${pageCount} >>`,
    ); // 2

    for (let i = 0; i < pageCount; i++) {
        const contentObjNum = contentObjBase + i;
        objects.push(
            `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageWidth} ${pageHeight}] ` +
                `/Resources << /Font << /F1 ${fontObjNum} 0 R >> >> /Contents ${contentObjNum} 0 R >>`,
        ); // pageObjBase + i
    }

    for (let i = 0; i < pageCount; i++) {
        const textOps = pageContentOps(i + 1);
        objects.push(`<< /Length ${textOps.length} >>\nstream\n${textOps}\nendstream`); // contentObjBase + i
    }

    objects.push(
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
    ); // fontObjNum

    const chunks: Buffer[] = [];
    const offsets: number[] = [0];
    let pos = 0;
    const push = (s: string) => {
        const b = Buffer.from(s, "latin1");
        chunks.push(b);
        pos += b.length;
    };

    push("%PDF-1.4\n");
    for (let i = 0; i < objects.length; i++) {
        offsets.push(pos);
        push(`${i + 1} 0 obj\n${objects[i]}\nendobj\n`);
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
