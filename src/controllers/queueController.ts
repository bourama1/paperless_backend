import { Request, Response } from 'express';
import { getDb } from '../config/database';
import { notifyNewItem, notifyQueueUpdate } from '../services/notificationService';

export const getQueue = async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const queue = await db.all('SELECT * FROM queue WHERE status != "completed" ORDER BY created_at ASC');
    res.json(queue);
  } catch (error) {
    console.error('Error fetching queue:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const addToQueue = async (req: Request, res: Response) => {
  const { filename } = req.body;
  if (!filename) {
    return res.status(400).json({ error: 'Filename is required' });
  }

  try {
    const db = await getDb();
    const result = await db.run(
      'INSERT INTO queue (filename, status) VALUES (?, ?)',
      [filename, 'pending']
    );
    const newItem = await db.get('SELECT * FROM queue WHERE id = ?', result.lastID);
    
    notifyNewItem(newItem);
    res.status(201).json(newItem);
  } catch (error) {
    console.error('Error adding to queue:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateStatus = async (req: Request, res: Response) => {
  const { id } = req.params;
  const { status } = req.body;

  if (!status) {
    return res.status(400).json({ error: 'Status is required' });
  }

  try {
    const db = await getDb();
    await db.run(
      'UPDATE queue SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [status, id]
    );
    const updatedItem = await db.get('SELECT * FROM queue WHERE id = ?', id);
    
    notifyQueueUpdate(updatedItem);
    res.json(updatedItem);
  } catch (error) {
    console.error('Error updating status:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
