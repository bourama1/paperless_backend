import request from 'supertest';
import express from 'express';
import { createServer } from 'http';
import { Server as SocketIOServer } from 'socket.io';
import { getDb } from '../../config/database';
import queueRoutes from '../../routes/queue';

// Mock dependencies
jest.mock('../../config/database');
jest.mock('../../services/notificationService');

describe('API Integration Tests', () => {
  let app: express.Express;
  let mockDb: any;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/queue', queueRoutes);

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
    it('should return 200 and the queue items', async () => {
      const mockQueue = [{ id: 1, filename: 'test.pdf', status: 'pending' }];
      mockDb.all.mockResolvedValue(mockQueue);

      const response = await request(app).get('/queue');

      expect(response.status).toBe(200);
      expect(response.body).toEqual(mockQueue);
    });
  });

  describe('POST /queue', () => {
    it('should return 201 and the new queue item', async () => {
      const mockNewItem = { id: 1, filename: 'new.pdf', status: 'pending' };
      mockDb.run.mockResolvedValue({ lastID: 1 });
      mockDb.get.mockResolvedValue(mockNewItem);

      const response = await request(app)
        .post('/queue')
        .send({ filename: 'new.pdf' });

      expect(response.status).toBe(201);
      expect(response.body).toEqual(mockNewItem);
    });
  });
});
