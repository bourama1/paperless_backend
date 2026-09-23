process.env.PTL_PLAN_FOLDER_PATH = "/tmp/ptl-plan-test";
process.env.PTL_PLAN_RETAIN_FILES = "2";
process.env.MASTERPLAN_DB_NAME = "Masterplan";

jest.mock("../../config/database");
jest.mock("fs", () => {
    const actual = jest.requireActual("fs");
    return {
        ...actual,
        readdirSync: jest.fn(),
        readFileSync: jest.fn(),
    };
});

import {
    checkForNewPlan,
    getPrepQueue,
    getNonPtlItemsForOrder,
    recordPrepItemChecked,
    recordPrepItemUnchecked,
    addPrepBaanCodes,
} from "../../services/ptlPlanService";
import { getDb, getMasterplanDb } from "../../config/database";
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

    it("force re-ingests every currently-retained plan file, not just the latest", async () => {
        (fs.readFileSync as jest.Mock).mockImplementation((filePath: string) => {
            const tag =
                filePath.includes(OLDEST_FILE) ? "OLDEST"
                : filePath.includes(MIDDLE_FILE) ? "MIDDLE"
                : filePath.includes(LATEST_FILE) ? "LATEST"
                : null;
            if (!tag) throw new Error(`Unexpected file read: ${filePath}`);
            return JSON.stringify({
                productionPlan: [{ ...samplePlan.productionPlan[0], position: tag }],
            });
        });

        const ingestStateChain = makeChain(undefined);
        ingestStateChain.where = jest.fn(() => ({
            first: jest.fn().mockResolvedValue({ last_file_name: LATEST_FILE }),
        }));
        ingestStateChain.merge = jest.fn().mockResolvedValue(undefined);

        const insertedPositions: string[] = [];
        const prepQueueChain: any = {};
        prepQueueChain.insert = jest.fn((row: any) => {
            insertedPositions.push(row.position);
            return prepQueueChain;
        });
        prepQueueChain.onConflict = jest.fn(() => prepQueueChain);
        prepQueueChain.merge = jest.fn().mockResolvedValue(undefined);
        prepQueueChain.distinct = jest.fn(() => prepQueueChain);
        prepQueueChain.whereNotNull = jest.fn(() => ({
            then: (resolve: any) => resolve([]),
            whereNotIn: jest.fn(() => ({ del: jest.fn().mockResolvedValue(0) })),
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

        const result = await checkForNewPlan(true);

        expect(result.newFile).toBe(true);
        expect(result.filename).toBe(LATEST_FILE);
        // PTL_PLAN_RETAIN_FILES=2 -> MIDDLE and LATEST get re-ingested,
        // OLDEST does not (matches what pruneOldPlanFiles keeps anyway).
        expect(insertedPositions.sort()).toEqual(["LATEST", "MIDDLE"]);
    });
});

describe("getPrepQueue — Masterplan lock annotation", () => {
    const queueRows = [
        { project_number: "603529", position: "050", workplace: "Hardware", quantity: 1 },
        { project_number: "603684", position: "010", workplace: "Hardware", quantity: 2 },
        { project_number: "604427", position: "020", workplace: "Motor",    quantity: 3 },
    ];

    function makeMainDbMock(rows: any[]) {
        // Mimics the chained knex query used by getPrepQueue
        const chain: any = {
            then: (resolve: any) => resolve(rows),
        };
        for (const m of ["whereNotExists", "orderBy", "andWhere", "select", "where"]) {
            chain[m] = jest.fn(() => chain);
        }
        return Object.assign(
            jest.fn(() => chain),
            { fn: { now: () => "NOW()" } },
        );
    }

    function makeMasterplanDbMock(lockedRows: { zak: string; poz: string }[]) {
        const chain: any = {
            then: (resolve: any) => resolve(lockedRows),
        };
        for (const m of ["where", "select", "orWhere"]) {
            chain[m] = jest.fn(() => chain);
        }
        return jest.fn(() => chain);
    }

    afterEach(() => jest.clearAllMocks());

    it("annotates locked rows with locked=true when Masterplan reports tisk_zamcen=1", async () => {
        (getDb as jest.Mock).mockResolvedValue(makeMainDbMock(queueRows));
        (getMasterplanDb as jest.Mock).mockResolvedValue(
            makeMasterplanDbMock([{ zak: "603529", poz: "050" }]),
        );

        const result = await getPrepQueue();

        expect(result).toHaveLength(3);
        expect(result.find((r: any) => r.project_number === "603529")?.locked).toBe(true);
        expect(result.find((r: any) => r.project_number === "603684")?.locked).toBe(false);
        expect(result.find((r: any) => r.project_number === "604427")?.locked).toBe(false);
    });

    it("marks all rows unlocked when Masterplan returns no locked rows", async () => {
        (getDb as jest.Mock).mockResolvedValue(makeMainDbMock(queueRows));
        (getMasterplanDb as jest.Mock).mockResolvedValue(makeMasterplanDbMock([]));

        const result = await getPrepQueue();

        expect(result.every((r: any) => r.locked === false)).toBe(true);
    });

    it("fails open (locked=false) when the Masterplan DB is unreachable", async () => {
        (getDb as jest.Mock).mockResolvedValue(makeMainDbMock(queueRows));
        (getMasterplanDb as jest.Mock).mockRejectedValue(new Error("connection refused"));

        const result = await getPrepQueue();

        // Connectivity failure must not surface to the user — all items
        // appear unlocked rather than the queue going blank or erroring.
        expect(result.every((r: any) => r.locked === false)).toBe(true);
        expect(result).toHaveLength(3);
    });

    it("returns an empty queue without calling Masterplan when there are no items", async () => {
        (getDb as jest.Mock).mockResolvedValue(makeMainDbMock([]));
        const mpMock = jest.fn();
        (getMasterplanDb as jest.Mock).mockResolvedValue(mpMock);

        const result = await getPrepQueue();

        expect(result).toHaveLength(0);
        // getMasterplanDb may or may not be called, but the db query itself
        // must not be called with an empty WHERE clause (that's a table scan).
        expect(mpMock).not.toHaveBeenCalled();
    });
});

describe("getNonPtlItemsForOrder", () => {
    const ITEMS = [
        { itemID: "X1", itemDesc: "Bracket", itemQuantity: 2, unit: "pcs" },
        { itemID: "X2", itemDesc: "Bolt", itemQuantity: 8, unit: "pcs" },
    ];

    afterEach(() => jest.clearAllMocks());

    /** db("ptl_prep_queue").where(...).select(...).first() -> queueRow
     *  db("order_prep_item_log").select(...).where(...) -> checkedRows
     *  db("prep_baan_codes").select(...) -> baanCodes (empty = no filter) */
    function makeDb(queueRow: any, checkedRows: { item_id: string }[], baanCodes: string[] = []) {
        return jest.fn((table: string) => {
            if (table === "prep_baan_codes") {
                return { select: jest.fn().mockResolvedValue(baanCodes.map((code) => ({ code }))) };
            }
            if (table === "ptl_prep_queue") {
                const chain: any = {};
                chain.where = jest.fn(() => chain);
                chain.select = jest.fn(() => chain);
                chain.first = jest.fn().mockResolvedValue(queueRow);
                return chain;
            }
            if (table === "order_prep_item_log") {
                const chain: any = { then: (resolve: any) => resolve(checkedRows) };
                chain.select = jest.fn(() => chain);
                chain.where = jest.fn(() => chain);
                return chain;
            }
            throw new Error(`Unexpected table: ${table}`);
        });
    }

    it("returns an empty, already-prepared checklist when the order has no queue row", async () => {
        (getDb as jest.Mock).mockResolvedValue(makeDb(undefined, []));

        const result = await getNonPtlItemsForOrder("PN1", "01");

        expect(result).toEqual({ items: [], allPrepared: true });
    });

    it("returns an empty, already-prepared checklist when non_ptl_items is null", async () => {
        (getDb as jest.Mock).mockResolvedValue(makeDb({ non_ptl_items: null }, []));

        const result = await getNonPtlItemsForOrder("PN1", "01");

        expect(result).toEqual({ items: [], allPrepared: true });
    });

    it("marks every item unchecked and allPrepared=false when none have been tapped yet", async () => {
        (getDb as jest.Mock).mockResolvedValue(
            makeDb({ non_ptl_items: JSON.stringify(ITEMS) }, []),
        );

        const result = await getNonPtlItemsForOrder("PN1", "01");

        expect(result.allPrepared).toBe(false);
        expect(result.items).toEqual([
            { ...ITEMS[0], checked: false },
            { ...ITEMS[1], checked: false },
        ]);
    });

    it("marks only the items with a matching order_prep_item_log row as checked", async () => {
        (getDb as jest.Mock).mockResolvedValue(
            makeDb({ non_ptl_items: JSON.stringify(ITEMS) }, [{ item_id: "X1" }]),
        );

        const result = await getNonPtlItemsForOrder("PN1", "01");

        expect(result.allPrepared).toBe(false);
        expect(result.items.find((i) => i.itemID === "X1")?.checked).toBe(true);
        expect(result.items.find((i) => i.itemID === "X2")?.checked).toBe(false);
    });

    it("reports allPrepared=true once every item is checked", async () => {
        (getDb as jest.Mock).mockResolvedValue(
            makeDb(
                { non_ptl_items: JSON.stringify(ITEMS) },
                [{ item_id: "X1" }, { item_id: "X2" }],
            ),
        );

        const result = await getNonPtlItemsForOrder("PN1", "01");

        expect(result.allPrepared).toBe(true);
        expect(result.items.every((i) => i.checked)).toBe(true);
    });

    it("fails safe to an empty, already-prepared checklist on malformed JSON", async () => {
        (getDb as jest.Mock).mockResolvedValue(makeDb({ non_ptl_items: "{not json" }, []));

        const result = await getNonPtlItemsForOrder("PN1", "01");

        expect(result).toEqual({ items: [], allPrepared: true });
    });

    describe("with a prep BAAN code list", () => {
        it("shows only the non-PTL items whose BAAN code is on the list", async () => {
            (getDb as jest.Mock).mockResolvedValue(
                makeDb({ non_ptl_items: JSON.stringify(ITEMS) }, [], ["X2"]),
            );

            const result = await getNonPtlItemsForOrder("PN1", "01");

            expect(result.items.map((i) => i.itemID)).toEqual(["X2"]);
        });

        it("matches regardless of case/whitespace in the order file", async () => {
            const items = [{ ...ITEMS[0], itemID: " x1 " }];
            (getDb as jest.Mock).mockResolvedValue(makeDb({ non_ptl_items: JSON.stringify(items) }, [], ["X1"]));

            const result = await getNonPtlItemsForOrder("PN1", "01");

            expect(result.items).toHaveLength(1);
        });

        it("an order with none of its items on the list needs no prep (print not blocked)", async () => {
            (getDb as jest.Mock).mockResolvedValue(
                makeDb({ non_ptl_items: JSON.stringify(ITEMS) }, [], ["T09-040-70-0054"]),
            );

            const result = await getNonPtlItemsForOrder("PN1", "01");

            expect(result).toEqual({ items: [], allPrepared: true });
        });
    });
});

describe("addPrepBaanCodes", () => {
    it("accepts a pasted block, normalizes and de-duplicates, and skips codes already listed", async () => {
        const ignore = jest.fn().mockResolvedValue([{ id: 1 }, { id: 2 }]);
        const onConflict = jest.fn(() => ({ ignore: () => ({ returning: ignore }) }));
        const insert = jest.fn(() => ({ onConflict }));
        (getDb as jest.Mock).mockResolvedValue(jest.fn(() => ({ insert })));

        const added = await addPrepBaanCodes(" t09-040-70-0054\r\nT09-040-70-0056, t09-040-70-0054 ;", "šrouby");

        expect(insert).toHaveBeenCalledWith([
            { code: "T09-040-70-0054", description: "šrouby" },
            { code: "T09-040-70-0056", description: "šrouby" },
        ]);
        expect(onConflict).toHaveBeenCalledWith("code");
        expect(added).toBe(2);
    });

    it("does nothing for blank input", async () => {
        expect(await addPrepBaanCodes("  \n , ")).toBe(0);
    });
});

describe("recordPrepItemChecked", () => {
    afterEach(() => jest.clearAllMocks());

    it("inserts a row into order_prep_item_log and ignores a duplicate tap", async () => {
        const ignore = jest.fn().mockResolvedValue(undefined);
        const onConflict = jest.fn(() => ({ ignore }));
        const insert = jest.fn(() => ({ onConflict }));
        const db = jest.fn((table: string) => {
            if (table === "order_prep_item_log") return { insert };
            throw new Error(`Unexpected table: ${table}`);
        });
        (getDb as jest.Mock).mockResolvedValue(db);

        await recordPrepItemChecked("PN1", "01", "X1", "Bracket", "Jan Novak");

        expect(insert).toHaveBeenCalledWith({
            project_number: "PN1",
            position: "01",
            item_id: "X1",
            item_desc: "Bracket",
            employee_name: "Jan Novak",
        });
        expect(onConflict).toHaveBeenCalledWith(["project_number", "position", "item_id"]);
        expect(ignore).toHaveBeenCalled();
    });
});

describe("recordPrepItemUnchecked", () => {
    afterEach(() => jest.clearAllMocks());

    it("deletes the matching order_prep_item_log row", async () => {
        const del = jest.fn().mockResolvedValue(1);
        const where = jest.fn(() => ({ del }));
        const db = jest.fn((table: string) => {
            if (table === "order_prep_item_log") return { where };
            throw new Error(`Unexpected table: ${table}`);
        });
        (getDb as jest.Mock).mockResolvedValue(db);

        await recordPrepItemUnchecked("PN1", "01", "X1");

        expect(where).toHaveBeenCalledWith({ project_number: "PN1", position: "01", item_id: "X1" });
        expect(del).toHaveBeenCalled();
    });

    it("is a harmless no-op when the row doesn't exist (already unchecked)", async () => {
        const del = jest.fn().mockResolvedValue(0);
        const where = jest.fn(() => ({ del }));
        const db = jest.fn(() => ({ where }));
        (getDb as jest.Mock).mockResolvedValue(db);

        await expect(recordPrepItemUnchecked("PN1", "01", "X1")).resolves.not.toThrow();
    });
});
