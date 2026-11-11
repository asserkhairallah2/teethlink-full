import { AppError, asyncHandler, sendSuccess } from '../../utils/errors.js';
import {
  availabilityQuerySchema,
  bookInitialExamSlot,
  cancelExamBookingSchema,
  cancelInitialExamBooking,
  createCalendarExceptionSchema,
  createExamBookingSchema,
  generateExamSlotsForAdmin,
  generateExamSlotsSchema,
  getExamSlotsAvailability,
  rescheduleExamBookingSchema,
  rescheduleInitialExamBooking,
  upsertCalendarException,
  upsertExamScheduleTemplates,
  upsertScheduleTemplatesSchema,
} from './exam-scheduling.service.js';

/**
 * GET /api/v1/exam-slots/availability
 */
export const getExamSlotsAvailabilityHandler = asyncHandler(async (req, res) => {
  const validatedQuery = availabilityQuerySchema.parse(req.query || {});
  const data = await getExamSlotsAvailability(validatedQuery, req.user);
  return sendSuccess(res, data);
});

/**
 * POST /api/v1/exam-bookings
 */
export const createExamBookingHandler = asyncHandler(async (req, res) => {
  const validatedBody = createExamBookingSchema.parse(req.body || {});
  const data = await bookInitialExamSlot(req.user.userId, validatedBody, req);
  return sendSuccess(res, data, 201);
});

/**
 * POST /api/v1/exam-bookings/:bookingId/cancel
 */
export const cancelExamBookingHandler = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    throw new AppError(400, 'INVALID_BOOKING_ID', 'bookingId must be a positive integer.');
  }

  const validatedBody = cancelExamBookingSchema.parse(req.body || {});
  const data = await cancelInitialExamBooking(bookingId, req.user, validatedBody, req);
  return sendSuccess(res, data);
});

/**
 * POST /api/v1/exam-bookings/:bookingId/reschedule
 */
export const rescheduleExamBookingHandler = asyncHandler(async (req, res) => {
  const bookingId = Number(req.params.bookingId);
  if (!Number.isInteger(bookingId) || bookingId <= 0) {
    throw new AppError(400, 'INVALID_BOOKING_ID', 'bookingId must be a positive integer.');
  }

  const validatedBody = rescheduleExamBookingSchema.parse(req.body || {});
  const data = await rescheduleInitialExamBooking(bookingId, req.user, validatedBody, req);
  return sendSuccess(res, data);
});

/**
 * PUT /api/v1/admin/exam-schedule-templates
 */
export const upsertExamScheduleTemplatesHandler = asyncHandler(async (req, res) => {
  const validatedBody = upsertScheduleTemplatesSchema.parse(req.body || {});
  const data = await upsertExamScheduleTemplates(req.user.userId, validatedBody, req);
  return sendSuccess(res, data);
});

/**
 * POST /api/v1/admin/calendar-exceptions
 */
export const createCalendarExceptionHandler = asyncHandler(async (req, res) => {
  const validatedBody = createCalendarExceptionSchema.parse(req.body || {});
  const data = await upsertCalendarException(req.user.userId, validatedBody, req);
  return sendSuccess(res, data, 201);
});

/**
 * POST /api/v1/admin/exam-slots/generate
 */
export const generateExamSlotsHandler = asyncHandler(async (req, res) => {
  const validatedBody = generateExamSlotsSchema.parse(req.body || {});
  const data = await generateExamSlotsForAdmin(req.user.userId, validatedBody, req);
  return sendSuccess(res, data);
});
