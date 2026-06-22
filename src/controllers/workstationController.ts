import { Request, Response } from 'express';
import { getDb } from '../config/database';
import { handleOrderUpdate, OrderUpdate, importDocument, searchPbom } from '../services/workstationService';

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
