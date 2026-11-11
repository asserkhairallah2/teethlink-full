import { AppError, asyncHandler, sendSuccess } from '../../utils/errors.js';
import {
  claimCaseBodySchema,
  claimCaseFromFeed,
  doctorFeedQuerySchema,
  getDoctorWaitingFeed,
  hideCaseFromDoctorFeed,
  releaseCaseSchema,
  releaseClaimedCase,
  updateCaseServiceSchema,
  updateCaseSubService,
} from './doctor-feed.service.js';

/**
 * GET /api/v1/doctor/feed
 */
export const getDoctorFeedHandler = asyncHandler(async (req, res) => {
  const validatedQuery = doctorFeedQuerySchema.parse(req.query || {});
  const data = await getDoctorWaitingFeed(req.user, validatedQuery, req.lang || 'ar');
  return sendSuccess(res, data);
});

/**
 * POST /api/v1/cases/:caseId/claim
 */
export const claimCaseHandler = asyncHandler(async (req, res) => {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'caseId must be a positive integer.');
  }

  const validatedBody = claimCaseBodySchema.parse(req.body || {});
  const data = await claimCaseFromFeed(caseId, req.user.userId, validatedBody, req);
  return sendSuccess(res, data);
});

/**
 * PATCH /api/v1/cases/:caseId/service
 */
export const updateCaseServiceHandler = asyncHandler(async (req, res) => {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'caseId must be a positive integer.');
  }

  const validatedBody = updateCaseServiceSchema.parse(req.body || {});
  const data = await updateCaseSubService(caseId, req.user, validatedBody, req);
  return sendSuccess(res, data);
});

/**
 * POST /api/v1/cases/:caseId/hide
 */
export const hideCaseHandler = asyncHandler(async (req, res) => {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'caseId must be a positive integer.');
  }

  const data = await hideCaseFromDoctorFeed(caseId, req.user.userId);
  return sendSuccess(res, data);
});

/**
 * POST /api/v1/cases/:caseId/release
 */
export const releaseCaseHandler = asyncHandler(async (req, res) => {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'caseId must be a positive integer.');
  }

  const validatedBody = releaseCaseSchema.parse(req.body || {});
  const data = await releaseClaimedCase(caseId, req.user, validatedBody, req);
  return sendSuccess(res, data);
});
