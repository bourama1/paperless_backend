import { Router } from "express";
import {
    listPrepQueue,
    listPrepQueueWorkplaces,
    refreshPrepQueue,
} from "../controllers/prepQueueController";

const router = Router();

router.get("/", listPrepQueue);
router.get("/workplaces", listPrepQueueWorkplaces);
router.post("/refresh", refreshPrepQueue);

export default router;
