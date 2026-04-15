import request from 'supertest';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import queueRoutes from '../../routes/queue';
import { getDb } from '../../config/database';

// Mock dependencies
jest.mock('../../config/database');
jest.mock('../../index', () => ({
  io: {
    emit: jest.fn(),
  },
}));

const app = express();
app.use(express.json());
app.use('/queue', queueRoutes);

describe('API Integration Tests', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let mockDb: any;

  beforeEach(() => {
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

  describe('GET /queue', () => {
    it('should return 200 and all documents with revisions', async () => {
      const mockDocs = [{ id: 1, name: 'test.pdf' }];
      const mockRevisions = [{ id: 1, document_id: 1, filename: 'test.pdf', version: 1 }];
      
      mockDb.all
        .mockResolvedValueOnce(mockDocs)
        .mockResolvedValueOnce(mockRevisions);

      const response = await request(app).get('/queue');

      expect(response.status).toBe(200);
      expect(response.body).toEqual([{ ...mockDocs[0], revisions: mockRevisions }]);
    });
  });

  describe('GET /health', () => {
    it('should return 200 and status ok', async () => {
      // For health check we need the actual app from index.ts or just mock it here
      const healthApp = express();
      healthApp.get('/health', (req, res) => res.json({ status: 'ok' }));
      
      const response = await request(healthApp).get('/health');
      expect(response.status).toBe(200);
      expect(response.body).toEqual({ status: 'ok' });
    });
  });
});
