import { Request, Response } from 'express';
import { getDb } from '../config/database';
import { notifyNewItem, notifyQueueUpdate } from '../services/notificationService';

export const getQueue = async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const documents = await db.all('SELECT * FROM documents ORDER BY updated_at DESC');
    
    // Fetch revisions for each document
    const result = await Promise.all(documents.map(async (doc) => {
      const revisions = await db.all(
        'SELECT * FROM revisions WHERE document_id = ? ORDER BY version DESC',
        doc.id
      );
      return { ...doc, revisions };
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching documents:', error);
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
    // Create the document
    const docResult = await db.run(
      'INSERT INTO documents (name) VALUES (?)',
      [filename]
    );
    const docId = docResult.lastID;

    // Create the first revision
    await db.run(
      'INSERT INTO revisions (document_id, filename, version) VALUES (?, ?, ?)',
      [docId, filename, 1]
    );

    const newDoc = await db.get('SELECT * FROM documents WHERE id = ?', docId);
    const revisions = await db.all('SELECT * FROM revisions WHERE document_id = ?', docId);
    const fullDoc = { ...newDoc, revisions };
    
    notifyNewItem(fullDoc);
    res.status(201).json(fullDoc);
  } catch (error) {
    console.error('Error adding document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateStatus = async (req: Request, res: Response) => {
  // We can keep this for compatibility or remove it since 'status' is gone from 'documents' table
  res.status(410).json({ error: 'Status updates are no longer supported. Use revisions instead.' });
};
