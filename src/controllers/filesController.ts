import { Request, Response } from 'express';
import { getDb } from '../config/database';
import path from 'path';
import fs from 'fs';
import { notifyQueueUpdate } from '../services/notificationService';

export const reviseFile = async (req: Request, res: Response) => {
  const { id } = req.params; // Document ID
  const file = req.file;

  if (!file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  try {
    const db = await getDb();
    const doc = await db.get('SELECT * FROM documents WHERE id = ?', id);

    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    // Get latest revision to determine next version number
    const latestRevision = await db.get(
      'SELECT version, filename FROM revisions WHERE document_id = ? ORDER BY version DESC LIMIT 1',
      id
    );

    const newVersion = (latestRevision?.version || 0) + 1;
    const oldFilename = latestRevision?.filename || doc.name;
    const ext = path.extname(oldFilename);
    const basename = path.basename(oldFilename, ext).split('_v')[0]; // Strip existing version suffix if any
    
    // Naming convention: basename_v2.pdf
    const newFilename = `${basename}_v${newVersion}${ext}`;
    const storagePath = process.env.STORAGE_PATH || './storage';
    const finalPath = path.join(storagePath, newFilename);

    // Move uploaded file to final destination
    fs.renameSync(file.path, finalPath);

    // 1. Insert new revision
    await db.run(
      'INSERT INTO revisions (document_id, filename, version) VALUES (?, ?, ?)',
      [id, newFilename, newVersion]
    );

    // 2. Update document's updated_at
    await db.run(
      'UPDATE documents SET updated_at = CURRENT_TIMESTAMP WHERE id = ?',
      id
    );

    // Fetch full updated document with all revisions
    const updatedDoc = await db.get('SELECT * FROM documents WHERE id = ?', id);
    const revisions = await db.all(
      'SELECT * FROM revisions WHERE document_id = ? ORDER BY version DESC',
      id
    );
    const result = { ...updatedDoc, revisions };

    // Notify clients about the update
    notifyQueueUpdate(result);

    res.json(result);
  } catch (error) {
    console.error('Error revising file:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};
