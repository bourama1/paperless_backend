import { Request, Response } from "express";
import {
    findEngineerByPin,
    recordQcCheck,
    listQualityEngineers,
    createQualityEngineer,
    updateQualityEngineer,
    setQualityEngineerActive,
    QcValidationError,
    QC_CHECK_STATUSES,
    QcCheckStatus,
    QualityEngineer,
} from "../services/qualityControlService";

// ── wrong-PIN lockout ──
// A QC PIN both unlocks the sign-off and says WHO signed, so it must not be
// cheaply guessable: after MAX_FAILURES wrong PINs from one client, that
// client is locked out for LOCKOUT_MS. In-memory — resets on restart,
// which is fine for slowing down guessing.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
const failures = new Map<string, { count: number; lockedUntil: number }>();

function clientKey(req: Request): string {
    return req.ip || req.socket.remoteAddress || "unknown";
}

/**
 * Resolves the engineer from the X-QC-Pin header (a header, not the body —
 * request bodies are written to the log). Sends 429/401 itself and returns
 * null when there's no valid engineer.
 */
async function engineerFromRequest(req: Request, res: Response): Promise<QualityEngineer | null> {
    const key = clientKey(req);
    const entry = failures.get(key);
    if (entry && entry.lockedUntil > Date.now()) {
        res.status(429).json({ error: "Too many wrong PINs — try again later" });
        return null;
    }

    const pin = req.header("X-QC-Pin") || "";
    const engineer = await findEngineerByPin(pin);
    if (!engineer) {
        // An expired lockout starts the count fresh.
        const count = (entry && !entry.lockedUntil ? entry.count : 0) + 1;
        failures.set(key, {
            count,
            lockedUntil: count >= MAX_FAILURES ? Date.now() + LOCKOUT_MS : 0,
        });
        res.status(401).json({ error: "Invalid PIN" });
        return null;
    }

    failures.delete(key);
    return engineer;
}

// Test hook — the lockout is module state.
export function resetQcPinLockouts(): void {
    failures.clear();
}

export const verifyQcPin = async (req: Request, res: Response) => {
    try {
        const engineer = await engineerFromRequest(req, res);
        if (!engineer) return;
        res.json({ id: engineer.id, name: engineer.name });
    } catch (error) {
        console.error("Error verifying QC PIN:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

export const createOrderQcCheck = async (req: Request, res: Response) => {
    const { projectNumber, position, workstation, cycleIndex, totalCycles, status, note } = req.body;
    if (!projectNumber || !position || !workstation || !cycleIndex || !status) {
        return res.status(400).json({
            error: "projectNumber, position, workstation, cycleIndex, and status are required",
        });
    }
    if (!(QC_CHECK_STATUSES as readonly string[]).includes(status)) {
        return res.status(400).json({ error: "status must be one of: ok, issue" });
    }

    try {
        const engineer = await engineerFromRequest(req, res);
        if (!engineer) return;
        await recordQcCheck(
            {
                projectNumber,
                position,
                workstation,
                cycleIndex,
                totalCycles: typeof totalCycles === "number" && totalCycles > 0 ? totalCycles : 1,
                status: status as QcCheckStatus,
                note,
            },
            engineer,
        );
        res.status(201).json({ status: "ok", engineer: engineer.name });
    } catch (error) {
        console.error("Error recording QC check:", error);
        res.status(500).json({ error: "Internal server error" });
    }
};

// ── quality-engineer admin (under /employees/admin, behind adminPinAuth) ──

function sendAdminError(res: Response, error: any, action: string) {
    if (error instanceof QcValidationError) {
        return res.status(400).json({ error: error.message });
    }
    if (error?.message === "Quality engineer not found") {
        return res.status(404).json({ error: error.message });
    }
    // Postgres unique_violation — the name is taken.
    if (error?.code === "23505") {
        return res.status(409).json({ error: "A quality engineer with this name already exists" });
    }
    console.error(`Error ${action} quality engineer:`, error);
    res.status(500).json({ error: "Internal server error" });
}

export const getQualityEngineers = async (req: Request, res: Response) => {
    try {
        res.json(await listQualityEngineers());
    } catch (error) {
        sendAdminError(res, error, "listing");
    }
};

export const postQualityEngineer = async (req: Request, res: Response) => {
    try {
        res.status(201).json(await createQualityEngineer(req.body?.name, req.body?.pin));
    } catch (error) {
        sendAdminError(res, error, "creating");
    }
};

export const putQualityEngineer = async (req: Request, res: Response) => {
    try {
        res.json(await updateQualityEngineer(Number(req.params.id), req.body?.name, req.body?.pin));
    } catch (error) {
        sendAdminError(res, error, "updating");
    }
};

export const hideQualityEngineer = async (req: Request, res: Response) => {
    try {
        res.json(await setQualityEngineerActive(Number(req.params.id), false));
    } catch (error) {
        sendAdminError(res, error, "hiding");
    }
};

export const restoreQualityEngineer = async (req: Request, res: Response) => {
    try {
        res.json(await setQualityEngineerActive(Number(req.params.id), true));
    } catch (error) {
        sendAdminError(res, error, "restoring");
    }
};
