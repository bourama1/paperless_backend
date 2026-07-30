import { Router } from "express";
import {
    getWorkstations,
    receiveOrderUpdate,
    getWorkstationLog,
    importPbom,
    searchPbomHandler,
    listPbomTypesHandler,
    saveEdited,
    renderDocument,
} from "../controllers/workstationController";

const router = Router();

router.get("/", getWorkstations);
router.post("/order-update", receiveOrderUpdate);
router.get("/log", getWorkstationLog);
router.post("/import-pbom", importPbom);
router.get("/search-pbom", searchPbomHandler);
router.get("/pbom-types", listPbomTypesHandler);
router.post("/save-edited", saveEdited);
router.get("/documents/:id/render", renderDocument);

export default router;
