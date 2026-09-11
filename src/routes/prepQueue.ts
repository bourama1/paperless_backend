import { Router } from "express";
import {
    listPrepQueue,
    listPrepQueueWorkplaces,
    listPrepQueueHardwareTypes,
    refreshPrepQueue,
} from "../controllers/prepQueueController";

const router = Router();

router.get("/", listPrepQueue);
router.get("/workplaces", listPrepQueueWorkplaces);
router.get("/hardware-types", listPrepQueueHardwareTypes);
router.post("/refresh", refreshPrepQueue);

export default router;
