process.env.TOORS_SERVICE_URL = "http://toors-bridge:3310";

jest.mock("axios");
import axios from "axios";
import { closeOrderInToors } from "../../services/toorsService";

const mockedPost = axios.post as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("closeOrderInToors", () => {
    it("returns queued=true with the job id once the bridge accepts the job", async () => {
        mockedPost.mockResolvedValue({ data: { job_id: "job1", status: "queued" } });

        const result = await closeOrderInToors("227789", 1);

        expect(result.queued).toBe(true);
        expect(result.order_number).toBe("227789");
        expect(result.job_id).toBe("job1");
        expect(result.error).toBeUndefined();
        expect(mockedPost).toHaveBeenCalledWith(
            "http://toors-bridge:3310/close-order",
            { order_number: "227789", quantity: 1 },
            { timeout: 10_000 },
        );
    });

    it("does not wait for the job to finish — resolves as soon as the bridge responds", async () => {
        mockedPost.mockResolvedValue({ data: { job_id: "job1", status: "queued" } });

        const result = await closeOrderInToors("227789", 1);

        expect(result.queued).toBe(true);
        expect(mockedPost).toHaveBeenCalledTimes(1);
    });

    it("sends the correct quantity for a Motor batch order (quantity > 1)", async () => {
        mockedPost.mockResolvedValue({ data: { job_id: "job1", status: "queued" } });

        const result = await closeOrderInToors("230910", 5);

        expect(result.queued).toBe(true);
        expect(mockedPost).toHaveBeenCalledWith(
            expect.any(String),
            { order_number: "230910", quantity: 5 },
            expect.any(Object),
        );
    });

    it("floors a float quantity to the nearest integer", async () => {
        mockedPost.mockResolvedValue({ data: { job_id: "job1", status: "queued" } });

        await closeOrderInToors("230910", 3.9);

        expect(mockedPost).toHaveBeenCalledWith(
            expect.any(String),
            { order_number: "230910", quantity: 3 },
            expect.any(Object),
        );
    });

    it("returns queued=false with an error when the bridge is unreachable", async () => {
        mockedPost.mockRejectedValue(new Error("ECONNREFUSED"));

        const result = await closeOrderInToors("227789", 1);

        expect(result.queued).toBe(false);
        expect(result.error).toContain("ECONNREFUSED");
    });

    it("skips the call and returns disabled when TOORS_SERVICE_URL is not set", async () => {
        const original = process.env.TOORS_SERVICE_URL;
        delete process.env.TOORS_SERVICE_URL;
        jest.resetModules();
        const { closeOrderInToors: fn } = require("../../services/toorsService");

        const result = await fn("227789", 1);

        expect(result.queued).toBe(false);
        expect(result.error).toMatch(/not configured/i);
        expect(mockedPost).not.toHaveBeenCalled();
        process.env.TOORS_SERVICE_URL = original;
    });

    it("skips and returns error for an empty productOrder number", async () => {
        const result = await closeOrderInToors("", 1);
        expect(result.queued).toBe(false);
        expect(mockedPost).not.toHaveBeenCalled();
    });
});
