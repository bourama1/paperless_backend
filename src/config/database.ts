import { open, Database } from 'sqlite';
import path from 'path';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

let db: Database | null = null;

export const getDb = async () => {
  if (db) return db;

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
  await db.exec(`
    CREATE TABLE IF NOT EXISTS queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      status TEXT DEFAULT 'pending', -- pending, in-progress, completed
      version INTEGER DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
};
