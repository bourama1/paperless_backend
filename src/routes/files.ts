import { Router } from "express";
import { getDocumentsOverview, getDocumentById, exportPdfa } from "../controllers/filesController";

const router = Router();

router.get("/", getDocumentsOverview);
router.get("/:id", getDocumentById);
router.post("/:id/export-pdfa", exportPdfa);

export default router;
