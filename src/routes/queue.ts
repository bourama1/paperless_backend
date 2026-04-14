import { Router } from 'express';
import { getQueue, addToQueue, updateStatus } from '../controllers/queueController';

const router = Router();

router.get('/', getQueue);
router.post('/', addToQueue);
router.patch('/:id/status', updateStatus);

export default router;
