import { Request, Response } from 'express';
import { getDb } from '../config/database';
import { handleOrderUpdate, OrderUpdate, importDocument, searchPbom } from '../services/workstationService';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import FormData from 'form-data';
import axios from 'axios';
import { Readable } from 'stream';

const EDITOR_URL = process.env.EDITOR_URL || 'http://tocz-app4:3000';
const BACKEND_URL = process.env.BACKEND_URL || `http://localhost:${process.env.PORT || 3000}`;
const DOC_MANAGER_URL = process.env.DOC_MANAGER_URL || 'http://tocz-app4:5200';
const EDITED_PDF_PATH = process.env.EDITED_PDF_PATH || '';
const STORAGE_PATH = process.env.STORAGE_PATH || './storage';

const editorSessions = new Map<string, { sessionId: string; documentId: number }>();

// ── helpers ─────────────────────────────────────────────────────────────────

function parseDocmgrRef(ref: string) {
  // docmgr://{order_code}/{position_code}/{docType}
  const m = ref.match(/^docmgr:\/\/([^/]+)\/([^/]+)\/(\d+)$/);
  if (!m) return null;
  return { orderCode: m[1] as string, positionCode: m[2] as string, docType: parseInt(m[3] as string, 10) };
}

async function resolveDocumentStream(documentId: number): Promise<{ stream: Readable; filename: string } | null> {
  const db = await getDb();
  const doc = await db.get('SELECT * FROM documents WHERE id = ?', documentId);
  if (!doc) return null;

  const latestRev = await db.get(
    'SELECT filename, version FROM revisions WHERE document_id = ? ORDER BY version DESC LIMIT 1',
    documentId,
  );
  if (!latestRev) return null;

  const ref = latestRev.filename;

  // docmgr:// reference → fetch from doc_manager
  const parsed = parseDocmgrRef(ref);
  if (parsed) {
    const url = `${DOC_MANAGER_URL}/api/documents/fetch`;
    const response = await axios.get(url, {
      params: {
        order_code: parsed.orderCode,
        position_code: parsed.positionCode,
        document_type: parsed.docType,
      },
      responseType: 'stream',
      timeout: 30000,
    });
    return { stream: response.data, filename: `PBOM_Hardware_${parsed.orderCode}_${parsed.positionCode}.pdf` };
  }

  // Legacy local file reference (imported before switch to docmgr://)
  const localPath = path.join(STORAGE_PATH, ref);
  if (fs.existsSync(localPath)) {
    return { stream: fs.createReadStream(localPath), filename: ref };
  }

  return null;
}

// ── exports ──────────────────────────────────────────────────────────────────

export const getWorkstations = async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const workstations = await db.all('SELECT * FROM workstations ORDER BY name');

    const result = workstations.map(ws => ({
      ...ws,
      current_order_data: ws.current_order_data
        ? JSON.parse(ws.current_order_data)
        : null,
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching workstations:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const receiveOrderUpdate = async (req: Request, res: Response) => {
  const update = req.body as OrderUpdate;

  if (!update || !update.order || !update.action) {
    return res.status(400).json({ error: 'Invalid payload: order and action are required' });
  }

  if (!['STARTED', 'FINISHED'].includes(update.action)) {
    return res.status(400).json({ error: 'Invalid action. Must be STARTED or FINISHED' });
  }

  try {
    await handleOrderUpdate(update);
    res.json({ status: 'ok' });
  } catch (error) {
    console.error('Error processing order update:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const importPbom = async (req: Request, res: Response) => {
  const { salesOrder, position, customer, productOrder, productDesc, documentType } = req.body;

  if (!salesOrder || !position || !customer) {
    return res.status(400).json({ error: 'salesOrder, position, and customer are required' });
  }

  try {
    const doc = await importDocument({ salesOrder, position, customer, productOrder, productDesc, documentType });
    res.json(doc);
  } catch (error: any) {
    console.error('Error importing PBOM:', error);
    const message = error?.response?.data?.error || error.message || 'Internal server error';
    res.status(500).json({ error: message });
  }
};

export const searchPbomHandler = async (req: Request, res: Response) => {
  const { order_code } = req.query;

  if (!order_code) {
    return res.status(400).json({ error: 'order_code query parameter is required' });
  }

  try {
    const results = await searchPbom(order_code as string);
    res.json(results);
  } catch (error) {
    console.error('Error searching PBOM:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getWorkstationLog = async (req: Request, res: Response) => {
  try {
    const db = await getDb();
    const { workstation, limit } = req.query;

    let query = 'SELECT * FROM workstation_log';
    const params: string[] = [];

    if (workstation) {
      query += ' WHERE workstation_name = ?';
      params.push(workstation as string);
    }

    query += ' ORDER BY created_at DESC';

    if (limit) {
      query += ' LIMIT ?';
      params.push(limit as string);
    }

    const logs = await db.all(query, params);

    const result = logs.map(log => ({
      ...log,
      order_snapshot: log.order_snapshot ? JSON.parse(log.order_snapshot) : null,
    }));

    res.json(result);
  } catch (error) {
    console.error('Error fetching workstation log:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const renderDocument = async (req: Request, res: Response) => {
  const { id } = req.params;

  try {
    const result = await resolveDocumentStream(Number(id));
    if (!result) {
      return res.status(404).json({ error: 'Document not found' });
    }

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${result.filename}"`);
    result.stream.pipe(res);
  } catch (error) {
    console.error('Error rendering document:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const openEditor = async (req: Request, res: Response) => {
  const { documentId, filename } = req.body;

  if (!documentId) {
    return res.status(400).json({ error: 'documentId is required' });
  }

  try {
    let filePath: string | null = null;
    let uploadFilename: string;

    if (filename && !filename.startsWith('docmgr://')) {
      // Direct file reference (for backwards compatibility)
      filePath = path.join(STORAGE_PATH, filename);
      if (!fs.existsSync(filePath)) {
        // Also try network share
        filePath = EDITED_PDF_PATH ? path.join(EDITED_PDF_PATH, filename) : '';
        if (!filePath || !fs.existsSync(filePath)) {
          return res.status(404).json({ error: 'File not found' });
        }
      }
      uploadFilename = path.basename(filename);
    } else {
      // Resolve from documentId
      const result = await resolveDocumentStream(documentId);
      if (!result) {
        return res.status(404).json({ error: 'Document not found' });
      }

      // Write to temp file for upload
      const tmpDir = path.join(STORAGE_PATH, '.tmp');
      if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
      filePath = path.join(tmpDir, `editor_${documentId}_${Date.now()}.pdf`);

      const writer = fs.createWriteStream(filePath);
      await new Promise<void>((resolve, reject) => {
        result.stream.pipe(writer);
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      uploadFilename = result.filename;
    }

    const token = crypto.randomUUID();
    const returnUrl = `${BACKEND_URL}/workstations/editor-done?token=${token}`;

    const form = new FormData();
    form.append('file', fs.createReadStream(filePath), uploadFilename);
    form.append('returnUrl', returnUrl);

    const response = await axios.post(`${EDITOR_URL}/upload`, form, {
      headers: form.getHeaders(),
      timeout: 30000,
    });

    const { id: sessionId, editUrl } = response.data;
    editorSessions.set(token, { sessionId, documentId });

    setTimeout(() => editorSessions.delete(token), 24 * 60 * 60 * 1000);

    // Clean up temp file
    try { fs.unlinkSync(filePath); } catch { /* ignore */ }

    res.json({ editUrl });
  } catch (error: unknown) {
    console.error('Error opening editor:', error);
    const axiosErr = error as { response?: { data?: { error?: string } }; message?: string };
    const msg = axiosErr?.response?.data?.error || axiosErr?.message || 'Failed to open editor';
    res.status(500).json({ error: msg });
  }
};

export const editorDone = async (req: Request, res: Response) => {
  const { token } = req.query;

  if (!token || typeof token !== 'string') {
    return res.status(400).type('html').send('<html><body>Missing token</body></html>');
  }

  const session = editorSessions.get(token);
  if (!session) {
    return res.status(404).type('html').send('<html><body>Session expired or not found</body></html>');
  }

  const { sessionId, documentId } = session;

  try {
    const pdfResponse = await axios.get(`${EDITOR_URL}/sessions/${sessionId}/pdf`, {
      responseType: 'arraybuffer',
      timeout: 30000,
    });

    const db = await getDb();
    const doc = await db.get('SELECT * FROM documents WHERE id = ?', documentId);

    if (!doc) {
      return res.status(404).type('html').send('<html><body>Document not found</body></html>');
    }

    const latestRev = await db.get(
      'SELECT version, filename FROM revisions WHERE document_id = ? ORDER BY version DESC LIMIT 1',
      documentId,
    );

    const newVersion = (latestRev?.version || 0) + 1;

    // Count edits (revisions that are not docmgr:// references)
    const editCountResult = await db.get(
      'SELECT COUNT(*) as count FROM revisions WHERE document_id = ? AND filename NOT LIKE ?',
      [documentId, 'docmgr://%'],
    );
    const editRev = (editCountResult?.count || 0) + 1;

    // Use original filename from doc_manager; if the filename already has a
    // _RevX suffix (from the source system), replace the number instead of
    // appending another _RevX.  When the source already has a Rev number we
    // take the max so we never go backwards (e.g. source Rev2 → edit Rev1).
    const originalName = doc.name;
    const ext = path.extname(originalName);
    let base = path.basename(originalName, ext);
    const revMatch = base.match(/^(.*)_Rev(\d+)$/i);
    const sourceRev = revMatch ? parseInt(revMatch[2]!, 10) : 0;
    const revNumber = Math.max(editRev, sourceRev + 1);
    const newFilename = revMatch
        ? `${revMatch[1]}_Rev${revNumber}${ext}`
        : `${base}_Rev${revNumber}${ext}`;

    // Save to network share
    if (EDITED_PDF_PATH) {
      const shareDir = EDITED_PDF_PATH;
      if (!fs.existsSync(shareDir)) {
        fs.mkdirSync(shareDir, { recursive: true });
      }
      fs.writeFileSync(path.join(shareDir, newFilename), Buffer.from(pdfResponse.data));
      console.log(`Saved edited PDF to ${path.join(shareDir, newFilename)}`);
    }

    await db.run(
      'INSERT INTO revisions (document_id, filename, version) VALUES (?, ?, ?)',
      [documentId, newFilename, newVersion],
    );

    await db.run('UPDATE documents SET updated_at = CURRENT_TIMESTAMP WHERE id = ?', documentId);

    editorSessions.delete(token);

    res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>Saved</title></head>
<body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:-apple-system,Helvetica,sans-serif;background:#f5f5f5;">
  <div style="text-align:center;padding:2rem;">
    <div style="font-size:48px;margin-bottom:1rem;">&#10003;</div>
    <h2 style="margin:0;color:#333;">Changes Saved</h2>
    <p style="color:#666;margin-top:0.5rem;">This tab will close automatically.</p>
  </div>
  <script>
    if (window.opener && window.opener !== window) {
      window.opener.postMessage({ type: 'SAVED' }, '*');
    }
    if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) {
      window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'SAVED' }));
    }
    setTimeout(function () { window.close(); }, 2000);
  </script>
</body>
</html>`);
  } catch (error) {
    console.error('Error in editor callback:', error);
    res.status(500).type('html').send('<html><body>Save failed</body></html>');
  }
};
