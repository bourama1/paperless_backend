// dotenv MUST be imported and configured before anything else. Several
// services (pdfaService, documentPrinterService, labelPrintingService, ...)
// read process.env.* into module-level constants the moment they're first
// required, e.g. `const GHOSTSCRIPT_BIN = process.env.GHOSTSCRIPT_PATH ||
// "gs"`. If those modules get pulled in (even transitively, via routes ->
// controllers -> services) before dotenv.config() runs, they permanently
// capture the fallback default instead of the real .env value — which is
// exactly what was happening here: GHOSTSCRIPT_PATH from .env was being
// ignored because filesRoutes/workstationRoutes (imported below) eagerly
// require pdfaService.ts before dotenv.config() had a chance to run.
//
// Keep this import + config() call as the very first thing in this file,
// above every other import, so process.env is fully populated before any
// other module is loaded.
import dotenv from "dotenv";
dotenv.config();

// Initialize file logging (app.log) before any other module is loaded, so
// module-level console.* calls are captured too. Must stay right below
// dotenv.config() — see the comment at the top of the file for why order
// matters here.
import { logger, initFileLogging } from "./utils/logger";
initFileLogging();

// Log fatal process-level errors into app.log, then exit with a failure
// code — this preserves Node's default crash behavior for uncaught
// exceptions/unhandled rejections while making sure the cause is persisted
// (before, these only went to the console and were lost on restart).
process.on("unhandledRejection", (reason) => {
    logger.error("PROCESS", "Unhandled promise rejection:", reason);
    process.exit(1);
});
process.on("uncaughtException", (error) => {
    logger.error("PROCESS", "Uncaught exception:", error);
    process.exit(1);
});

import express from "express";
import { createServer } from "http";
import { createServer as createHttpsServer } from "https";
import { Server } from "socket.io";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import fs from "fs";

import { getDb } from "./config/database";
import { apiKeyAuth } from "./middleware/apiKeyAuth";
import { createWebFrontendMiddleware } from "./middleware/webFrontend";
import { redactApiKey } from "./utils/redactApiKey";
import { initPrintSettings } from "./services/printSettingsService";

import queueRoutes from "./routes/queue";
import filesRoutes from "./routes/files";
import workstationRoutes from "./routes/workstations";
import employeesRoutes from "./routes/employees";
import prepQueueRoutes from "./routes/prepQueue";
import settingsRoutes from "./routes/settings";

const app = express();

// TLS — three supported modes, checked in order:
//
//  1. PFX/PKCS#12 (SSL_PFX_PATH + optional SSL_PFX_PASSPHRASE)
//     Export from IIS: right-click cert in IIS Manager → Export → save as .pfx.
//     This is the easiest path when the cert was installed via IIS.
//
//  2. Separate PEM files (SSL_CERT_PATH + SSL_KEY_PATH)
//     Split a .pfx with:
//       openssl pkcs12 -in cert.pfx -nokeys -out server.crt -nodes
//       openssl pkcs12 -in cert.pfx -nocerts -out server.key -nodes
//
//  3. No TLS — plain HTTP fallback (dev/test only).
//
// When using a publicly trusted cert (e.g. Sectigo via IIS), no certificate
// bundling is needed in the mobile app — Android and all browsers already
// trust the issuing CA out of the box.

const SSL_PFX_PATH = process.env.SSL_PFX_PATH;
const SSL_PFX_PASSPHRASE = process.env.SSL_PFX_PASSPHRASE || "";
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;

function buildTlsOptions(): import("https").ServerOptions | null {
    if (SSL_PFX_PATH) {
        if (!fs.existsSync(SSL_PFX_PATH)) {
            if (process.env.NODE_ENV === "test") return null; // cert won't exist on dev machines
            throw new Error(`[SERVER] SSL_PFX_PATH is set but file not found: ${SSL_PFX_PATH}`);
        }
        return {
            pfx: fs.readFileSync(SSL_PFX_PATH),
            passphrase: SSL_PFX_PASSPHRASE || undefined,
        };
    }
    if (SSL_CERT_PATH && SSL_KEY_PATH) {
        return {
            cert: fs.readFileSync(SSL_CERT_PATH),
            key: fs.readFileSync(SSL_KEY_PATH),
        };
    }
    return null;
}

const tlsOptions = buildTlsOptions();
const useTls = tlsOptions !== null;

const httpServer = useTls
    ? createHttpsServer(tlsOptions!, app)
    : createServer(app);

if (!useTls && process.env.NODE_ENV !== "test") {
    logger.warn(
        "SERVER",
        "No TLS cert configured (SSL_PFX_PATH or SSL_CERT_PATH+SSL_KEY_PATH) — " +
            "running plain HTTP. Do not use this over an untrusted network.",
    );
} else if (useTls) {
    const mode = SSL_PFX_PATH ? "PFX" : "PEM";
    logger.info("SERVER", `TLS enabled (${mode})`);
}

const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
});

// Require the shared API key on every Socket.IO connection too — the
// header-based apiKeyAuth below only covers plain HTTP routes, and the
// WebSocket upgrade handshake needs its own check.
io.use((socket, next) => {
    const apiKey = process.env.API_KEY;
    const provided =
        socket.handshake.auth?.apiKey || socket.handshake.headers["x-api-key"];

    if (!apiKey) {
        logger.error(
            "AUTH",
            "API_KEY is not set — rejecting all socket connections.",
        );
        return next(new Error("Server misconfigured"));
    }

    if (!provided || provided !== apiKey) {
        return next(new Error("Unauthorized"));
    }

    next();
});

const PORT = process.env.PORT || 3000;

// Initialize Database
const initDb = async () => {
    try {
        await getDb();
        logger.info("DB", "Database initialized successfully");
        await initPrintSettings();
    } catch (error) {
        logger.error("DB", "Failed to initialize database:", error);
    }
};

if (process.env.NODE_ENV !== "test") {
    initDb();
}

// Middleware
app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

// ─── Web frontend (optional) ──────────────────────────────────────────────
// Serves the mobile app's own web export (`npx expo export --platform web`
// in the mobile project) so it's reachable as a normal browser app over the
// company VPN, at the same origin/port as the API — no separate web server,
// port, or certificate needed. Copy the resulting `dist/` folder here (path
// configurable via WEB_BUILD_PATH) after each web build.
//
// This intentionally sits BEFORE apiKeyAuth: a plain browser navigation (or
// hitting refresh on a client-side route like /document/123) can't attach a
// custom header, so the page shell itself has to be public. The actual data
// the page loads afterward still goes through apiKeyAuth normally — the
// web build's JS makes the same authenticated axios/socket calls the native
// app does. Requests matching a real API route prefix (see
// middleware/webFrontend.ts's isApiRequest) skip straight past this and go
// through the normal auth + routing below, unchanged.
const WEB_BUILD_PATH = path.resolve(
    process.cwd(),
    process.env.WEB_BUILD_PATH || "web-dist",
);

if (fs.existsSync(WEB_BUILD_PATH)) {
    app.use(createWebFrontendMiddleware(WEB_BUILD_PATH));
    logger.info("WEB", `Serving web build from ${WEB_BUILD_PATH}`);
} else if (process.env.NODE_ENV !== "test") {
    logger.info(
        "WEB",
        `No web build found at ${WEB_BUILD_PATH} — running API-only. ` +
            "Run `npx expo export --platform web` in the mobile project and copy dist/ here to enable it.",
    );
}

// Require the shared API key on every route except /health. Must run
// before the request logger so unauthorized requests aren't logged as if
// they were legitimate traffic.
app.use(apiKeyAuth);

// Log all incoming API requests with their payload. The apiKey query param
// (see middleware/apiKeyAuth.ts) is redacted here so the shared secret
// never lands in console output.
app.use((req, res, next) => {
    const safeUrl = redactApiKey(req.url);
    if (req.body && Object.keys(req.body).length > 0) {
        let bodyStr = JSON.stringify(req.body);
        if (bodyStr.length > 2000) bodyStr = bodyStr.substring(0, 2000) + "...";
        logger.info("API", `${req.method} ${safeUrl} ${bodyStr}`);
    } else if (Object.keys(req.query).length > 0) {
        const safeQuery = { ...req.query };
        if ("apiKey" in safeQuery) safeQuery.apiKey = "***";
        logger.info(
            "API",
            `${req.method} ${safeUrl} query=${JSON.stringify(safeQuery)}`,
        );
    } else {
        logger.info("API", `${req.method} ${safeUrl}`);
    }
    next();
});

app.use(
    morgan("dev", {
        // morgan's "dev" format includes the URL — redact the same param
        // there too, or the key still leaks via this second logger.
        skip: () => false,
        stream: {
            write: (line: string) =>
                logger.info("HTTP", redactApiKey(line).trimEnd()),
        },
    }),
);

// Static files for PDFs
const STORAGE_PATH = process.env.STORAGE_PATH || "./storage";
if (!fs.existsSync(STORAGE_PATH)) {
    fs.mkdirSync(STORAGE_PATH, { recursive: true });
}

const UPLOADS_PATH = path.join(process.cwd(), "uploads");
if (!fs.existsSync(UPLOADS_PATH)) {
    fs.mkdirSync(UPLOADS_PATH, { recursive: true });
}

app.use("/files", express.static(STORAGE_PATH));
app.use("/queue", queueRoutes);
app.use("/files", filesRoutes);
app.use("/workstations", workstationRoutes);
app.use("/employees", employeesRoutes);
app.use("/prep-queue", prepQueueRoutes);
app.use("/settings", settingsRoutes);
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// Socket.io connection
io.on("connection", (socket) => {
    logger.info("SOCKET", `Client connected: ${socket.id}`);

    socket.on("disconnect", (reason) => {
        logger.info("SOCKET", `Client disconnected: ${socket.id} (${reason})`);
    });
});

// Start server
if (process.env.NODE_ENV !== "test") {
    httpServer.listen(PORT, () => {
        logger.info("SERVER", `Server running on port ${PORT}`);

        // Start polling workstations
        const { pollWorkstations } = require("./services/workstationService");
        const POLL_INTERVAL = parseInt(
            process.env.WORKSTATIONS_POLL_INTERVAL || "15000",
            10,
        );
        pollWorkstations();
        setInterval(pollWorkstations, POLL_INTERVAL);
        logger.info(
            "SERVER",
            `Workstation polling started (interval: ${POLL_INTERVAL}ms)`,
        );

        // Start retention archival sweep (finished orders -> PDF/A -> network share)
        const {
            runArchivalSweep,
            ARCHIVE_POLL_INTERVAL_MS,
        } = require("./services/archivalService");
        runArchivalSweep();
        setInterval(runArchivalSweep, ARCHIVE_POLL_INTERVAL_MS);
        logger.info(
            "SERVER",
            `Retention archival sweep started (interval: ${ARCHIVE_POLL_INTERVAL_MS}ms)`,
        );

        // Start periodic check for a new productionPlanPTL.json drop
        // (pre-P2L prep queue — see services/ptlPlanService.ts)
        const {
            checkForNewPlan,
            PTL_PLAN_CHECK_INTERVAL_MS,
        } = require("./services/ptlPlanService");
        checkForNewPlan();
        setInterval(checkForNewPlan, PTL_PLAN_CHECK_INTERVAL_MS);
        logger.info(
            "SERVER",
            `PTL production plan check started (interval: ${PTL_PLAN_CHECK_INTERVAL_MS}ms)`,
        );
    });
}

export { io };
