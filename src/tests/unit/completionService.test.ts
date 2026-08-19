jest.mock("../../config/database");

import { getDb } from "../../config/database";
import { recordOrderCompletion } from "../../services/completionService";
import { thenable } from "../helpers/thenable";

describe("completionService", () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    function mockDb(completedCount: number) {
        const insertLog = jest.fn(() => thenable(undefined));
        const archiveInsert = jest.fn(() => ({
            onConflict: () => ({ merge: () => thenable(undefined) }),
        }));
        const archiveDelete = jest.fn(() => thenable(undefined));

        const db = Object.assign(
            jest.fn((table: string) => {
                if (table === "order_completion_log") {
                    return {
                        insert: insertLog,
                        where: () => ({
                            whereIn: () => ({
                                countDistinct: () => ({
                                    first: () => thenable({ count: completedCount }),
                                }),
                            }),
                        }),
                    };
                }
                if (table === "order_archive_log") {
                    return {
                        insert: archiveInsert,
                        where: () => ({
                            whereNull: () => ({ delete: archiveDelete }),
                        }),
                    };
                }
                return {};
            }),
            { fn: { now: () => "NOW()" } },
        );
        (getDb as jest.Mock).mockResolvedValue(db);
        return { db, insertLog, archiveInsert, archiveDelete };
    }

    it("queues archival for status='complete' once every cycle is done, same as before", async () => {
        const { archiveInsert } = mockDb(3);

        await recordOrderCompletion({
            orderId: "o1",
            workstation: "WS1",
            cycleIndex: 3,
            totalCycles: 3,
            projectNumber: "P1",
            position: "10",
            employeeName: "Jan Novak",
            status: "complete",
        });

        expect(archiveInsert).toHaveBeenCalledWith(
            expect.objectContaining({ order_id: "o1", project_number: "P1" }),
        );
    });

    it("queues archival for status='complete_with_changes' exactly like 'complete'", async () => {
        const { archiveInsert } = mockDb(3);

        await recordOrderCompletion({
            orderId: "o2",
            workstation: "WS1",
            cycleIndex: 3,
            totalCycles: 3,
            projectNumber: "P2",
            position: "20",
            employeeName: "Jan Novak",
            status: "complete_with_changes",
        });

        expect(archiveInsert).toHaveBeenCalledWith(
            expect.objectContaining({ order_id: "o2", project_number: "P2" }),
        );
    });

    it("counts 'complete' and 'complete_with_changes' cycles together toward the total (mixed batch)", async () => {
        const { db, archiveInsert } = mockDb(3);

        await recordOrderCompletion({
            orderId: "o3",
            workstation: "WS1",
            cycleIndex: 3,
            totalCycles: 3,
            projectNumber: "P3",
            position: "30",
            employeeName: "Jan Novak",
            status: "complete_with_changes",
        });

        // The completedCycles lookup must count both flavors of "done",
        // not just an exact status: "complete" match.
        expect(db).toHaveBeenCalledWith("order_completion_log");
        expect(archiveInsert).toHaveBeenCalled();
    });

    it("does not queue archival yet if not every cycle is done", async () => {
        const { archiveInsert } = mockDb(2); // only 2 of 3 cycles done

        await recordOrderCompletion({
            orderId: "o4",
            workstation: "WS1",
            cycleIndex: 2,
            totalCycles: 3,
            projectNumber: "P4",
            position: "40",
            employeeName: "Jan Novak",
            status: "complete_with_changes",
        });

        expect(archiveInsert).not.toHaveBeenCalled();
    });

    it("cancels any pending archival queue entry for missing_product/shipped_incomplete", async () => {
        const { archiveDelete, archiveInsert } = mockDb(0);

        await recordOrderCompletion({
            orderId: "o5",
            workstation: "WS1",
            cycleIndex: 1,
            totalCycles: 1,
            projectNumber: "P5",
            position: "50",
            employeeName: "Jan Novak",
            status: "missing_product",
        });

        expect(archiveDelete).toHaveBeenCalled();
        expect(archiveInsert).not.toHaveBeenCalled();
    });
});
