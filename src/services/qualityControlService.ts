/**
 * Quality-control sign-off for orders flagged as needing it (TMP file
 * characteristic 00000040 = "j" — see qcRequirementService). Done per cycle
 * by quality engineers — separate people from the employees table — who
 * identify themselves with a personal PIN. The PIN both authorizes the
 * sign-off and records who did it, so it has to be unique per engineer.
 */

import crypto from "crypto";
import { promisify } from "util";
import { getDb } from "../config/database";

const scrypt = promisify(crypto.scrypt) as (
    password: string,
    salt: string,
    keylen: number,
) => Promise<Buffer>;

export interface QualityEngineer {
    id: number;
    name: string;
    active: boolean;
}

export const QC_CHECK_STATUSES = ["ok", "issue"] as const;
export type QcCheckStatus = (typeof QC_CHECK_STATUSES)[number];

export class QcValidationError extends Error {}

const PIN_PATTERN = /^\d{4,8}$/;

// Stored as "salt:hash" (hex). scrypt from Node's own crypto — no bcrypt
// dependency needed for a handful of PINs.
async function hashPin(pin: string): Promise<string> {
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = await scrypt(pin, salt, 32);
    return `${salt}:${hash.toString("hex")}`;
}

async function pinMatches(pin: string, stored: string): Promise<boolean> {
    const [salt, hashHex] = stored.split(":");
    if (!salt || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = await scrypt(pin, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
}

function validatePin(pin: unknown): string {
    if (typeof pin !== "string" || !PIN_PATTERN.test(pin)) {
        throw new QcValidationError("PIN must be 4-8 digits");
    }
    return pin;
}

function validateName(name: unknown): string {
    const trimmed = typeof name === "string" ? name.trim() : "";
    if (!trimmed) throw new QcValidationError("name is required");
    return trimmed;
}

// Hashes are salted, so finding a PIN's owner means checking each engineer
// in turn — fine for the handful of quality engineers there are.
async function findEngineerRowByPin(
    pin: string,
    includeHidden: boolean,
): Promise<QualityEngineer | null> {
    if (!PIN_PATTERN.test(pin)) return null;
    const db = await getDb();
    let query = db("quality_engineers").select("id", "name", "active", "pin_hash");
    if (!includeHidden) query = query.where({ active: true });
    const rows: { id: number; name: string; active: boolean; pin_hash: string }[] = await query;
    for (const row of rows) {
        if (await pinMatches(pin, row.pin_hash)) {
            return { id: row.id, name: row.name, active: !!row.active };
        }
    }
    return null;
}

/** The active engineer whose PIN this is, or null. */
export const findEngineerByPin = (pin: string) => findEngineerRowByPin(pin, false);

// A PIN identifies its engineer, so it must be unique — across hidden
// engineers too, so restoring one can never leave two owners of one PIN.
async function assertPinFree(pin: string, exceptId?: number): Promise<void> {
    const owner = await findEngineerRowByPin(pin, true);
    if (owner && owner.id !== exceptId) {
        throw new QcValidationError("PIN is already used by another quality engineer");
    }
}

export const listQualityEngineers = async (): Promise<QualityEngineer[]> => {
    const db = await getDb();
    return db("quality_engineers").select("id", "name", "active").orderBy("name", "asc");
};

export const createQualityEngineer = async (name: unknown, pin: unknown): Promise<QualityEngineer> => {
    const validName = validateName(name);
    const validPin = validatePin(pin);
    await assertPinFree(validPin);
    const db = await getDb();
    const [row] = await db("quality_engineers")
        .insert({ name: validName, pin_hash: await hashPin(validPin), active: true })
        .returning(["id", "name", "active"]);
    return row;
};

/** Rename and/or set a new PIN — an omitted/empty pin keeps the current one. */
export const updateQualityEngineer = async (
    id: number,
    name: unknown,
    pin: unknown,
): Promise<QualityEngineer> => {
    const update: Record<string, unknown> = { name: validateName(name) };
    if (pin !== undefined && pin !== null && pin !== "") {
        const validPin = validatePin(pin);
        await assertPinFree(validPin, id);
        update.pin_hash = await hashPin(validPin);
    }
    const db = await getDb();
    const [row] = await db("quality_engineers")
        .where({ id })
        .update(update)
        .returning(["id", "name", "active"]);
    if (!row) throw new Error("Quality engineer not found");
    return row;
};

// Hide/restore only — past QC rows keep the engineer's name regardless. A
// hidden engineer's PIN stays reserved (see assertPinFree), so restoring is
// always safe.
export const setQualityEngineerActive = async (id: number, active: boolean): Promise<QualityEngineer> => {
    const db = await getDb();
    const [row] = await db("quality_engineers")
        .where({ id })
        .update({ active })
        .returning(["id", "name", "active"]);
    if (!row) throw new Error("Quality engineer not found");
    return row;
};

export interface QcCheckInput {
    projectNumber: string;
    position: string;
    workstation: string;
    cycleIndex: number;
    totalCycles: number;
    status: QcCheckStatus;
    note?: string;
}

export const recordQcCheck = async (input: QcCheckInput, engineer: QualityEngineer): Promise<void> => {
    const db = await getDb();
    await db("order_qc_checks").insert({
        project_number: input.projectNumber,
        position: input.position,
        workstation: input.workstation,
        cycle_index: input.cycleIndex,
        total_cycles: input.totalCycles,
        engineer_id: engineer.id,
        engineer_name: engineer.name,
        status: input.status,
        note: input.note || null,
    });
};
