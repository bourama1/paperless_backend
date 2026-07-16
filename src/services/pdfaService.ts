import { execFile } from "child_process";
import { promisify } from "util";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";

const execFileAsync = promisify(execFile);

/**
 * Real PDF/A conversion via Ghostscript.
 *
 * Ghostscript is free (AGPL), pre-installed on most Linux servers and
 * available for Windows, and is the tool basically every other open-source
 * PDF/A pipeline (OCRmyPDF, LibreOffice's PDF/A export, etc.) shells out to
 * under the hood — there isn't a mature pure-JS library that does real
 * PDF/A conversion (embedding fonts, converting colour spaces, adding a
 * valid OutputIntent) the way Ghostscript does.
 *
 * This replaces the old hand-rolled pdf-lib patch, which could only ever
 * bolt on metadata — it had no way to actually embed missing fonts or
 * convert colour spaces, which are just as required for PDF/A compliance
 * as the OutputIntent.
 */

const GHOSTSCRIPT_BIN = process.env.GHOSTSCRIPT_PATH || "gs";

const ICC_PROFILE_PATH = path.join(
    __dirname,
    "..",
    "config",
    "icc",
    "sRGB2014.icc",
);
const PDFA_DEF_TEMPLATE_PATH = path.join(
    __dirname,
    "..",
    "config",
    "pdfa",
    "PDFA_def_template.ps",
);

export type PdfaLevel = 1 | 2 | 3;

export interface ConvertToPdfaOptions {
    /** PDF/A part. 2b is the most broadly useful default (allows JPEG2000/transparency). */
    level?: PdfaLevel;
    /** Populates the PDF's /Title (and the PDFA_def.ps DOCINFO /Title). */
    title?: string;
}

/** Escapes a string for safe use inside a PostScript "(...)" literal. */
function escapePsString(value: string): string {
    return value
        .replace(/\\/g, "\\\\")
        .replace(/\(/g, "\\(")
        .replace(/\)/g, "\\)");
}

class GhostscriptNotFoundError extends Error {
    constructor() {
        super(
            `Ghostscript executable ("${GHOSTSCRIPT_BIN}") was not found. Install Ghostscript on this machine ` +
                `(https://ghostscript.com/releases/gsdnld.html) or set GHOSTSCRIPT_PATH to the full path of the binary.`,
        );
        this.name = "GhostscriptNotFoundError";
    }
}

export class PdfaConversionError extends Error {
    constructor(
        message: string,
        public readonly stderr?: string,
    ) {
        super(message);
        this.name = "PdfaConversionError";
    }
}

/**
 * Converts `inputPath` into a real PDF/A file at `outputPath` using
 * Ghostscript's pdfwrite device. This handles the parts a metadata-only
 * patch cannot: converting colour spaces, embedding all fonts, and adding a
 * properly-formed OutputIntent with a real embedded ICC profile.
 */
export async function convertToPdfA(
    inputPath: string,
    outputPath: string,
    options: ConvertToPdfaOptions = {},
): Promise<void> {
    const { level = 2, title = "Document" } = options;

    if (!fs.existsSync(inputPath)) {
        throw new PdfaConversionError(`Input file not found: ${inputPath}`);
    }

    // Build a per-conversion PDFA_def.ps from the bundled template, with the
    // /Title and /ICCProfile fields filled in and escaped for PostScript.
    const template = fs.readFileSync(PDFA_DEF_TEMPLATE_PATH, "utf-8");
    const iccPathForPs = ICC_PROFILE_PATH.replace(/\\/g, "/"); // gs accepts forward slashes on Windows too
    const customized = template
        .replace("/Title (Title)", `/Title (${escapePsString(title)})`)
        .replace(
            "/ICCProfile (srgb.icc)",
            `/ICCProfile (${escapePsString(iccPathForPs)})`,
        );

    const tmpDefPath = path.join(
        os.tmpdir(),
        `pdfa-def-${crypto.randomBytes(8).toString("hex")}.ps`,
    );
    fs.writeFileSync(tmpDefPath, customized, "utf-8");

    const outDir = path.dirname(outputPath);
    if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
    }

    const args = [
        `-dPDFA=${level}`,
        "-dBATCH",
        "-dNOPAUSE",
        "-dNOOUTERSAVE",
        "-sColorConversionStrategy=RGB",
        "-sProcessColorModel=DeviceRGB",
        "-sDEVICE=pdfwrite",
        // 1 = keep going and drop non-compliant content rather than aborting outright,
        // logging a warning instead — matches "best effort" behaviour of other
        // PDF/A tools when a source PDF has something unusual in it.
        "-dPDFACompatibilityPolicy=1",
        `--permit-file-read=${ICC_PROFILE_PATH}`,
        `-sOutputFile=${outputPath}`,
        tmpDefPath,
        inputPath,
    ];

    try {
        const { stderr } = await execFileAsync(GHOSTSCRIPT_BIN, args, {
            timeout: 120_000,
        });
        if (stderr && stderr.trim().length > 0) {
            // Ghostscript writes warnings (not necessarily fatal) to stderr even on success.
            console.warn(
                `[PDF/A] Ghostscript warnings for ${path.basename(inputPath)}: ${stderr.trim()}`,
            );
        }
    } catch (err: any) {
        if (err?.code === "ENOENT") {
            throw new GhostscriptNotFoundError();
        }
        throw new PdfaConversionError(
            `Ghostscript conversion failed for ${inputPath}: ${err?.message || err}`,
            err?.stderr,
        );
    } finally {
        fs.unlink(tmpDefPath, () => {});
    }

    if (!fs.existsSync(outputPath)) {
        throw new PdfaConversionError(
            `Ghostscript reported success but no output file was produced at ${outputPath}`,
        );
    }
}
