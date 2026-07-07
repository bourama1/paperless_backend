jest.mock("../../config/database");
jest.mock("../../services/workstationService");
jest.mock("axios");
jest.mock("fs", () => {
  const actual = jest.requireActual("fs");
  return {
    ...actual,
    readFileSync: jest.fn((...args: any[]) => {
      if (
        typeof args[0] === "string" &&
        args[0].includes("country-codes.json")
      ) {
        return JSON.stringify({ germany: "DE", "czech republic": "CZ" });
      }
      return (actual as any).readFileSync(...args);
    }),
    writeFileSync: jest.fn(),
    unlinkSync: jest.fn(),
    copyFileSync: jest.fn(),
    mkdirSync: jest.fn(),
    existsSync: jest.fn().mockReturnValue(true),
    watchFile: jest.fn(),
  };
});

import {
  getWorkstations,
  receiveOrderUpdate,
  importPbom,
  searchPbomHandler,
  getWorkstationLog,
  renderDocument,
  saveEdited,
} from "../../controllers/workstationController";
import { getDb } from "../../config/database";
import {
  handleOrderUpdate,
  importDocument,
  searchPbom,
} from "../../services/workstationService";
import axios from "axios";
import fs from "fs";
import { Request, Response } from "express";
import { Readable } from "stream";

function thenable<T>(value: T) {
  return { then: (resolve: (v: T) => void) => resolve(value) };
}

describe("Workstation Controller", () => {
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

  describe("getWorkstations", () => {
    it("should return all workstations with parsed order data", async () => {
      const mockWorkstations = [
        {
          id: 1,
          name: "WS1",
          current_order_id: "ord1",
          current_order_data: JSON.stringify({ _id: "ord1" }),
        },
        {
          id: 2,
          name: "WS2",
          current_order_id: null,
          current_order_data: null,
        },
      ];

      const db = jest.fn();
      db.mockReturnValue({ orderBy: () => thenable(mockWorkstations) });
      (getDb as jest.Mock).mockResolvedValue(db);

      await getWorkstations(mockRequest as Request, mockResponse as Response);

      expect(db).toHaveBeenCalledWith("workstations");
      expect(mockJson).toHaveBeenCalledWith([
        {
          id: 1,
          name: "WS1",
          current_order_id: "ord1",
          current_order_data: { _id: "ord1" },
        },
        {
          id: 2,
          name: "WS2",
          current_order_id: null,
          current_order_data: null,
        },
      ]);
    });

    it("should handle errors", async () => {
      const db = jest.fn(() => ({
        orderBy: () => ({
          then: (_: any, reject: Function) => reject(new Error("DB Error")),
        }),
      }));
      (getDb as jest.Mock).mockResolvedValue(db);

      await getWorkstations(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });

  describe("receiveOrderUpdate", () => {
    const validUpdate = {
      order: {
        _id: "ord1",
        position: "01",
        productOrder: "PO-001",
        projectNumber: "PN-001",
        salesOrder: "SO-001",
        schedule: "SCH-001",
        type: "production",
        createdAt: "2026-01-01",
        customer: "Customer A",
        customerDesc: "Description",
        filename: "doc.pdf",
        maxCycle: 4,
        productDesc: "Product",
        quantity: 10,
        updatedAt: "2026-01-02",
        workplace: "Hardware",
      },
      cycleIndex: 1,
      totalCycles: 4,
      _id: "update1",
      datetime: "2026-01-03T12:00:00Z",
      action: "STARTED" as const,
    };

    it("should process a valid order update", async () => {
      mockRequest = { body: validUpdate };
      (handleOrderUpdate as jest.Mock).mockResolvedValue(undefined);

      await receiveOrderUpdate(
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(handleOrderUpdate).toHaveBeenCalledWith(validUpdate);
      expect(mockJson).toHaveBeenCalledWith({ status: "ok" });
    });

    it("should return 400 if payload is missing order or action", async () => {
      mockRequest = { body: {} };

      await receiveOrderUpdate(
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        error: "Invalid payload: order and action are required",
      });
    });

    it("should return 400 if action is invalid", async () => {
      mockRequest = { body: { order: { _id: "ord1" }, action: "INVALID" } };

      await receiveOrderUpdate(
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        error: "Invalid action. Must be STARTED or FINISHED",
      });
    });

    it("should handle errors from the service", async () => {
      mockRequest = { body: validUpdate };
      (handleOrderUpdate as jest.Mock).mockRejectedValue(
        new Error("Service error"),
      );

      await receiveOrderUpdate(
        mockRequest as Request,
        mockResponse as Response,
      );

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });

  describe("importPbom", () => {
    it("should import a PBOM document successfully", async () => {
      mockRequest = {
        body: {
          projectNumber: "PN-001",
          position: "01",
          customer: "Customer A",
          productOrder: "PO-001",
          productDesc: "Product",
        },
      };
      const mockDoc = {
        id: 1,
        name: "doc.pdf",
        revisions: [{ id: 1, version: 1 }],
      };
      (importDocument as jest.Mock).mockResolvedValue(mockDoc);

      await importPbom(mockRequest as Request, mockResponse as Response);

      expect(importDocument).toHaveBeenCalledWith({
        projectNumber: "PN-001",
        position: "01",
        customer: "Customer A",
        productOrder: "PO-001",
        productDesc: "Product",
        documentType: undefined,
      });
      expect(mockJson).toHaveBeenCalledWith(mockDoc);
    });

    it("should return 400 if required fields are missing", async () => {
      mockRequest = { body: {} };

      await importPbom(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        error: "projectNumber, position, and customer are required",
      });
    });

    it("should handle errors from the service", async () => {
      mockRequest = {
        body: {
          projectNumber: "PN-001",
          position: "01",
          customer: "Customer A",
        },
      };
      (importDocument as jest.Mock).mockRejectedValue(
        new Error("Import failed"),
      );

      await importPbom(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({ error: "Import failed" });
    });
  });

  describe("searchPbomHandler", () => {
    it("should return search results", async () => {
      mockRequest = { query: { order_code: "12345" } };
      const mockResults = [
        { customer_code: 0, order_code: 12345, position_code: 1 },
      ];
      (searchPbom as jest.Mock).mockResolvedValue(mockResults);

      await searchPbomHandler(mockRequest as Request, mockResponse as Response);

      expect(searchPbom).toHaveBeenCalledWith("12345");
      expect(mockJson).toHaveBeenCalledWith(mockResults);
    });

    it("should return 400 if order_code is missing", async () => {
      mockRequest = { query: {} };

      await searchPbomHandler(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        error: "order_code query parameter is required",
      });
    });

    it("should handle errors", async () => {
      mockRequest = { query: { order_code: "12345" } };
      (searchPbom as jest.Mock).mockRejectedValue(new Error("Search failed"));

      await searchPbomHandler(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });

  describe("getWorkstationLog", () => {
    it("should return logs without filters", async () => {
      const mockLogs = [
        {
          id: 1,
          workstation_name: "WS1",
          order_id: "ord1",
          action: "STARTED",
          order_snapshot: JSON.stringify({ _id: "ord1" }),
        },
      ];

      const mockOrderBy = jest.fn().mockReturnValue(thenable(mockLogs));
      const db = jest.fn();
      db.mockReturnValue({
        where: () => ({ orderBy: () => ({ limit: () => thenable(mockLogs) }) }),
        orderBy: mockOrderBy,
      });
      (getDb as jest.Mock).mockResolvedValue(db);

      await getWorkstationLog(mockRequest as Request, mockResponse as Response);

      expect(db).toHaveBeenCalledWith("workstation_log");
      expect(mockOrderBy).toHaveBeenCalledWith("created_at", "desc");
      expect(mockJson).toHaveBeenCalledWith([
        {
          id: 1,
          workstation_name: "WS1",
          order_id: "ord1",
          action: "STARTED",
          order_snapshot: { _id: "ord1" },
        },
      ]);
    });

    it("should filter by workstation name", async () => {
      mockRequest = { query: { workstation: "WS1" } };
      const db = jest.fn();
      const mockWhere = { orderBy: () => thenable([]) };
      db.mockReturnValue({ where: () => mockWhere, orderBy: mockWhere });
      (getDb as jest.Mock).mockResolvedValue(db);

      await getWorkstationLog(mockRequest as Request, mockResponse as Response);

      expect(db).toHaveBeenCalledWith("workstation_log");
    });

    it("should handle errors", async () => {
      const db = jest.fn(() => {
        throw new Error("DB Error");
      });
      (getDb as jest.Mock).mockResolvedValue(db);

      await getWorkstationLog(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({ error: "Internal server error" });
    });
  });

  describe("renderDocument", () => {
    it("should stream a PDF from docmgr reference", async () => {
      mockRequest = { params: { id: "1" } };

      const mockDoc = { id: 1, name: "doc.pdf" };
      const mockRev = { version: 1, filename: "docmgr://PN001/01/14" };
      const mockStream = new Readable({
        read() {
          this.push(Buffer.from("%PDF-1.4"));
          this.push(null);
        },
      });

      const db = jest.fn();
      db.mockImplementation((table: string) => {
        if (table === "documents") {
          return { where: () => ({ first: () => thenable(mockDoc) }) };
        }
        return {
          select: () => ({
            where: () => ({
              orderBy: () => ({ first: () => thenable(mockRev) }),
            }),
          }),
        };
      });
      (getDb as jest.Mock).mockResolvedValue(db);

      (axios.get as jest.Mock).mockResolvedValue({ data: mockStream });

      const mockSetHeader = jest.fn();
      const mockPipe = jest.fn();
      (mockResponse as any).setHeader = mockSetHeader;
      (mockResponse as any).pipe = mockPipe;

      await renderDocument(mockRequest as Request, mockResponse as Response);

      expect(axios.get).toHaveBeenCalledWith(
        expect.stringContaining("/api/documents/fetch"),
        expect.objectContaining({
          params: {
            order_code: "PN001",
            position_code: "01",
            document_type: 14,
          },
        }),
      );
      expect(mockSetHeader).toHaveBeenCalledWith(
        "Content-Type",
        "application/pdf",
      );
    });

    it("should return 404 if document not found", async () => {
      mockRequest = { params: { id: "999" } };

      const db = jest.fn();
      db.mockReturnValue({ where: () => ({ first: () => thenable(null) }) });
      (getDb as jest.Mock).mockResolvedValue(db);

      await renderDocument(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith({ error: "Document not found" });
    });
  });

  describe("saveEdited", () => {
    beforeEach(() => {
      (fs.existsSync as jest.Mock).mockReturnValue(true);
      (fs.writeFileSync as jest.Mock).mockImplementation(() => {});
      (fs.copyFileSync as jest.Mock).mockImplementation(() => {});
      (fs.mkdirSync as jest.Mock).mockImplementation(() => {});
    });

    it("should save an edited PDF successfully", async () => {
      mockRequest = {
        body: {
          documentId: 1,
          pdfBase64: Buffer.from("%PDF-1.4 mock").toString("base64"),
        },
      };

      const mockDoc = { id: 1, name: "doc.pdf" };
      const mockCountResult = { count: 0 };

      const db = Object.assign(jest.fn(), {
        fn: { now: jest.fn(() => "CURRENT_TIMESTAMP") },
      });

      db.mockReturnValueOnce({
        where: () => ({ first: () => thenable(mockDoc) }),
      })
        .mockReturnValueOnce({
          where: () => ({
            andWhereNot: () => ({
              count: () => ({ first: () => thenable(mockCountResult) }),
            }),
          }),
        })
        .mockReturnValueOnce({ insert: () => thenable(undefined) });

      (getDb as jest.Mock).mockResolvedValue(db);

      await saveEdited(mockRequest as Request, mockResponse as Response);

      expect(fs.writeFileSync).toHaveBeenCalled();
      expect(mockJson).toHaveBeenCalledWith(
        expect.objectContaining({ status: "ok" }),
      );
    });

    it("should return 400 if documentId or pdfBase64 is missing", async () => {
      mockRequest = { body: {} };

      await saveEdited(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({
        error: "documentId and pdfBase64 are required",
      });
    });
  });
});
