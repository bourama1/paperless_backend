import { redactApiKey } from "../../utils/redactApiKey";

describe("redactApiKey", () => {
    it("masks a ?apiKey= query param", () => {
        expect(redactApiKey("/workstations/documents/1/render?apiKey=secret123")).toBe(
            "/workstations/documents/1/render?apiKey=***",
        );
    });

    it("masks a &apiKey= param that isn't first in the query string", () => {
        expect(redactApiKey("/render?t=5&apiKey=secret123&other=1")).toBe(
            "/render?t=5&apiKey=***&other=1",
        );
    });

    it("is case-insensitive on the param name", () => {
        expect(redactApiKey("/render?ApiKey=secret123")).toBe("/render?ApiKey=***");
    });

    it("leaves URLs without an apiKey param untouched", () => {
        expect(redactApiKey("/queue?foo=bar")).toBe("/queue?foo=bar");
    });

    it("handles morgan-style log lines with an embedded URL", () => {
        expect(redactApiKey("GET /render?apiKey=secret123 200 12ms")).toBe(
            "GET /render?apiKey=*** 200 12ms",
        );
    });
});
