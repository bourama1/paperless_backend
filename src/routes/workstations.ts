import { Router } from "express";
import {
    getWorkstations,
    listWorkplaces,
    receiveOrderUpdate,
    getWorkstationLog,
    importPbom,
    searchPbomHandler,
    listPbomTypesHandler,
    saveEdited,
    renderDocument,
} from "../controllers/workstationController";
import {
    createOrderCompletion,
    createPrepLabel,
    createOrderCheck,
} from "../controllers/completionController";

const router = Router();

router.get("/", getWorkstations);
router.get("/workplaces", listWorkplaces);
router.post("/order-update", receiveOrderUpdate);
router.get("/log", getWorkstationLog);
router.post("/import-pbom", importPbom);
router.get("/search-pbom", searchPbomHandler);
router.get("/pbom-types", listPbomTypesHandler);
router.post("/order-completion", createOrderCompletion);
router.post("/print-prep-label", createPrepLabel);
router.post("/order-check", createOrderCheck);
router.post("/save-edited", saveEdited);
router.get("/documents/:id/render", renderDocument);

export default router;
