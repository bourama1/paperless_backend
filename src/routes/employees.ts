import { Router } from "express";
import { getEmployees, createEmployee } from "../controllers/completionController";

const router = Router();

router.get("/", getEmployees);
router.post("/", createEmployee);

export default router;
