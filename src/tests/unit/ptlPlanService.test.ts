process.env.PTL_PLAN_FOLDER_PATH = "/tmp/ptl-plan-test";
process.env.PTL_PLAN_RETAIN_FILES = "2";

jest.mock("../../config/database");
jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return {
        ...actual,
        readdirSync: jest.fn(),
        readFileSync: jest.fn(),
    };
});

import { checkForNewPlan } from "../../services/ptlPlanService";
import { getDb } from "../../config/database";
import fs from "fs";

function thenable<T>(value: T) {
    return { then: (resolve: (v: T) => void) => resolve(value) };
}

/** A chainable mock that resolves `terminalValue` if awaited directly, and
 * also exposes every method used on it so callers can keep chaining before
 * eventually calling a "real" terminal like .del()/.first()/.merge(). */
function makeChain(terminalValue: unknown = undefined) {
    const chain: any = { then: (resolve: any) => resolve(terminalValue) };
    for (const method of ["insert", "onConflict", "where", "distinct", "whereNotNull", "whereNotIn", "orderBy"]) {
        chain[method] = jest.fn(() => chain);
    }
    return chain;
}

const OLDEST_FILE = "2026_08_01_08_00_00_productionPlanPTL.json";
const MIDDLE_FILE = "2026_08_02_08_00_00_productionPlanPTL.json";
const LATEST_FILE = "2026_08_03_08_00_00_productionPlanPTL.json";

const samplePlan = {
    productionPlan: [
        {
            workplace: "Hardware",
            salesOrder: "SO1",
            projectNumber: "PN1",
            position: "01",
            quantity: 2,
            productionTime: 5,
            date: "03.08.2026",
            label: "L1",
        },
    ],
};

describe("ptlPlanService — retention pruning", () => {
    beforeEach(() => {
        jest.clearAllMocks();
        (fs.readdirSync as jest.Mock).mockReturnValue([OLDEST_FILE, MIDDLE_FILE, LATEST_FILE]);
        (fs.readFileSync as jest.Mock).mockReturnValue(JSON.stringify(samplePlan));
    });

    it("keeps only the PTL_PLAN_RETAIN_FILES most recent plan files after ingest", async () => {
        const ingestStateChain = makeChain(undefined);
        ingestStateChain.where = jest.fn(() => ({
            first: jest.fn().mockResolvedValue({ last_file_name: MIDDLE_FILE }),
        }));
        ingestStateChain.merge = jest.fn().mockResolvedValue(undefined);

        const prepQueueChain = makeChain();
        prepQueueChain.merge = jest.fn().mockResolvedValue(undefined);
        // Simulate that all three plan drops already have rows sitting in
        // the queue before this ingest prunes anything.
        prepQueueChain.distinct = jest.fn(() => prepQueueChain);
        prepQueueChain.whereNotNull = jest.fn(() => ({
            ...prepQueueChain,
            then: (resolve: any) =>
                resolve([
                    { source_file: OLDEST_FILE },
                    { source_file: MIDDLE_FILE },
                    { source_file: LATEST_FILE },
                ]),
            whereNotIn: jest.fn(() => ({
                del: jest.fn().mockResolvedValue(3),
            })),
        }));

        const db = Object.assign(
            jest.fn((table: string) => {
                if (table === "ptl_ingest_state") return ingestStateChain;
                if (table === "ptl_prep_queue") return prepQueueChain;
                throw new Error(`Unexpected table: ${table}`);
            }),
            { fn: { now: () => "NOW()" } },
        );
        (getDb as jest.Mock).mockResolvedValue(db);

        const result = await checkForNewPlan();

        expect(result.newFile).toBe(true);
        expect(result.filename).toBe(LATEST_FILE);

        // The final whereNotNull() call in pruneOldPlanFiles is the one that
        // drives the delete — assert it was told to keep exactly the 2 most
        // recent files (newest first) and drop the oldest.
        const deleteCall = prepQueueChain.whereNotNull.mock.results.at(-1)!.value;
        expect(deleteCall.whereNotIn).toHaveBeenCalledWith("source_file", [LATEST_FILE, MIDDLE_FILE]);
    });

    it("does not delete anything when nothing has been ingested yet (no source files on record)", async () => {
        const ingestStateChain = makeChain(undefined);
        ingestStateChain.where = jest.fn(() => ({
            first: jest.fn().mockResolvedValue(undefined),
        }));
        ingestStateChain.merge = jest.fn().mockResolvedValue(undefined);

        const prepQueueChain = makeChain();
        prepQueueChain.merge = jest.fn().mockResolvedValue(undefined);
        prepQueueChain.distinct = jest.fn(() => prepQueueChain);
        const whereNotInSpy = jest.fn();
        prepQueueChain.whereNotNull = jest.fn(() => ({
            then: (resolve: any) => resolve([]), // no rows in the queue at all yet
            whereNotIn: whereNotInSpy,
        }));

        const db = Object.assign(
            jest.fn((table: string) => {
                if (table === "ptl_ingest_state") return ingestStateChain;
                if (table === "ptl_prep_queue") return prepQueueChain;
                throw new Error(`Unexpected table: ${table}`);
            }),
            { fn: { now: () => "NOW()" } },
        );
        (getDb as jest.Mock).mockResolvedValue(db);

        await checkForNewPlan();

        // pruneOldPlanFiles should bail out before ever calling whereNotIn/del
        // when it finds no parseable source files to keep.
        expect(whereNotInSpy).not.toHaveBeenCalled();
    });
});
