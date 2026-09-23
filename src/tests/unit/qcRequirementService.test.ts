jest.mock("../../services/labelPrintingService", () => ({
    lookupQcRequired: jest.fn(),
}));

import { getQcRequiredForPositions } from "../../services/qcRequirementService";
import { lookupQcRequired } from "../../services/labelPrintingService";

function mockDb(cachedRows: any[]) {
    const insertChain: any = {};
    insertChain.onConflict = jest.fn().mockReturnValue(insertChain);
    insertChain.ignore = jest.fn().mockResolvedValue(undefined);
    const insert = jest.fn().mockReturnValue(insertChain);

    const selectChain: any = {};
    selectChain.whereIn = jest.fn().mockReturnValue(selectChain);
    selectChain.select = jest.fn().mockResolvedValue(cachedRows);

    const db = jest.fn(() => ({ ...selectChain, insert }));
    return { db, insert };
}

// Background fills are fire-and-forget — let them settle.
const flush = () => new Promise((r) => setImmediate(r));

describe("getQcRequiredForPositions", () => {
    beforeEach(() => jest.clearAllMocks());

    it("returns cached answers without touching the network share", async () => {
        const { db } = mockDb([{ project_number: "P1", position: "10", qc_required: true }]);

        const result = await getQcRequiredForPositions(db, [
            { project_number: "P1", position: "10", sales_order: "SO1" },
        ]);

        expect(result.get("P1||10")).toBe(true);
        expect(lookupQcRequired).not.toHaveBeenCalled();
    });

    it("leaves an uncached position out and resolves + stores it in the background", async () => {
        const { db, insert } = mockDb([]);
        (lookupQcRequired as jest.Mock).mockResolvedValue(true);

        const result = await getQcRequiredForPositions(db, [
            { project_number: "P2", position: "20", sales_order: "SO2" },
        ]);
        await flush();

        expect(result.has("P2||20")).toBe(false);
        expect(lookupQcRequired).toHaveBeenCalledWith("SO2", "20");
        expect(insert).toHaveBeenCalledWith({ project_number: "P2", position: "20", qc_required: true });
    });

    it("doesn't store an unresolvable answer, and doesn't retry it on the very next poll", async () => {
        const { db, insert } = mockDb([]);
        (lookupQcRequired as jest.Mock).mockResolvedValue(null);
        const positions = [{ project_number: "P3", position: "30", sales_order: "SO3" }];

        await getQcRequiredForPositions(db, positions);
        await flush();
        await getQcRequiredForPositions(db, positions);
        await flush();

        expect(insert).not.toHaveBeenCalled();
        expect(lookupQcRequired).toHaveBeenCalledTimes(1);
    });

    it("skips positions without a sales order (no CSV to look up)", async () => {
        const { db } = mockDb([]);

        await getQcRequiredForPositions(db, [{ project_number: "P4", position: "40", sales_order: null }]);
        await flush();

        expect(lookupQcRequired).not.toHaveBeenCalled();
    });
});
