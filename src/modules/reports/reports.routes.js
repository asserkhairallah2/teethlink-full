import { Router } from 'express';
import { asyncHandler } from '../../utils/errors.js';
import { authenticate, authorizeRoles } from '../../middlewares/auth.js';
import {
  createBedAdminHandler,
  createClinicAdminHandler,
  createDepartmentAdminHandler,
  createMedicalConditionAdminHandler,
  createPeriodAdminHandler,
  createServiceAdminHandler,
  getBedOccupancyReportHandler,
  getDailyInitialExamsReportHandler,
  listAuditLogsHandler,
  listBedsAdminHandler,
  listClinicsAdminHandler,
  listDepartmentsAdminHandler,
  listMedicalConditionsAdminHandler,
  listPeriodsAdminHandler,
  listServicesAdminHandler,
  updateBedAdminHandler,
  updateClinicAdminHandler,
  updateDepartmentAdminHandler,
  updateMedicalConditionAdminHandler,
  updatePeriodAdminHandler,
  updateServiceAdminHandler,
} from './reports.controller.js';

/**
 * Admin Reports & Catalog CRUD Router — mounted at `/api/v1/admin`
 */
export const adminReportsRouter = Router();

// 1. Reports (§4.8)
adminReportsRouter.get(
  '/reports/daily-initial-exams',
  authenticate,
  authorizeRoles('ADMIN', 'SUPERVISOR'),
  asyncHandler(getDailyInitialExamsReportHandler)
);

adminReportsRouter.get(
  '/reports/bed-occupancy',
  authenticate,
  authorizeRoles('ADMIN', 'SUPERVISOR'),
  asyncHandler(getBedOccupancyReportHandler)
);

// 2. Audit Logs (§4.8)
adminReportsRouter.get(
  '/audit-logs',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(listAuditLogsHandler)
);

// 3. Departments CRUD
adminReportsRouter.get(
  '/departments',
  authenticate,
  authorizeRoles('ADMIN', 'SUPERVISOR'),
  asyncHandler(listDepartmentsAdminHandler)
);
adminReportsRouter.post(
  '/departments',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(createDepartmentAdminHandler)
);
adminReportsRouter.patch(
  '/departments/:departmentId',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(updateDepartmentAdminHandler)
);

// 4. Services CRUD
adminReportsRouter.get(
  '/services',
  authenticate,
  authorizeRoles('ADMIN', 'SUPERVISOR'),
  asyncHandler(listServicesAdminHandler)
);
adminReportsRouter.post(
  '/services',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(createServiceAdminHandler)
);
adminReportsRouter.patch(
  '/services/:serviceId',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(updateServiceAdminHandler)
);

// 5. Clinics CRUD
adminReportsRouter.get(
  '/clinics',
  authenticate,
  authorizeRoles('ADMIN', 'SUPERVISOR'),
  asyncHandler(listClinicsAdminHandler)
);
adminReportsRouter.post(
  '/clinics',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(createClinicAdminHandler)
);
adminReportsRouter.patch(
  '/clinics/:clinicId',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(updateClinicAdminHandler)
);

// 6. Clinic Beds CRUD
adminReportsRouter.get(
  '/beds',
  authenticate,
  authorizeRoles('ADMIN', 'SUPERVISOR'),
  asyncHandler(listBedsAdminHandler)
);
adminReportsRouter.post(
  '/beds',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(createBedAdminHandler)
);
adminReportsRouter.patch(
  '/beds/:bedId',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(updateBedAdminHandler)
);

// 7. Bed Ticket Periods CRUD (available at both /bed-ticket-periods and /periods)
adminReportsRouter.get(
  '/bed-ticket-periods',
  authenticate,
  authorizeRoles('ADMIN', 'SUPERVISOR', 'DOCTOR'),
  asyncHandler(listPeriodsAdminHandler)
);
adminReportsRouter.post(
  '/bed-ticket-periods',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(createPeriodAdminHandler)
);
adminReportsRouter.patch(
  '/bed-ticket-periods/:periodId',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(updatePeriodAdminHandler)
);

adminReportsRouter.get(
  '/periods',
  authenticate,
  authorizeRoles('ADMIN', 'SUPERVISOR', 'DOCTOR'),
  asyncHandler(listPeriodsAdminHandler)
);
adminReportsRouter.post(
  '/periods',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(createPeriodAdminHandler)
);
adminReportsRouter.patch(
  '/periods/:periodId',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(updatePeriodAdminHandler)
);

// 8. Medical Conditions CRUD
adminReportsRouter.get(
  '/medical-conditions',
  authenticate,
  authorizeRoles('ADMIN', 'SUPERVISOR'),
  asyncHandler(listMedicalConditionsAdminHandler)
);
adminReportsRouter.post(
  '/medical-conditions',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(createMedicalConditionAdminHandler)
);
adminReportsRouter.patch(
  '/medical-conditions/:conditionId',
  authenticate,
  authorizeRoles('ADMIN'),
  asyncHandler(updateMedicalConditionAdminHandler)
);

export default adminReportsRouter;
