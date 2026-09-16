import { Router } from "express";
import { getPrintingSetting, updatePrintingSetting } from "../controllers/settingsController";

const router = Router();

router.get("/printing", getPrintingSetting);
router.post("/printing", updatePrintingSetting);

export default router;
