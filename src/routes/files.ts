import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { reviseFile } from '../controllers/filesController';

const router = Router();
const upload = multer({ dest: 'uploads/' });

router.post('/:id/revise', upload.single('file'), reviseFile);

export default router;
