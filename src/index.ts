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
import { redactApiKey } from "./utils/redactApiKey";

import queueRoutes from "./routes/queue";
import filesRoutes from "./routes/files";
import workstationRoutes from "./routes/workstations";
import employeesRoutes from "./routes/employees";
import prepQueueRoutes from "./routes/prepQueue";

const app = express();

// TLS is optional so local/dev setups can keep running over plain HTTP.
// In any environment reachable over an untrusted network (e.g. the Toors
// WiFi, which can't be isolated to its own VLAN), both SSL_CERT_PATH and
// SSL_KEY_PATH must be set.
const SSL_CERT_PATH = process.env.SSL_CERT_PATH;
const SSL_KEY_PATH = process.env.SSL_KEY_PATH;
const useTls = Boolean(SSL_CERT_PATH && SSL_KEY_PATH);

const httpServer = useTls
    ? createHttpsServer(
          {
              cert: fs.readFileSync(SSL_CERT_PATH as string),
              key: fs.readFileSync(SSL_KEY_PATH as string),
          },
          app,
      )
    : createServer(app);

if (!useTls && process.env.NODE_ENV !== "test") {
    console.warn(
        "[SERVER] SSL_CERT_PATH/SSL_KEY_PATH not set — running plain HTTP. " +
            "Do not use this over an untrusted network (see README).",
    );
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
        console.error(
            "[AUTH] API_KEY is not set — rejecting all socket connections.",
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
        console.log("Database initialized successfully");
    } catch (error) {
        console.error("Failed to initialize database:", error);
    }
};

if (process.env.NODE_ENV !== "test") {
    initDb();
}

// Middleware
app.use(cors());
app.use(express.json({ limit: "100mb" }));
app.use(express.urlencoded({ limit: "100mb", extended: true }));

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
        console.log(`[API] ${req.method} ${safeUrl} ${bodyStr}`);
    } else if (Object.keys(req.query).length > 0) {
        const safeQuery = { ...req.query };
        if ("apiKey" in safeQuery) safeQuery.apiKey = "***";
        console.log(`[API] ${req.method} ${safeUrl} query=${JSON.stringify(safeQuery)}`);
    } else {
        console.log(`[API] ${req.method} ${safeUrl}`);
    }
    next();
});

app.use(
    morgan("dev", {
        // morgan's "dev" format includes the URL — redact the same param
        // there too, or the key still leaks via this second logger.
        skip: () => false,
        stream: {
            write: (line: string) => process.stdout.write(redactApiKey(line)),
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
app.get("/health", (req, res) => {
    res.json({ status: "ok" });
});

// Socket.io connection
io.on("connection", (socket) => {
    console.log("Client connected:", socket.id);

    socket.on("disconnect", () => {
        console.log("Client disconnected:", socket.id);
    });
});

// Start server
if (process.env.NODE_ENV !== "test") {
    httpServer.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);

        // Start polling workstations
        const { pollWorkstations } = require("./services/workstationService");
        const POLL_INTERVAL = parseInt(
            process.env.WORKSTATIONS_POLL_INTERVAL || "15000",
            10,
        );
        pollWorkstations();
        setInterval(pollWorkstations, POLL_INTERVAL);
        console.log(
            `Workstation polling started (interval: ${POLL_INTERVAL}ms)`,
        );

        // Start retention archival sweep (finished orders -> PDF/A -> network share)
        const {
            runArchivalSweep,
            ARCHIVE_POLL_INTERVAL_MS,
        } = require("./services/archivalService");
        runArchivalSweep();
        setInterval(runArchivalSweep, ARCHIVE_POLL_INTERVAL_MS);
        console.log(
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
        console.log(
            `PTL production plan check started (interval: ${PTL_PLAN_CHECK_INTERVAL_MS}ms)`,
        );
    });
}

export { io };
