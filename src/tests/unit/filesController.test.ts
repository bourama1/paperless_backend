// Mock dependencies FIRST to avoid side effects during imports
jest.mock('../../config/database');
jest.mock('../../services/notificationService');
// We will mock fs.renameSync specifically instead of the whole module
import fs from 'fs';
jest.mock('fs', () => {
  const originalModule = jest.requireActual('fs');
  return {
    ...originalModule,
    renameSync: jest.fn(),
  };
});

import { reviseFile } from '../../controllers/filesController';
import { getDb } from '../../config/database';
import { notifyQueueUpdate } from '../../services/notificationService';
import { Request, Response } from 'express';

describe('Files Controller', () => {
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
      get: jest.fn(),
      run: jest.fn(),
    };
    (getDb as jest.Mock).mockResolvedValue(mockDb);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  describe('reviseFile', () => {
    it('should successfully revise a file', async () => {
      const mockItem = { id: 1, filename: 'document.pdf', version: 1 };
      const mockUpdatedItem = { id: 1, filename: 'document_v2.pdf', version: 2 };
      
      mockRequest = {
        params: { id: '1' },
        file: { path: '/tmp/upload', originalname: 'test.pdf' } as Express.Multer.File
      };
      
      mockDb.get.mockResolvedValueOnce(mockItem).mockResolvedValueOnce(mockUpdatedItem);
      
      await reviseFile(mockRequest as Request, mockResponse as Response);

      expect(fs.renameSync).toHaveBeenCalled();
      expect(mockDb.run).toHaveBeenCalledWith(
        expect.stringContaining('UPDATE queue'),
        [expect.stringContaining('_v2.pdf'), 2, '1']
      );
      expect(notifyQueueUpdate).toHaveBeenCalledWith(mockUpdatedItem);
      expect(mockJson).toHaveBeenCalledWith(mockUpdatedItem);
    });

    it('should return 400 if no file is uploaded', async () => {
      mockRequest = { params: { id: '1' } };

      await reviseFile(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(400);
      expect(mockJson).toHaveBeenCalledWith({ error: 'No file uploaded' });
    });

    it('should return 404 if item not found', async () => {
      mockRequest = {
        params: { id: '999' },
        file: { path: '/tmp/upload' } as Express.Multer.File
      };
      mockDb.get.mockResolvedValue(null);

      await reviseFile(mockRequest as Request, mockResponse as Response);

      expect(mockStatus).toHaveBeenCalledWith(404);
      expect(mockJson).toHaveBeenCalledWith({ error: 'Queue item not found' });
    });
  });
});
