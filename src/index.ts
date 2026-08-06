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
import { Server } from "socket.io";
import cors from "cors";
import morgan from "morgan";
import path from "path";
import fs from "fs";

import { getDb } from "./config/database";

import queueRoutes from "./routes/queue";
import filesRoutes from "./routes/files";
import workstationRoutes from "./routes/workstations";
import employeesRoutes from "./routes/employees";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
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

// Log all incoming API requests with their payload
app.use((req, res, next) => {
    if (req.body && Object.keys(req.body).length > 0) {
        let bodyStr = JSON.stringify(req.body);
        if (bodyStr.length > 2000) bodyStr = bodyStr.substring(0, 2000) + "...";
        console.log(`[API] ${req.method} ${req.url} ${bodyStr}`);
    } else if (Object.keys(req.query).length > 0) {
        console.log(
            `[API] ${req.method} ${req.url} query=${JSON.stringify(req.query)}`,
        );
    } else {
        console.log(`[API] ${req.method} ${req.url}`);
    }
    next();
});

app.use(morgan("dev"));

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
    });
}

export { io };
