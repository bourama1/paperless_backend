jest.mock("../../services/ptlPlanService");

import { Request, Response } from "express";
import { getPrepItems, checkPrepItem, uncheckPrepItem } from "../../controllers/prepQueueController";
import {
    getNonPtlItemsForOrder,
    recordPrepItemChecked,
    recordPrepItemUnchecked,
} from "../../services/ptlPlanService";

describe("Prep Queue Controller — item checklist", () => {
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

    describe("getPrepItems", () => {
        it("returns 400 when projectNumber or position is missing", async () => {
            mockRequest = { query: { projectNumber: "PN1" } };

            await getPrepItems(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(getNonPtlItemsForOrder).not.toHaveBeenCalled();
        });

        it("returns the checklist for the given order", async () => {
            const checklist = { items: [{ itemID: "X1", checked: false }], allPrepared: false };
            (getNonPtlItemsForOrder as jest.Mock).mockResolvedValue(checklist);
            mockRequest = { query: { projectNumber: "PN1", position: "01" } };

            await getPrepItems(mockRequest as Request, mockResponse as Response);

            expect(getNonPtlItemsForOrder).toHaveBeenCalledWith("PN1", "01");
            expect(mockJson).toHaveBeenCalledWith(checklist);
        });

        it("returns 500 on a service error", async () => {
            (getNonPtlItemsForOrder as jest.Mock).mockRejectedValue(new Error("DB error"));
            mockRequest = { query: { projectNumber: "PN1", position: "01" } };

            await getPrepItems(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
        });
    });

    describe("checkPrepItem", () => {
        it("returns 400 when a required field is missing", async () => {
            mockRequest = { body: { projectNumber: "PN1", position: "01", itemId: "X1" } };

            await checkPrepItem(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(recordPrepItemChecked).not.toHaveBeenCalled();
        });

        it("records the check and returns the updated checklist", async () => {
            const checklist = { items: [{ itemID: "X1", checked: true }], allPrepared: true };
            (getNonPtlItemsForOrder as jest.Mock).mockResolvedValue(checklist);
            mockRequest = {
                body: {
                    projectNumber: "PN1",
                    position: "01",
                    itemId: "X1",
                    itemDesc: "Bracket",
                    employeeName: "Jan Novak",
                },
            };

            await checkPrepItem(mockRequest as Request, mockResponse as Response);

            expect(recordPrepItemChecked).toHaveBeenCalledWith("PN1", "01", "X1", "Bracket", "Jan Novak");
            expect(mockStatus).toHaveBeenCalledWith(201);
            expect(mockJson).toHaveBeenCalledWith(checklist);
        });

        it("returns 500 on a service error", async () => {
            (recordPrepItemChecked as jest.Mock).mockRejectedValue(new Error("DB error"));
            mockRequest = {
                body: { projectNumber: "PN1", position: "01", itemId: "X1", employeeName: "Jan Novak" },
            };

            await checkPrepItem(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
        });
    });

    describe("uncheckPrepItem", () => {
        it("returns 400 when a required field is missing", async () => {
            mockRequest = { body: { projectNumber: "PN1", position: "01" } };

            await uncheckPrepItem(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(recordPrepItemUnchecked).not.toHaveBeenCalled();
        });

        it("records the uncheck and returns the updated checklist", async () => {
            const checklist = { items: [{ itemID: "X1", checked: false }], allPrepared: false };
            (getNonPtlItemsForOrder as jest.Mock).mockResolvedValue(checklist);
            mockRequest = { body: { projectNumber: "PN1", position: "01", itemId: "X1" } };

            await uncheckPrepItem(mockRequest as Request, mockResponse as Response);

            expect(recordPrepItemUnchecked).toHaveBeenCalledWith("PN1", "01", "X1");
            expect(mockStatus).toHaveBeenCalledWith(200);
            expect(mockJson).toHaveBeenCalledWith(checklist);
        });

        it("returns 500 on a service error", async () => {
            (recordPrepItemUnchecked as jest.Mock).mockRejectedValue(new Error("DB error"));
            mockRequest = { body: { projectNumber: "PN1", position: "01", itemId: "X1" } };

            await uncheckPrepItem(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
        });
    });
});
