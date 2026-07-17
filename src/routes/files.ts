import { Router } from "express";
import { getRevisionsByDate, exportPdfa } from "../controllers/filesController";

const router = Router();

router.get("/", getRevisionsByDate);
router.post("/:id/export-pdfa", exportPdfa);

export default router;
