import { Request, Response } from 'express';
import { getDb } from '../config/database';
import path from 'path';
import fs from 'fs';
import { notifyQueueUpdate } from '../services/notificationService';

export const reviseFile = async (req: Request, res: Response) => {
  const { id } = req.params;
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const db = await getDb();
    const item = await db.get('SELECT * FROM queue WHERE id = ?', id);

    if (!item) {
      return res.status(404).json({ error: 'Queue item not found' });
    }

    const newVersion = item.version + 1;
    const oldFilename = item.filename;
    const ext = path.extname(oldFilename);
    const basename = path.basename(oldFilename, ext);
    
    // Naming convention: basename_v2.pdf
    const newFilename = `${basename}_v${newVersion}${ext}`;
    const storagePath = process.env.STORAGE_PATH || './storage';
    const finalPath = path.join(storagePath, newFilename);

    // Move uploaded file to final destination
    fs.renameSync(file.path, finalPath);

    // Update database
    await db.run(
      'UPDATE queue SET filename = ?, version = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      [newFilename, newVersion, id]
    );

    const updatedItem = await db.get('SELECT * FROM queue WHERE id = ?', id);

    // Notify clients about the update
    notifyQueueUpdate(updatedItem);

    res.json(updatedItem);
  } catch (error) {
    console.error('Error revising file:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
