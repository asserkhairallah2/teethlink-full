import { AppError, asyncHandler, sendSuccess } from '../../utils/errors.js';
import {
  checkInTriageBooking,
  getTriageDailyList,
  routeTriageBooking,
  triageCheckInSchema,
  triageDailyListQuerySchema,
  triageRouteSchema,
} from './triage.service.js';

/**
 * GET /api/v1/triage/daily-list
 */
export const getTriageDailyListHandler = asyncHandler(async (req, res) => {
  const validatedQuery = triageDailyListQuerySchema.parse(req.query || {});
  const data = await getTriageDailyList(validatedQuery, req.lang || 'ar');
  return sendSuccess(res, data);
});

/**
 * POST /api/v1/triage/bookings/:bookingId/check-in
 */
export const checkInTriageBookingHandler = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    throw new AppError(400, 'INVALID_BOOKING_ID', 'bookingId must be a positive integer.');
  }

  const validatedBody = triageCheckInSchema.parse(req.body || {});
  const data = await checkInTriageBooking(bookingId, req.user, validatedBody, req);
  return sendSuccess(res, data);
});

/**
 * POST /api/v1/triage/bookings/:bookingId/route
 * (Also mounted on /bookings/:bookingId/route-to-department)
 */
export const routeTriageBookingHandler = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    throw new AppError(400, 'INVALID_BOOKING_ID', 'bookingId must be a positive integer.');
  }

  if (req.user.role === 'SUPERVISOR' && req.user.isTriageExaminer === false) {
    throw new AppError(
      403,
      'NOT_TRIAGE_EXAMINER',
      'Only supervisors authorized as Initial Examination triage examiners may route triage bookings.'
    );
  }

  const validatedBody = triageRouteSchema.parse(req.body || {});
  const data = await routeTriageBooking(bookingId, req.user, validatedBody, req);
  return sendSuccess(res, data);
});
