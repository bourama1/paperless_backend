import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import cors from 'cors';
import morgan from 'morgan';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';

import { getDb } from './config/database';

import queueRoutes from './routes/queue';
import filesRoutes from './routes/files';

// Load environment variables
dotenv.config();

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;

// Initialize Database
const initDb = async () => {
  try {
    await getDb();
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Failed to initialize database:', error);
  }
};

if (process.env.NODE_ENV !== 'test') {
  initDb();
}

// Middleware
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

// Static files for PDFs
const STORAGE_PATH = process.env.STORAGE_PATH || path.join(__dirname, '../storage');
if (!fs.existsSync(STORAGE_PATH)) {
  fs.mkdirSync(STORAGE_PATH, { recursive: true });
}

const UPLOADS_PATH = path.join(__dirname, '../uploads');
if (!fs.existsSync(UPLOADS_PATH)) {
  fs.mkdirSync(UPLOADS_PATH, { recursive: true });
}

app.use('/files', express.static(STORAGE_PATH));

// Routes
app.use('/queue', queueRoutes);
app.use('/files', filesRoutes);
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Socket.io connection
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);
  
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

// Start server
if (process.env.NODE_ENV !== 'test') {
  httpServer.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}

export { io };
