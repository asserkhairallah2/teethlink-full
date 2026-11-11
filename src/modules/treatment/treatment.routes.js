import { Router } from 'express';
import { asyncHandler } from '../../utils/errors.js';
import { authenticate, authorizeRoles } from '../../middlewares/auth.js';
import { idempotencyGuard } from '../../middlewares/idempotency.js';
import { multerUpload } from '../files/files.service.js';
import {
  getMyDoctorCasesHandler,
  getMyPatientCasesHandler,
  listPortfolioPostsHandler,
  publishPortfolioPostHandler,
  reviewCompletionReportHandler,
  submitCaseOutcomeHandler,
  submitCaseRatingHandler,
  uploadCasePhotoHandler,
} from './treatment.controller.js';

/**
 * Case Treatment Router — mounted at `/api/v1/cases`
 */
export const caseTreatmentRouter = Router();

// POST /api/v1/cases/:caseId/outcome
caseTreatmentRouter.post(
  '/:caseId/outcome',
  authenticate,
  authorizeRoles('DOCTOR'),
  idempotencyGuard,
  asyncHandler(submitCaseOutcomeHandler)
);

// POST /api/v1/cases/:caseId/photos
caseTreatmentRouter.post(
  '/:caseId/photos',
  authenticate,
  authorizeRoles('DOCTOR', 'SUPERVISOR', 'ADMIN'),
  multerUpload.fields([
    { name: 'file', maxCount: 1 },
    { name: 'photo', maxCount: 1 },
  ]),
  asyncHandler(uploadCasePhotoHandler)
);

// POST /api/v1/cases/:caseId/rating
caseTreatmentRouter.post(
  '/:caseId/rating',
  authenticate,
  authorizeRoles('PATIENT'),
  idempotencyGuard,
  asyncHandler(submitCaseRatingHandler)
);

// POST /api/v1/cases/:caseId/report/review
caseTreatmentRouter.post(
  '/:caseId/report/review',
  authenticate,
  authorizeRoles('SUPERVISOR', 'ADMIN'),
  asyncHandler(reviewCompletionReportHandler)
);

/**
 * Doctor Treatment & Portfolio Router — mounted at `/api/v1/doctor`
 */
export const doctorTreatmentRouter = Router();

// POST /api/v1/doctor/posts
doctorTreatmentRouter.post(
  '/posts',
  authenticate,
  authorizeRoles('DOCTOR'),
  idempotencyGuard,
  asyncHandler(publishPortfolioPostHandler)
);

// GET /api/v1/doctor/posts
doctorTreatmentRouter.get(
  '/posts',
  authenticate,
  authorizeRoles('DOCTOR', 'SUPERVISOR', 'ADMIN', 'PATIENT'),
  asyncHandler(listPortfolioPostsHandler)
);

// GET /api/v1/doctor/me/cases
doctorTreatmentRouter.get(
  '/me/cases',
  authenticate,
  authorizeRoles('DOCTOR'),
  asyncHandler(getMyDoctorCasesHandler)
);

/**
 * Patient Case History Router — mounted at `/api/v1/patients`
 */
export const patientCasesHistoryRouter = Router();

// GET /api/v1/patients/me/cases
patientCasesHistoryRouter.get(
  '/me/cases',
  authenticate,
  authorizeRoles('PATIENT'),
  asyncHandler(getMyPatientCasesHandler)
);

export default {
  caseTreatmentRouter,
  doctorTreatmentRouter,
  patientCasesHistoryRouter,
};
