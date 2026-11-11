import express from 'express';
import { authenticate, authorizeRoles } from '../../middlewares/auth.js';
import { idempotencyGuard } from '../../middlewares/idempotency.js';
import {
  cancelExamBookingHandler,
  createCalendarExceptionHandler,
  createExamBookingHandler,
  generateExamSlotsHandler,
  getExamSlotsAvailabilityHandler,
  rescheduleExamBookingHandler,
  upsertExamScheduleTemplatesHandler,
} from './exam-scheduling.controller.js';

export const examSlotsRouter = express.Router();
export const examBookingsRouter = express.Router();
export const adminExamSchedulingRouter = express.Router();

// GET /api/v1/exam-slots/availability
examSlotsRouter.get(
  '/availability',
  authenticate,
  authorizeRoles('PATIENT', 'SUPERVISOR', 'ADMIN'),
  getExamSlotsAvailabilityHandler
);

// POST /api/v1/exam-bookings
examBookingsRouter.post(
  '/',
  authenticate,
  authorizeRoles('PATIENT'),
  idempotencyGuard({ required: true }),
  createExamBookingHandler
);

// POST /api/v1/exam-bookings/:bookingId/cancel
examBookingsRouter.post(
  '/:bookingId/cancel',
  authenticate,
  authorizeRoles('PATIENT', 'ADMIN'),
  cancelExamBookingHandler
);

// POST /api/v1/exam-bookings/:bookingId/reschedule
examBookingsRouter.post(
  '/:bookingId/reschedule',
  authenticate,
  authorizeRoles('PATIENT', 'ADMIN'),
  idempotencyGuard({ required: false }),
  rescheduleExamBookingHandler
);

// Admin Exam Slot Configuration Endpoints (§4.2)
adminExamSchedulingRouter.use(authenticate, authorizeRoles('ADMIN'));

// PUT /api/v1/admin/exam-schedule-templates
adminExamSchedulingRouter.put('/exam-schedule-templates', upsertExamScheduleTemplatesHandler);

// POST /api/v1/admin/calendar-exceptions
adminExamSchedulingRouter.post('/calendar-exceptions', createCalendarExceptionHandler);

// POST /api/v1/admin/exam-slots/generate
adminExamSchedulingRouter.post('/exam-slots/generate', generateExamSlotsHandler);
