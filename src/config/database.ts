import { open, Database } from 'sqlite';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

let db: Database | null = null;

export const getDb = async () => {
  if (db) return db;

  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sqlite3 = require('sqlite3');
  const dbPath = process.env.DATABASE_URL || './data/database.sqlite';
  const dbDir = path.dirname(dbPath);
  
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  db = await open({
    filename: dbPath,
    driver: sqlite3.Database
  });

  await setupDatabase(db);
  return db;
};

const setupDatabase = async (db: Database) => {
  // 1. Create documents table (renamed from queue)
  await db.exec(`
    CREATE TABLE IF NOT EXISTS documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // 2. Create revisions table
  await db.exec(`
    CREATE TABLE IF NOT EXISTS revisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL,
      filename TEXT NOT NULL,
      version INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (document_id) REFERENCES documents(id)
    )
  `);

  // 3. Simple migration for existing 'queue' table if it exists
  try {
    const queueExists = await db.get("SELECT name FROM sqlite_master WHERE type='table' AND name='queue'");
    if (queueExists) {
      console.log('Migrating existing queue table to documents/revisions...');
      const oldItems = await db.all('SELECT * FROM queue');
      for (const item of oldItems) {
        const docResult = await db.run(
          'INSERT INTO documents (name, created_at, updated_at) VALUES (?, ?, ?)',
          [item.filename, item.created_at, item.updated_at]
        );
        await db.run(
          'INSERT INTO revisions (document_id, filename, version, created_at) VALUES (?, ?, ?, ?)',
          [docResult.lastID, item.filename, item.version, item.created_at]
        );
      }
      await db.exec('DROP TABLE queue');
      console.log('Migration complete.');
    }
  } catch (e) {
    console.error('Migration failed or already completed:', e);
  }
};
