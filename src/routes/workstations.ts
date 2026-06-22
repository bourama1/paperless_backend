import { Router } from 'express';
import {
  getWorkstations,
  receiveOrderUpdate,
  getWorkstationLog,
  importPbom,
  searchPbomHandler,
  openEditor,
  editorDone,
  renderDocument,
} from '../controllers/workstationController';

const router = Router();

router.get('/', getWorkstations);
router.post('/order-update', receiveOrderUpdate);
router.get('/log', getWorkstationLog);
router.post('/import-pbom', importPbom);
router.get('/search-pbom', searchPbomHandler);
router.post('/open-editor', openEditor);
router.get('/editor-done', editorDone);
router.get('/documents/:id/render', renderDocument);

export default router;
