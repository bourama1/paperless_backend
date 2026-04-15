// Mock dependencies FIRST to avoid side effects during imports
jest.mock('../../config/database');
jest.mock('../../services/notificationService');
jest.mock('fs');

import { reviseFile } from '../../controllers/filesController';
import { getDb } from '../../config/database';
import { notifyQueueUpdate } from '../../services/notificationService';
import { Request, Response } from 'express';
import fs from 'fs';

describe('Files Controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDb: any;

  beforeEach(() => {
    mockJson = jest.fn();
    mockStatus = jest.fn().mockReturnValue({ json: mockJson });
    mockResponse = {
      json: mockJson,
      status: mockStatus,
    };
    mockDb = {
      get: jest.fn(),
      run: jest.fn(),
      all: jest.fn(),
    };
    (getDb as jest.Mock).mockResolvedValue(mockDb);
    (fs.renameSync as jest.Mock).mockImplementation(() => {});
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('reviseFile', () => {
    it('should successfully revise a file and create a new revision', async () => {
      mockRequest = {
        params: { id: '1' },
        file: { path: 'temp/path', filename: 'new_file.pdf' } as any,
      };
      const mockDoc = { id: 1, name: 'document.pdf' };
      const mockLatestRevision = { version: 1, filename: 'document.pdf' };
      const mockUpdatedDoc = { id: 1, name: 'document.pdf', updated_at: '2026-04-15' };
      const mockRevisions = [
        { id: 2, document_id: 1, filename: 'document_v2.pdf', version: 2 },
        { id: 1, document_id: 1, filename: 'document.pdf', version: 1 }
      ];

      mockDb.get
        .mockResolvedValueOnce(mockDoc) // first call to find document
        .mockResolvedValueOnce(mockLatestRevision) // second call to find latest revision
        .mockResolvedValueOnce(mockUpdatedDoc); // third call to fetch updated doc

      mockDb.all.mockResolvedValueOnce(mockRevisions); // fetch all revisions

      await reviseFile(mockRequest as Request, mockResponse as Response);

      expect(fs.renameSync).toHaveBeenCalled();
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO revisions'),
        [expect.any(String), 'document_v2.pdf', 2]
      );
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE documents'),
        '1'
      );
      expect(notifyQueueUpdate).toHaveBeenCalledWith({ ...mockUpdatedDoc, revisions: mockRevisions });
      expect(mockJson).toHaveBeenCalledWith({ ...mockUpdatedDoc, revisions: mockRevisions });
    });

    it('should return 400 if no file is uploaded', async () => {
      mockRequest = { params: { id: '1' } };

      await reviseFile(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({ error: 'No file uploaded' });
    });

    it('should return 404 if document not found', async () => {
      mockRequest = {
        params: { id: '1' },
        file: { path: 'temp/path' } as any,
      };
      mockDb.get.mockResolvedValue(null);

      await reviseFile(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Document not found' });
    });
  });
});
