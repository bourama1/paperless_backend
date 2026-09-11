process.env.TOORS_SERVICE_URL = "http://toors-bridge:3310";

jest.mock("axios");
import axios from "axios";
import { closeOrderInToors } from "../../services/toorsService";

const mockedPost = axios.post as jest.Mock;

beforeEach(() => jest.clearAllMocks());

describe("closeOrderInToors", () => {
    it("returns success and logs planned/closed_before on a clean 200 response", async () => {
        mockedPost.mockResolvedValue({
            data: {
                order_number: "227789",
                id: "040-522736",
                planned: "1 pcs",
                closed_before: "0 pcs",
                quantity_entered: 1,
                result: "Order closed OK",
            },
        });

        const result = await closeOrderInToors("227789", 1);

        expect(result.success).toBe(true);
        expect(result.order_number).toBe("227789");
        expect(result.detail?.planned).toBe("1 pcs");
        expect(result.detail?.quantity_entered).toBe(1);
        expect(mockedPost).toHaveBeenCalledWith(
            "http://toors-bridge:3310/close-order",
            { order_number: "227789", quantity: 1 },
            { timeout: 10_000 },
        );
    });

    it("sends the correct quantity for a Motor batch order (quantity > 1)", async () => {
        mockedPost.mockResolvedValue({
            data: { order_number: "230910", id: "040-530123", planned: "5 pcs", closed_before: "0 pcs", quantity_entered: 5, result: "OK" },
        });

        const result = await closeOrderInToors("230910", 5);

        expect(result.success).toBe(true);
        expect(mockedPost).toHaveBeenCalledWith(
            expect.any(String),
            { order_number: "230910", quantity: 5 },
            expect.any(Object),
        );
    });

    it("floors a float quantity to the nearest integer", async () => {
        mockedPost.mockResolvedValue({
            data: { order_number: "230910", id: "x", planned: "3 pcs", closed_before: "0 pcs", quantity_entered: 3, result: "OK" },
        });

        await closeOrderInToors("230910", 3.9);

        expect(mockedPost).toHaveBeenCalledWith(
            expect.any(String),
            { order_number: "230910", quantity: 3 },
            expect.any(Object),
        );
    });

    it("returns failure (not throws) when the order is not found in TOORS (404)", async () => {
        const err: any = new Error("Not found");
        err.response = { status: 404, data: { detail: "Order 999 not found" } };
        mockedPost.mockRejectedValue(err);

        const result = await closeOrderInToors("999", 1);

        expect(result.success).toBe(false);
        expect(result.status).toBe(404);
        expect(result.error).toContain("not found");
    });

    it("returns failure (not throws) when TOORS itself is unreachable (502)", async () => {
        const err: any = new Error("Bad gateway");
        err.response = { status: 502, data: { detail: "Connection refused" } };
        mockedPost.mockRejectedValue(err);

        const result = await closeOrderInToors("227789", 1);

        expect(result.success).toBe(false);
        expect(result.status).toBe(502);
    });

    it("returns failure gracefully on a network-level error (no response)", async () => {
        mockedPost.mockRejectedValue(new Error("ECONNREFUSED"));

        const result = await closeOrderInToors("227789", 1);

        expect(result.success).toBe(false);
        expect(result.error).toContain("ECONNREFUSED");
    });

    it("skips the call and returns disabled when TOORS_SERVICE_URL is not set", async () => {
        const original = process.env.TOORS_SERVICE_URL;
        delete process.env.TOORS_SERVICE_URL;
        jest.resetModules();
        const { closeOrderInToors: fn } = require("../../services/toorsService");

        const result = await fn("227789", 1);

        expect(result.success).toBe(false);
        expect(result.error).toMatch(/not configured/i);
        expect(mockedPost).not.toHaveBeenCalled();
        process.env.TOORS_SERVICE_URL = original;
    });

    it("skips and returns error for an empty productOrder number", async () => {
        const result = await closeOrderInToors("", 1);
        expect(result.success).toBe(false);
        expect(mockedPost).not.toHaveBeenCalled();
    });
});
