import { Router } from "express";
import multer from "multer";
import { reviseFile, exportPdfa, getRevisionsByDate } from "../controllers/filesController";

const router = Router();
const upload = multer({ dest: "uploads/" });

router.get("/", getRevisionsByDate);
router.post("/:id/revise", upload.single("file"), reviseFile);
router.post("/:id/export-pdfa", exportPdfa);

export default router;
