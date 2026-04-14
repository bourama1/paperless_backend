// Mock dependencies FIRST to avoid side effects during imports
jest.mock('../../config/database');
jest.mock('../../services/notificationService');

import { getQueue, addToQueue, updateStatus } from '../../controllers/queueController';
import { getDb } from '../../config/database';
import { notifyNewItem, notifyQueueUpdate } from '../../services/notificationService';
import { Request, Response } from 'express';

describe('Queue Controller', () => {
  let mockRequest: Partial<Request>;
  let mockResponse: Partial<Response>;
  let mockJson: jest.Mock;
  let mockStatus: jest.Mock;
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
    it('should return the queue items', async () => {
      const mockQueue = [{ id: 1, filename: 'test.pdf', status: 'pending' }];
      mockDb.all.mockResolvedValue(mockQueue);

      await getQueue(mockRequest as Request, mockResponse as Response);

      expect(mockDb.all).toHaveBeenCalledWith(expect.stringContaining('SELECT * FROM queue'));
      expect(mockJson).toHaveBeenCalledWith(mockQueue);
    });

    it('should handle errors', async () => {
      mockDb.all.mockRejectedValue(new Error('DB Error'));

      await getQueue(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(500);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Internal server error' });
    });
  });

  describe('addToQueue', () => {
    it('should add an item to the queue', async () => {
      mockRequest = { body: { filename: 'test.pdf' } };
      const mockNewItem = { id: 1, filename: 'test.pdf', status: 'pending' };
      mockDb.run.mockResolvedValue({ lastID: 1 });
      mockDb.get.mockResolvedValue(mockNewItem);

      await addToQueue(mockRequest as Request, mockResponse as Response);

      expect(mockDb.run).toHaveBeenCalled();
      expect(notifyNewItem).toHaveBeenCalledWith(mockNewItem);
      expect(mockStatus).toHaveBeenCalledWith(201);
      expect(mockJson).toHaveBeenCalledWith(mockNewItem);
    });

    it('should return 400 if filename is missing', async () => {
      mockRequest = { body: {} };

      await addToQueue(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Filename is required' });
    });
  });

  describe('updateStatus', () => {
    it('should update the status of an item', async () => {
      mockRequest = { params: { id: '1' }, body: { status: 'in-progress' } };
      const mockUpdatedItem = { id: 1, filename: 'test.pdf', status: 'in-progress' };
      mockDb.get.mockResolvedValue(mockUpdatedItem);

      await updateStatus(mockRequest as Request, mockResponse as Response);

      expect(mockDb.run).toHaveBeenCalled();
      expect(notifyQueueUpdate).toHaveBeenCalledWith(mockUpdatedItem);
      expect(mockJson).toHaveBeenCalledWith(mockUpdatedItem);
    });

    it('should return 400 if status is missing', async () => {
      mockRequest = { params: { id: '1' }, body: {} };

      await updateStatus(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Status is required' });
    });
  });
});
