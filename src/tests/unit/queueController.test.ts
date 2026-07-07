jest.mock("../../config/database");
jest.mock("../../services/notificationService");

import { getQueue, addToQueue, updateStatus } from "../../controllers/queueController";
import { getDb, insertGetId } from "../../config/database";
import { notifyNewItem } from "../../services/notificationService";
import { Request, Response } from "express";

/** Build a thenable that resolves to `value` when awaited via `.then()` */
function thenable<T>(value: T) {
    return { then: (resolve: (v: T) => void) => resolve(value) };
}

describe("Queue Controller", () => {
    let mockRequest: Partial<Request>;
    let mockResponse: Partial<Response>;
    let mockJson: jest.Mock;
    let mockStatus: jest.Mock;

    beforeEach(() => {
        mockJson = jest.fn();
        mockStatus = jest.fn().mockReturnValue({ json: mockJson });
        mockResponse = { json: mockJson, status: mockStatus };
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    describe("getQueue", () => {
        it("should return all documents with revisions", async () => {
            const mockDocs = [{ id: 1, name: "doc1.pdf" }];
            const mockRevisions = [{ id: 1, document_id: 1, filename: "doc1.pdf", version: 1 }];

            const db = jest.fn();
            db.mockImplementation((table: string) => {
                if (table === "documents") {
                    return { orderBy: () => thenable(mockDocs) };
                }
                return { where: () => ({ orderBy: () => thenable(mockRevisions) }) };
            });
            (getDb as jest.Mock).mockResolvedValue(db);

            await getQueue(mockRequest as Request, mockResponse as Response);

            expect(db).toHaveBeenCalledWith("documents");
            expect(db).toHaveBeenCalledWith("revisions");
            expect(mockJson).toHaveBeenCalledWith([{ ...mockDocs[0], revisions: mockRevisions }]);
        });

        it("should handle errors", async () => {
            const db = jest.fn(() => ({
                orderBy: () => ({ then: (_: any, reject: Function) => reject(new Error("DB Error")) }),
            }));
            (getDb as jest.Mock).mockResolvedValue(db);

            await getQueue(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(500);
            expect(mockJson).toHaveBeenCalledWith({ error: "Internal server error" });
        });
    });

    describe("addToQueue", () => {
        it("should add a document and its first revision", async () => {
            mockRequest = { body: { filename: "test.pdf" } };
            const mockNewDoc = { id: 1, name: "test.pdf" };
            const mockRevisions = [{ id: 1, document_id: 1, filename: "test.pdf", version: 1 }];

            const db = jest.fn();
            db.mockReturnValueOnce({
                insert: () => ({ returning: () => [1] }),
            })
                .mockReturnValueOnce({ insert: () => thenable(undefined) })
                .mockReturnValueOnce({
                    where: () => ({ first: () => thenable(mockNewDoc) }),
                })
                .mockReturnValueOnce({
                    where: () => thenable(mockRevisions),
                });
            (getDb as jest.Mock).mockResolvedValue(db);

            await addToQueue(mockRequest as Request, mockResponse as Response);

            expect(db).toHaveBeenCalledWith("documents");
            expect(db).toHaveBeenCalledWith("revisions");
            expect(notifyNewItem).toHaveBeenCalledWith({ ...mockNewDoc, revisions: mockRevisions });
            expect(mockStatus).toHaveBeenCalledWith(201);
            expect(mockJson).toHaveBeenCalledWith({ ...mockNewDoc, revisions: mockRevisions });
        });

        it("should return 400 if filename is missing", async () => {
            mockRequest = { body: {} };

            await addToQueue(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(400);
            expect(mockJson).toHaveBeenCalledWith({ error: "Filename is required" });
        });
    });

    describe("updateStatus", () => {
        it("should return 410 Gone as status updates are deprecated", async () => {
            mockRequest = { params: { id: "1" }, body: { status: "in-progress" } };

            await updateStatus(mockRequest as Request, mockResponse as Response);

            expect(mockStatus).toHaveBeenCalledWith(410);
            expect(mockJson).toHaveBeenCalledWith({
                error: "Status updates are no longer supported. Use revisions instead.",
            });
        });
    });
});
