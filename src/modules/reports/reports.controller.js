import { AppError, sendSuccess } from '../../utils/errors.js';
import {
  auditLogsQuerySchema,
  bedOccupancyQuerySchema,
  createBedAdmin,
  createClinicAdmin,
  createDepartmentAdmin,
  createMedicalConditionAdmin,
  createPeriodAdmin,
  createServiceAdmin,
  dailyInitialExamsQuerySchema,
  getBedOccupancyReport,
  getDailyInitialExamsReport,
  listAllBedsAdmin,
  listAllClinicsAdmin,
  listAllDepartmentsAdmin,
  listAllMedicalConditionsAdmin,
  listAllPeriodsAdmin,
  listAllServicesAdmin,
  listAuditLogs,
  updateBedAdmin,
  updateBedSchema,
  updateClinicAdmin,
  updateClinicSchema,
  updateDepartmentAdmin,
  updateDepartmentSchema,
  updateMedicalConditionAdmin,
  updateMedicalConditionSchema,
  updatePeriodAdmin,
  updatePeriodSchema,
  updateServiceAdmin,
  updateServiceSchema,
  upsertBedSchema,
  upsertClinicSchema,
  upsertDepartmentSchema,
  upsertMedicalConditionSchema,
  upsertPeriodSchema,
  upsertServiceSchema,
} from './reports.service.js';

/**
 * GET /api/v1/admin/reports/daily-initial-exams
 * Supports both JSON (`?format=json`) and CSV (`?format=csv`) export (§4.8).
 */
export async function getDailyInitialExamsReportHandler(req, res) {
  const parsed = dailyInitialExamsQuerySchema.parse(req.query || {});
  const result = await getDailyInitialExamsReport(parsed, req.lang || 'ar');

  if (result.isCsv) {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${result.filename}"`
    );
    return res.status(200).send(result.csvContent);
  }

  return sendSuccess(res, result.data, 200);
}

/**
 * GET /api/v1/admin/reports/bed-occupancy
 * Live bed board summary + historical bed booking log with formatted `logText` (§4.8).
 */
export async function getBedOccupancyReportHandler(req, res) {
  const parsed = bedOccupancyQuerySchema.parse(req.query || {});
  const data = await getBedOccupancyReport(parsed, req.lang || 'ar');
  return sendSuccess(res, data, 200);
}

/**
 * GET /api/v1/admin/audit-logs
 */
export async function listAuditLogsHandler(req, res) {
  const parsed = auditLogsQuerySchema.parse(req.query || {});
  const data = await listAuditLogs(parsed);
  return sendSuccess(res, data, 200);
}

// =============================================================================
// Admin CRUD Handlers (Departments, Services, Clinics, Beds, Periods, Conditions)
// =============================================================================

export async function listDepartmentsAdminHandler(_req, res) {
  const data = await listAllDepartmentsAdmin();
  return sendSuccess(res, { departments: data }, 200);
}

export async function createDepartmentAdminHandler(req, res) {
  const parsed = upsertDepartmentSchema.parse(req.body || {});
  const data = await createDepartmentAdmin(req.user, parsed, req);
  return sendSuccess(res, data, 201);
}

export async function updateDepartmentAdminHandler(req, res) {
  const departmentId = Number(req.params.departmentId);
  if (!Number.isInteger(departmentId) || departmentId <= 0) {
    throw new AppError(400, 'INVALID_DEPARTMENT_ID', 'Invalid departmentId.');
  }
  const parsed = updateDepartmentSchema.parse(req.body || {});
  const data = await updateDepartmentAdmin(departmentId, req.user, parsed, req);
  return sendSuccess(res, data, 200);
}

export async function listServicesAdminHandler(req, res) {
  const departmentId = req.query.departmentId
    ? Number(req.query.departmentId)
    : null;
  const data = await listAllServicesAdmin(departmentId);
  return sendSuccess(res, { services: data }, 200);
}

export async function createServiceAdminHandler(req, res) {
  const parsed = upsertServiceSchema.parse(req.body || {});
  const data = await createServiceAdmin(req.user, parsed, req);
  return sendSuccess(res, data, 201);
}

export async function updateServiceAdminHandler(req, res) {
  const serviceId = Number(req.params.serviceId);
  if (!Number.isInteger(serviceId) || serviceId <= 0) {
    throw new AppError(400, 'INVALID_SERVICE_ID', 'Invalid serviceId.');
  }
  const parsed = updateServiceSchema.parse(req.body || {});
  const data = await updateServiceAdmin(serviceId, req.user, parsed, req);
  return sendSuccess(res, data, 200);
}

export async function listClinicsAdminHandler(req, res) {
  const departmentId = req.query.departmentId
    ? Number(req.query.departmentId)
    : null;
  const data = await listAllClinicsAdmin(departmentId);
  return sendSuccess(res, { clinics: data }, 200);
}

export async function createClinicAdminHandler(req, res) {
  const parsed = upsertClinicSchema.parse(req.body || {});
  const data = await createClinicAdmin(req.user, parsed, req);
  return sendSuccess(res, data, 201);
}

export async function updateClinicAdminHandler(req, res) {
  const clinicId = Number(req.params.clinicId);
  if (!Number.isInteger(clinicId) || clinicId <= 0) {
    throw new AppError(400, 'INVALID_CLINIC_ID', 'Invalid clinicId.');
  }
  const parsed = updateClinicSchema.parse(req.body || {});
  const data = await updateClinicAdmin(clinicId, req.user, parsed, req);
  return sendSuccess(res, data, 200);
}

export async function listBedsAdminHandler(req, res) {
  const departmentId = req.query.departmentId
    ? Number(req.query.departmentId)
    : null;
  const clinicId = req.query.clinicId ? Number(req.query.clinicId) : null;
  const data = await listAllBedsAdmin({ departmentId, clinicId });
  return sendSuccess(res, { beds: data }, 200);
}

export async function createBedAdminHandler(req, res) {
  const parsed = upsertBedSchema.parse(req.body || {});
  const data = await createBedAdmin(req.user, parsed, req);
  return sendSuccess(res, data, 201);
}

export async function updateBedAdminHandler(req, res) {
  const bedId = Number(req.params.bedId);
  if (!Number.isInteger(bedId) || bedId <= 0) {
    throw new AppError(400, 'INVALID_BED_ID', 'Invalid bedId.');
  }
  const parsed = updateBedSchema.parse(req.body || {});
  const data = await updateBedAdmin(bedId, req.user, parsed, req);
  return sendSuccess(res, data, 200);
}

export async function listPeriodsAdminHandler(_req, res) {
  const data = await listAllPeriodsAdmin();
  return sendSuccess(res, { periods: data }, 200);
}

export async function createPeriodAdminHandler(req, res) {
  const parsed = upsertPeriodSchema.parse(req.body || {});
  const data = await createPeriodAdmin(req.user, parsed, req);
  return sendSuccess(res, data, 201);
}

export async function updatePeriodAdminHandler(req, res) {
  const periodId = Number(req.params.periodId);
  if (!Number.isInteger(periodId) || periodId <= 0) {
    throw new AppError(400, 'INVALID_PERIOD_ID', 'Invalid periodId.');
  }
  const parsed = updatePeriodSchema.parse(req.body || {});
  const data = await updatePeriodAdmin(periodId, req.user, parsed, req);
  return sendSuccess(res, data, 200);
}

export async function listMedicalConditionsAdminHandler(_req, res) {
  const data = await listAllMedicalConditionsAdmin();
  return sendSuccess(res, { medicalConditions: data }, 200);
}

export async function createMedicalConditionAdminHandler(req, res) {
  const parsed = upsertMedicalConditionSchema.parse(req.body || {});
  const data = await createMedicalConditionAdmin(req.user, parsed, req);
  return sendSuccess(res, data, 201);
}

export async function updateMedicalConditionAdminHandler(req, res) {
  const conditionId = Number(req.params.conditionId);
  if (!Number.isInteger(conditionId) || conditionId <= 0) {
    throw new AppError(400, 'INVALID_CONDITION_ID', 'Invalid conditionId.');
  }
  const parsed = updateMedicalConditionSchema.parse(req.body || {});
  const data = await updateMedicalConditionAdmin(
    conditionId,
    req.user,
    parsed,
    req
  );
  return sendSuccess(res, data, 200);
}
