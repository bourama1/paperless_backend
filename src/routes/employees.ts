import { Router } from "express";
import {
    getEmployees,
    createEmployee,
    getEmployeesAdmin,
    updateEmployee,
    hideEmployee,
    restoreEmployee,
} from "../controllers/completionController";
import { adminPinAuth } from "../middleware/apiKeyAuth";

const router = Router();

// Public — every "who did this" picker in the app (kiosk, prep label,
// finish order, QC check) reads the active-only list here.
router.get("/", getEmployees);

// Hidden employee-admin screen — X-API-Key (global, via apiKeyAuth) plus
// X-Admin-Pin, on every route below. Creating/renaming/hiding a name all
// live here, not on the plain "/" route above.
router.get("/admin", adminPinAuth, getEmployeesAdmin);
router.post("/admin", adminPinAuth, createEmployee);
router.put("/admin/:id", adminPinAuth, updateEmployee);
router.post("/admin/:id/hide", adminPinAuth, hideEmployee);
router.post("/admin/:id/restore", adminPinAuth, restoreEmployee);

export default router;
