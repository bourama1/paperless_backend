jest.mock("../../services/printSettingsService");

import { Request, Response } from "express";
import { getPrintingSetting, updatePrintingSetting } from "../../controllers/settingsController";
import { isPrintingEnabled, setPrintingEnabled } from "../../services/printSettingsService";

describe("Settings Controller — printing", () => {
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;
    let mockJson: jest.Mock;
    let mockStatus: jest.Mock;

    beforeEach(() => {
        jest.clearAllMocks();
        mockJson = jest.fn();
        mockStatus = jest.fn(() => mockResponse as Response);
        mockResponse = { json: mockJson, status: mockStatus };
    });

    describe("getPrintingSetting", () => {
        it("returns the current in-memory value", async () => {
            (isPrintingEnabled as jest.Mock).mockReturnValue(true);
            mockRequest = {};

            await getPrintingSetting(mockRequest as Request, mockResponse as Response);

            expect(mockJson).toHaveBeenCalledWith({ enabled: true });
        });
    });

    describe("updatePrintingSetting", () => {
        it("returns 400 when enabled is missing or not a boolean", async () => {
            mockRequest = { body: {} };
            await updatePrintingSetting(mockRequest as Request, mockResponse as Response);
            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(setPrintingEnabled).not.toHaveBeenCalled();

            mockRequest = { body: { enabled: "false" } };
            await updatePrintingSetting(mockRequest as Request, mockResponse as Response);
            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(setPrintingEnabled).not.toHaveBeenCalled();
        });

        it("disables printing and returns the new value", async () => {
            mockRequest = { body: { enabled: false } };

            await updatePrintingSetting(mockRequest as Request, mockResponse as Response);

            expect(setPrintingEnabled).toHaveBeenCalledWith(false);
            expect(mockJson).toHaveBeenCalledWith({ enabled: false });
        });

        it("returns 500 on a service error", async () => {
            (setPrintingEnabled as jest.Mock).mockRejectedValue(new Error("DB error"));
            mockRequest = { body: { enabled: true } };

            await updatePrintingSetting(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
        });
    });
});
