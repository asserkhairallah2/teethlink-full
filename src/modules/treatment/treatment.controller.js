import { AppError, sendSuccess } from '../../utils/errors.js';
import {
  caseHistoryQuerySchema,
  createPortfolioPostSchema,
  getDoctorCaseHistory,
  getPatientCaseHistory,
  listDoctorPortfolioPosts,
  publishDoctorPortfolioPost,
  reviewCaseCompletionReport,
  reviewCompletionReportSchema,
  submitCaseOutcomeSchema,
  submitCaseRating,
  submitCaseRatingSchema,
  submitCaseSessionOutcome,
  uploadCasePhoto,
  uploadCasePhotoSchema,
} from './treatment.service.js';

/**
 * POST /api/v1/cases/:caseId/outcome
 * Submits session outcome (`NEEDS_FOLLOW_UP` or `FINISHED`) with optional immediate `nextAppointment`
 * or `completionReport` (§4.6).
 */
export async function submitCaseOutcomeHandler(req, res) {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'Invalid caseId parameter.');
  }

  const parsed = submitCaseOutcomeSchema.parse(req.body || {});
  const data = await submitCaseSessionOutcome(
    caseId,
    req.user.userId,
    parsed,
    req
  );
  return sendSuccess(res, data, 200);
}

/**
 * POST /api/v1/cases/:caseId/photos
 * Uploads a `BEFORE`, `AFTER`, `DURING`, `XRAY`, or `TRIAGE` photo for a case (§4.6).
 */
export async function uploadCasePhotoHandler(req, res) {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'Invalid caseId parameter.');
  }

  let bodyInput = req.body || {};
  if (typeof bodyInput.payload === 'string') {
    try {
      bodyInput = { ...bodyInput, ...JSON.parse(bodyInput.payload) };
    } catch {
      throw new AppError(400, 'INVALID_JSON_PAYLOAD', 'Malformed JSON in payload field.');
    }
  }

  const parsed = uploadCasePhotoSchema.parse(bodyInput);
  const uploadedFile =
    req.file ||
    (req.files?.file && req.files.file[0]) ||
    (req.files?.photo && req.files.photo[0]) ||
    undefined;

  const data = await uploadCasePhoto(
    caseId,
    req.user,
    parsed,
    uploadedFile,
    req
  );
  return sendSuccess(res, data, 201);
}

/**
 * POST /api/v1/doctor/posts
 * Publishes or updates a doctor portfolio post mentioning a `FINISHED` case (§4.6).
 */
export async function publishPortfolioPostHandler(req, res) {
  const parsed = createPortfolioPostSchema.parse(req.body || {});
  const data = await publishDoctorPortfolioPost(req.user.userId, parsed, req);
  return sendSuccess(res, data, 201);
}

/**
 * GET /api/v1/doctor/posts
 * Lists portfolio posts for a doctor (defaults to the authenticated doctor, or `?doctorId=...`).
 */
export async function listPortfolioPostsHandler(req, res) {
  const targetDoctorId = req.query.doctorId
    ? Number(req.query.doctorId)
    : Number(req.user.userId);

  if (!Number.isInteger(targetDoctorId) || targetDoctorId <= 0) {
    throw new AppError(400, 'INVALID_DOCTOR_ID', 'Invalid doctorId parameter.');
  }

  const data = await listDoctorPortfolioPosts(targetDoctorId, req.user);
  return sendSuccess(res, data, 200);
}

/**
 * POST /api/v1/cases/:caseId/rating
 * Patient rates a `FINISHED` case (§4.6).
 */
export async function submitCaseRatingHandler(req, res) {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'Invalid caseId parameter.');
  }

  const parsed = submitCaseRatingSchema.parse(req.body || {});
  const data = await submitCaseRating(caseId, req.user.userId, parsed, req);
  return sendSuccess(res, data, 201);
}

/**
 * GET /api/v1/patients/me/cases
 * Returns full active and historical case & session history for the authenticated patient (§4.6).
 */
export async function getMyPatientCasesHandler(req, res) {
  const parsedQuery = caseHistoryQuerySchema.parse(req.query || {});
  const data = await getPatientCaseHistory(
    req.user.userId,
    parsedQuery,
    req.lang || 'ar'
  );
  return sendSuccess(res, data, 200);
}

/**
 * GET /api/v1/doctor/me/cases
 * Returns full active and completed case & session history for the authenticated doctor (§4.6).
 */
export async function getMyDoctorCasesHandler(req, res) {
  const parsedQuery = caseHistoryQuerySchema.parse(req.query || {});
  const data = await getDoctorCaseHistory(
    req.user.userId,
    parsedQuery,
    req.lang || 'ar'
  );
  return sendSuccess(res, data, 200);
}

/**
 * POST /api/v1/cases/:caseId/report/review
 * Supervisor or Admin approves or requests revision on a completion report (§4.6).
 */
export async function reviewCompletionReportHandler(req, res) {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'Invalid caseId parameter.');
  }

  const parsed = reviewCompletionReportSchema.parse(req.body || {});
  const data = await reviewCaseCompletionReport(caseId, req.user, parsed, req);
  return sendSuccess(res, data, 200);
}
