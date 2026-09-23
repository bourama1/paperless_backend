import { Router } from "express";
import {
    getWorkstations,
    listWorkplaces,
    receiveOrderUpdate,
    getWorkstationLog,
    importPbom,
    searchPbomHandler,
    resolveScanHandler,
    listPbomTypesHandler,
    saveEdited,
    renderDocument,
} from "../controllers/workstationController";
import {
    createOrderCompletion,
    getCompletionQueueHandler,
    createPrepLabel,
    createOrderCheck,
    getStatsHandler,
} from "../controllers/completionController";
import { verifyQcPin, createOrderQcCheck } from "../controllers/qualityControlController";

const router = Router();

router.get("/", getWorkstations);
router.get("/workplaces", listWorkplaces);
router.post("/order-update", receiveOrderUpdate);
router.get("/log", getWorkstationLog);
router.post("/import-pbom", importPbom);
router.get("/search-pbom", searchPbomHandler);
router.get("/resolve-scan", resolveScanHandler);
router.get("/pbom-types", listPbomTypesHandler);
router.post("/order-completion", createOrderCompletion);
router.get("/completion-queue", getCompletionQueueHandler);
router.get("/stats", getStatsHandler);
router.post("/print-prep-label", createPrepLabel);
router.post("/order-check", createOrderCheck);
// Quality-control sign-off — the engineer's PIN travels in X-QC-Pin.
router.post("/qc-check/verify", verifyQcPin);
router.post("/order-qc-check", createOrderQcCheck);
router.post("/save-edited", saveEdited);
router.get("/documents/:id/render", renderDocument);

export default router;
