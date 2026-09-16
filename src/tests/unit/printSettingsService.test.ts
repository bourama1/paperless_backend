jest.mock("../../config/database");

function makeDb(row: any) {
    const where = jest.fn(() => ({ first: jest.fn().mockResolvedValue(row) }));
    const onConflict = jest.fn(() => ({ merge: jest.fn().mockResolvedValue(undefined) }));
    const insert = jest.fn(() => ({ onConflict }));
    return Object.assign(jest.fn(() => ({ where, insert })), { fn: { now: () => "NOW()" } });
}

/** Re-requires config/database and printSettingsService together, fresh,
 *  so the mocked getDb the test configures is the exact same instance the
 *  freshly-loaded service actually calls — resetModules() alone would
 *  otherwise leave a stale top-level `getDb` import pointing at the old
 *  module registry. */
function freshModule() {
    jest.resetModules();
    const { getDb } = require("../../config/database");
    const printSettingsService = require("../../services/printSettingsService");
    return { getDb, ...printSettingsService };
}

beforeEach(() => jest.clearAllMocks());

describe("printSettingsService", () => {
    it("defaults to enabled=true before initPrintSettings has ever run", () => {
        const { isPrintingEnabled } = freshModule();
        expect(isPrintingEnabled()).toBe(true);
    });

    it("loads the persisted value from print_settings on initPrintSettings", async () => {
        const { getDb, initPrintSettings, isPrintingEnabled } = freshModule();
        (getDb as jest.Mock).mockResolvedValue(makeDb({ id: 1, enabled: false }));

        await initPrintSettings();

        expect(isPrintingEnabled()).toBe(false);
    });

    it("defaults to enabled=true when no row exists yet", async () => {
        const { getDb, initPrintSettings, isPrintingEnabled } = freshModule();
        (getDb as jest.Mock).mockResolvedValue(makeDb(undefined));

        await initPrintSettings();

        expect(isPrintingEnabled()).toBe(true);
    });

    it("setPrintingEnabled updates both the DB and the in-memory value immediately", async () => {
        const { getDb, isPrintingEnabled, setPrintingEnabled } = freshModule();
        const db = makeDb({ id: 1, enabled: true });
        (getDb as jest.Mock).mockResolvedValue(db);

        await setPrintingEnabled(false);

        expect(isPrintingEnabled()).toBe(false);
        expect(db).toHaveBeenCalledWith("print_settings");
        const insertMock = (db as jest.Mock).mock.results[0]!.value.insert;
        expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({ id: 1, enabled: false }));

        await setPrintingEnabled(true);
        expect(isPrintingEnabled()).toBe(true);
    });

    it("initPrintSettings only reads the DB once, even if called again later", async () => {
        const { getDb, initPrintSettings } = freshModule();
        const db = makeDb({ id: 1, enabled: true });
        (getDb as jest.Mock).mockResolvedValue(db);

        await initPrintSettings();
        await initPrintSettings();

        expect(db).toHaveBeenCalledTimes(1);
    });
});
