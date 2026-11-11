import express from 'express';
import { authenticate, authorizeRoles } from '../../middlewares/auth.js';
import { idempotencyGuard } from '../../middlewares/idempotency.js';
import {
  claimCaseHandler,
  getDoctorFeedHandler,
  hideCaseHandler,
  releaseCaseHandler,
  updateCaseServiceHandler,
} from './doctor-feed.controller.js';

export const doctorFeedRouter = express.Router();
export const casesClaimRouter = express.Router();

// GET /api/v1/doctor/feed
doctorFeedRouter.get(
  '/feed',
  authenticate,
  authorizeRoles('DOCTOR', 'SUPERVISOR', 'ADMIN'),
  getDoctorFeedHandler
);

// POST /api/v1/cases/:caseId/claim
casesClaimRouter.post(
  '/:caseId/claim',
  authenticate,
  authorizeRoles('DOCTOR'),
  idempotencyGuard({ required: false }),
  claimCaseHandler
);

// PATCH /api/v1/cases/:caseId/service
casesClaimRouter.patch(
  '/:caseId/service',
  authenticate,
  authorizeRoles('DOCTOR', 'SUPERVISOR', 'ADMIN'),
  updateCaseServiceHandler
);

// POST /api/v1/cases/:caseId/hide
casesClaimRouter.post(
  '/:caseId/hide',
  authenticate,
  authorizeRoles('DOCTOR'),
  hideCaseHandler
);

// POST /api/v1/cases/:caseId/release
casesClaimRouter.post(
  '/:caseId/release',
  authenticate,
  authorizeRoles('DOCTOR', 'ADMIN'),
  releaseCaseHandler
);
