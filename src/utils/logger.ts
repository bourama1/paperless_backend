// Minimal dependency-free logger.
//
// Every message is written to the console (with a colored level tag when
// stdout is a TTY) AND appended to app.log in the project root with a full
// timestamp, level and origin tag. `*.log` is already gitignored.
//
// initFileLogging() additionally patches console.log/info/warn/error so the
// ~120 pre-existing console.* call sites across services/controllers also
// land in app.log — without changing how they look on the console. It must
// run as early as possible (right after dotenv.config()) so module-level
// console calls are captured as well.

import fs from "fs";
import path from "path";

export type LogLevel = "debug" | "info" | "warn" | "error";

// LOG_LEVEL: debug | info | warn | error (default: info). Messages below
// the configured level are skipped (file AND console).
const LEVELS: Record<LogLevel, number> = {
    debug: 10,
    info: 20,
    warn: 30,
    error: 40,
};

const configuredLevel = (
    process.env.LOG_LEVEL || "info"
).toLowerCase() as LogLevel;

const minLevel = LEVELS[configuredLevel] ?? LEVELS.info;

const COLORS: Record<LogLevel, string> = {
    debug: "\x1b[90m", // gray
    info: "\x1b[36m", // cyan
    warn: "\x1b[33m", // yellow
    error: "\x1b[31m", // red
};
const RESET = "\x1b[0m";

// Strips ANSI escape sequences (e.g. morgan's "dev" color codes) so the
// log file stays plain text.
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// ─── File output ────────────────────────────────────────────────────────────
// Lazily created on first write; if the file can't be opened (read-only dir,
// etc.) we silently fall back to console-only logging instead of crashing
// the server over a logging problem.

const LOG_FILE_PATH = path.resolve(
    process.cwd(),
    process.env.LOG_FILE_PATH || "app.log",
);

let logStream: fs.WriteStream | null = null;
let fileLoggingDisabled = false;

function getLogStream(): fs.WriteStream | null {
    if (logStream) return logStream;
    if (fileLoggingDisabled) return null;

    try {
        // Append across restarts; the .gitignore covers *.log.
        logStream = fs.createWriteStream(LOG_FILE_PATH, { flags: "a" });
        // A full disk or removed log file must not take down the backend.
        logStream.on("error", () => {
            fileLoggingDisabled = true;
            logStream = null;
        });
        return logStream;
    } catch {
        fileLoggingDisabled = true;
        return null;
    }
}

function formatValue(value: unknown): string {
    if (typeof value === "string") return value;
    if (value instanceof Error) {
        return value.stack || `${value.name}: ${value.message}`;
    }
    // Best effort JSON; falls back to String() on cycles.
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function emit(
    level: LogLevel,
    origin: string,
    args: unknown[],
    options: { toConsole?: boolean } = {},
) {
    if (LEVELS[level] < minLevel) return;

    const message = args.map(formatValue).join(" ");
    const timestamp = new Date().toISOString();
    const tag = origin ? `[${origin}] ` : "";
    const line = `${timestamp} [${level.toUpperCase()}] ${tag}${message}`;

    if (options.toConsole !== false) {
        // Console: colored level tag when attached to a terminal.
        const consoleOut = process.stdout.isTTY
            ? `${COLORS[level]}${level.toUpperCase()}${RESET} ${line}`
            : line;

        if (level === "error") {
            process.stderr.write(consoleOut + "\n");
        } else {
            process.stdout.write(consoleOut + "\n");
        }
    }

    // File: always plain text (no ANSI codes).
    const fileStream = getLogStream();
    if (fileStream) {
        try {
            fileStream.write(line.replace(ANSI_RE, "") + "\n");
        } catch {
            // Never let a logging failure crash the app.
        }
    }
}

// ─── Public API ─────────────────────────────────────────────────────────────

export const logger = {
    debug(origin: string, ...args: unknown[]) {
        emit("debug", origin, args);
    },
    info(origin: string, ...args: unknown[]) {
        emit("info", origin, args);
    },
    warn(origin: string, ...args: unknown[]) {
        emit("warn", origin, args);
    },
    error(origin: string, ...args: unknown[]) {
        emit("error", origin, args);
    },

    /** Absolute path of the log file (for startup messages). */
    get filePath() {
        return LOG_FILE_PATH;
    },
};

// ─── console.* capture ──────────────────────────────────────────────────────
// Routes the pre-existing console.* calls into app.log (file only — the
// native console output is kept unchanged by delegating to the original
// functions, so TTY formatting/util.inspect behavior stays identical).

export function initFileLogging() {
    const original = {
        log: console.log.bind(console),
        info: console.info.bind(console),
        warn: console.warn.bind(console),
        error: console.error.bind(console),
        debug: console.debug ? console.debug.bind(console) : console.log,
    };

    const makePatched =
        (level: LogLevel, originalFn: (...args: unknown[]) => void) =>
        (...args: unknown[]) => {
            emit(level, "", args, { toConsole: false });
            originalFn(...args);
        };

    console.log = makePatched("info", original.log);
    console.info = makePatched("info", original.info);
    console.warn = makePatched("warn", original.warn);
    console.error = makePatched("error", original.error);
    console.debug = makePatched("debug", original.debug);

    logger.info("LOGGER", `Logging to file: ${LOG_FILE_PATH}`);
}
