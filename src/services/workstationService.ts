import axios from 'axios';
import { getDb } from '../config/database';

const WORKSTATIONS_API_URL =
  process.env.WORKSTATIONS_API_URL ||
  'http://10.110.60.21:40000/api/p2l/services/workstations_process';

const DOC_MANAGER_URL = process.env.DOC_MANAGER_URL || 'http://10.110.60.21:40000';

export interface WorkstationProcess {
  workstation: string;
  order: {
    _id: string;
    position: string;
    productOrder: string;
    projectNumber: string;
    salesOrder: string;
    schedule: string;
    type: string;
    __v: number;
    createdAt: string;
    customer: string;
    customerDesc: string;
    filename: string;
    maxCycle: number;
    productDesc: string;
    quantity: number;
    updatedAt: string;
    workplace: string;
  } | null;
}

export interface OrderUpdate {
  order: {
    _id: string;
    position: string;
    productOrder: string;
    projectNumber: string;
    salesOrder: string;
    schedule: string;
    type: string;
    createdAt: string;
    customer: string;
    customerDesc: string;
    filename: string;
    maxCycle: number;
    productDesc: string;
    quantity: number;
    updatedAt: string;
    workplace: string;
  };
  cycleIndex: number;
  totalCycles: number;
  _id: string;
  datetime: string;
  action: 'STARTED' | 'FINISHED';
}

export const pollWorkstations = async () => {
  try {
    const response = await axios.get<WorkstationProcess[]>(WORKSTATIONS_API_URL, {
      timeout: 10000,
    });
    const workstations = response.data;
    const db = await getDb();

    for (const ws of workstations) {
      const orderId = ws.order?._id || null;
      const orderData = ws.order ? JSON.stringify(ws.order) : null;

      const existing = await db.get(
        'SELECT id FROM workstations WHERE name = ?',
        ws.workstation,
      );

      if (existing) {
        await db.run(
          `UPDATE workstations SET current_order_id = ?, current_order_data = ?, last_polled_at = CURRENT_TIMESTAMP WHERE name = ?`,
          [orderId, orderData, ws.workstation],
        );
      } else {
        await db.run(
          `INSERT INTO workstations (name, current_order_id, current_order_data, last_polled_at) VALUES (?, ?, ?, CURRENT_TIMESTAMP)`,
          [ws.workstation, orderId, orderData],
        );
      }
    }

    const { io } = require('../index');
    if (io) {
      io.emit('workstations-updated', workstations);
    }
  } catch (error) {
    console.error('Error polling workstations:', error);
  }
};

export const handleOrderUpdate = async (update: OrderUpdate) => {
  try {
    const db = await getDb();

    await db.run(
      `INSERT INTO workstation_log (workstation_name, order_id, action, order_snapshot, cycle_index, total_cycles) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        update.order.workplace,
        update.order._id,
        update.action,
        JSON.stringify(update.order),
        update.cycleIndex,
        update.totalCycles,
      ],
    );

    if (update.action === 'FINISHED') {
      await db.run(
        `UPDATE workstations SET current_order_id = NULL, current_order_data = NULL WHERE name = ?`,
        [update.order.workplace],
      );

      handleOrderFinished(update.order).catch(err =>
        console.error('Error handling finished order:', err),
      );
    }

    const { io } = require('../index');
    if (io) {
      io.emit('workstation-order-update', update);
    }
  } catch (error) {
    console.error('Error handling order update:', error);
    throw error;
  }
};

const DOCUMENT_TYPES = {
  DECLARATION_CONFORMITY: 4,
  DECLARATION_PERFORMANCE: 5,
  PBOM_HARDWARE: 14,
  CONFIRMATION: 21,
};

async function handleOrderFinished(order: OrderUpdate['order']) {
  console.log(
    `Order ${order._id} (${order.productOrder}) finished at ${order.workplace}. Fetching documents...`,
  );

  try {
    const docsToPrint: string[] = [];

    const pbomHardwareDocs = await fetchDocumentsByType(
      order,
      DOCUMENT_TYPES.PBOM_HARDWARE,
    );
    docsToPrint.push(...pbomHardwareDocs);
    console.log(`Found ${pbomHardwareDocs.length} PBOM Hardware documents`);

    const declConformity = await fetchDocumentsByType(
      order,
      DOCUMENT_TYPES.DECLARATION_CONFORMITY,
    );
    docsToPrint.push(...declConformity);
    console.log(`Found ${declConformity.length} Declarations of Conformity`);

    const declPerformance = await fetchDocumentsByType(
      order,
      DOCUMENT_TYPES.DECLARATION_PERFORMANCE,
    );
    docsToPrint.push(...declPerformance);
    console.log(`Found ${declPerformance.length} Declarations of Performance`);

    const confirmations = await fetchDocumentsByType(
      order,
      DOCUMENT_TYPES.CONFIRMATION,
    );
    docsToPrint.push(...confirmations);
    console.log(`Found ${confirmations.length} Confirmation documents`);

    await triggerPrinting(docsToPrint, order);
  } catch (error) {
    console.error('Error in handleOrderFinished:', error);
  }
}

async function fetchDocumentsByType(
  order: OrderUpdate['order'],
  documentType: number,
): Promise<string[]> {
  try {
    const url = `${DOC_MANAGER_URL}/api/documents/fetch`;
    const response = await axios.get<{ file_path: string }[]>(url, {
      params: {
        order_code: order.salesOrder,
        position_code: order.position,
        document_type: documentType,
      },
      timeout: 10000,
    });

    if (Array.isArray(response.data)) {
      return response.data.map(d => d.file_path);
    }
    return [];
  } catch (error) {
    console.error(
      `Error fetching documents type ${documentType} for order ${order.salesOrder}/${order.position}:`,
      error,
    );
    return [];
  }
}

export interface PbomImportRequest {
  projectNumber: string;
  position: string;
  customer: string;
  productOrder?: string;
  productDesc?: string;
  documentType?: number;
}

export interface PbomSearchResult {
  customer_code: number;
  order_code: number;
  position_code: number;
}

export const importDocument = async (req: PbomImportRequest) => {
  const docType = req.documentType || DOCUMENT_TYPES.PBOM_HARDWARE;

  const fetchUrl = `${DOC_MANAGER_URL}/api/documents/fetch`;

  // Fetch headers to get the real filename from doc_manager (without downloading body)
  const headRes = await axios.get(fetchUrl, {
    params: {
      order_code: req.projectNumber,
      position_code: req.position,
      document_type: docType,
    },
    responseType: 'stream',
    timeout: 10000,
  });
  const cd = headRes.headers['content-disposition'] || '';
  const fileNameMatch = cd.match(/filename="?(.+?)"?$/);
  const originalName = fileNameMatch ? fileNameMatch[1]!.trim() : `P${req.projectNumber}_${req.position}_Hardware.pdf`;
  headRes.data.destroy();

  const docRef = `docmgr://${req.projectNumber}/${req.position}/${docType}`;

  const db = await getDb();
  const docResult = await db.run('INSERT INTO documents (name) VALUES (?)', [originalName]);
  const docId = docResult.lastID;

  await db.run(
    'INSERT INTO revisions (document_id, filename, version) VALUES (?, ?, ?)',
    [docId, docRef, 1],
  );

  const newDoc = await db.get('SELECT * FROM documents WHERE id = ?', docId);
  const revisions = await db.all(
    'SELECT * FROM revisions WHERE document_id = ? ORDER BY version DESC',
    docId,
  );

  return { ...newDoc, revisions };
};

const CUSTOMER_PRODUCTION = 0;

export const searchPbom = async (orderCode: string): Promise<PbomSearchResult[]> => {
  const results: PbomSearchResult[] = [];
  const searchStr = String(orderCode);

  try {
    const ordersRes = await axios.get<unknown>(
      `${DOC_MANAGER_URL}/api/customers/${CUSTOMER_PRODUCTION}/orders`,
      { timeout: 10000 },
    );
    const orders = Array.isArray(ordersRes.data) ? ordersRes.data : [];

    const matchingOrder = orders.find((o: unknown) => String(o).includes(searchStr));
    if (matchingOrder === undefined) return results;

    const positionsRes = await axios.get<unknown>(
      `${DOC_MANAGER_URL}/api/orders/${CUSTOMER_PRODUCTION}/${matchingOrder}/positions`,
      { timeout: 5000 },
    );
    const positions = Array.isArray(positionsRes.data) ? positionsRes.data : [];

    for (const pos of positions) {
      try {
        await axios.get(`${DOC_MANAGER_URL}/api/documents/fetch`, {
          params: {
            order_code: matchingOrder,
            position_code: pos,
            document_type: DOCUMENT_TYPES.PBOM_HARDWARE,
          },
          timeout: 5000,
        });
        results.push({
          customer_code: CUSTOMER_PRODUCTION,
          order_code: typeof matchingOrder === 'number' ? matchingOrder : Number(matchingOrder),
          position_code: typeof pos === 'number' ? pos : Number(pos),
        });
      } catch {
        // no PBOM doc for this position
      }
    }
  } catch (error) {
    console.error('Error searching PBOM:', error);
  }

  return results;
};

async function triggerPrinting(filePaths: string[], order: OrderUpdate['order']) {
  if (filePaths.length === 0) {
    console.log(`[PRINT] No documents to print for order ${order.productOrder}`);
    return;
  }

  console.log(
    `[PRINT] Would print ${filePaths.length} documents for order ${order.productOrder} (${order.salesOrder}/${order.position}):`,
  );
  for (const fp of filePaths) {
    console.log(`  - ${fp}`);
  }

  const { io } = require('../index');
  if (io) {
    io.emit('print-documents', {
      orderId: order._id,
      productOrder: order.productOrder,
      workstation: order.workplace,
      filePaths,
    });
  }
}
