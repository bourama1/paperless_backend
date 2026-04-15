// Mock dependencies FIRST to avoid side effects during imports
jest.mock('../../config/database');
jest.mock('../../services/notificationService');

import { getQueue, addToQueue, updateStatus } from '../../controllers/queueController';
import { getDb } from '../../config/database';
import { notifyNewItem } from '../../services/notificationService';
import { Request, Response } from 'express';

describe('Queue Controller', () => {
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
      all: jest.fn(),
      run: jest.fn(),
      get: jest.fn(),
    };
    (getDb as jest.Mock).mockResolvedValue(mockDb);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('getQueue', () => {
    it('should return all documents with revisions', async () => {
      const mockDocs = [{ id: 1, name: 'doc1.pdf' }];
      const mockRevisions = [{ id: 1, document_id: 1, filename: 'doc1.pdf', version: 1 }];
      
      mockDb.all
        .mockResolvedValueOnce(mockDocs) // for documents
        .mockResolvedValueOnce(mockRevisions); // for revisions of doc 1

      await getQueue(mockRequest as Request, mockResponse as Response);

      expect(mockDb.all).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM documents'));
      expect(mockJson).toHaveBeenCalledWith([{ ...mockDocs[0], revisions: mockRevisions }]);
    });

    it('should handle errors', async () => {
      mockDb.all.mockRejectedValue(new Error('DB Error'));

      await getQueue(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Internal server error' });
    });
  });

  describe('addToQueue', () => {
    it('should add a document and its first revision', async () => {
      mockRequest = { body: { filename: 'test.pdf' } };
      const mockNewDoc = { id: 1, name: 'test.pdf' };
      const mockRevisions = [{ id: 1, document_id: 1, filename: 'test.pdf', version: 1 }];
      
      mockDb.run.mockResolvedValue({ lastID: 1 });
      mockDb.get.mockResolvedValue(mockNewDoc);
      mockDb.all.mockResolvedValue(mockRevisions);

      await addToQueue(mockRequest as Request, mockResponse as Response);

      expect(mockDb.run).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO documents'), ['test.pdf']);
      expect(notifyNewItem).toHaveBeenCalledWith({ ...mockNewDoc, revisions: mockRevisions });
      expect(mockStatus).toHaveBeenCalledWith(201);
      expect(mockJson).toHaveBeenCalledWith({ ...mockNewDoc, revisions: mockRevisions });
    });

    it('should return 400 if filename is missing', async () => {
      mockRequest = { body: {} };

      await addToQueue(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Filename is required' });
    });
  });

  describe('updateStatus', () => {
    it('should return 410 Gone as status updates are deprecated', async () => {
      mockRequest = { params: { id: '1' }, body: { status: 'in-progress' } };

      await updateStatus(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(410);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Status updates are no longer supported. Use revisions instead.' });
    });
  });
});
