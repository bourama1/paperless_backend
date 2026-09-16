import { Router } from "express";
import {
    listPrepQueue,
    listPrepQueueWorkplaces,
    listPrepQueueHardwareTypes,
    refreshPrepQueue,
    getPrepItems,
    checkPrepItem,
    uncheckPrepItem,
} from "../controllers/prepQueueController";

const router = Router();

router.get("/", listPrepQueue);
router.get("/workplaces", listPrepQueueWorkplaces);
router.get("/hardware-types", listPrepQueueHardwareTypes);
router.post("/refresh", refreshPrepQueue);
router.get("/items", getPrepItems);
router.post("/items/check", checkPrepItem);
router.post("/items/uncheck", uncheckPrepItem);

export default router;
