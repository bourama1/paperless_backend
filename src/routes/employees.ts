import { Router } from "express";
import {
    getEmployees,
    createEmployee,
    getEmployeesAdmin,
    updateEmployee,
    hideEmployee,
    restoreEmployee,
} from "../controllers/completionController";
import {
    getQualityEngineers,
    postQualityEngineer,
    putQualityEngineer,
    hideQualityEngineer,
    restoreQualityEngineer,
} from "../controllers/qualityControlController";
import {
    getPrepBaanCodes,
    postPrepBaanCodes,
    removePrepBaanCode,
} from "../controllers/prepQueueController";
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

// Quality engineers — separate people from employees, each with their own
// QC PIN (see qualityControlService). No clash with the "/admin/:id..."
// routes above — these always have a different number of path segments.
router.get("/admin/quality-engineers", adminPinAuth, getQualityEngineers);
router.post("/admin/quality-engineers", adminPinAuth, postQualityEngineer);
router.put("/admin/quality-engineers/:id", adminPinAuth, putQualityEngineer);
router.post("/admin/quality-engineers/:id/hide", adminPinAuth, hideQualityEngineer);
router.post("/admin/quality-engineers/:id/restore", adminPinAuth, restoreQualityEngineer);

// Which BAAN codes the prep checklist shows (see ptlPlanService). A plain
// delete is fine here — it's a setting, not history anyone refers back to.
router.get("/admin/prep-baan-codes", adminPinAuth, getPrepBaanCodes);
router.post("/admin/prep-baan-codes", adminPinAuth, postPrepBaanCodes);
router.delete("/admin/prep-baan-codes/:id", adminPinAuth, removePrepBaanCode);

export default router;
