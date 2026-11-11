import { Router } from 'express';
import { asyncHandler } from '../../utils/errors.js';
import { authenticate, authorizeRoles } from '../../middlewares/auth.js';
import { idempotencyGuard } from '../../middlewares/idempotency.js';
import {
  cancelAppointmentHandler,
  freeBedTicketHandler,
  getCalendarAvailabilityHandler,
  getLiveBedBoardHandler,
  occupyBedHandler,
  rescheduleAppointmentHandler,
  scheduleBedHandler,
  startSessionHandler,
} from './beds.controller.js';

/**
 * Department Beds Router — mounted at `/api/v1/departments`
 */
export const departmentBedsRouter = Router();

// GET /api/v1/departments/:departmentId/beds/live-board
departmentBedsRouter.get(
  '/:departmentId/beds/live-board',
  authenticate,
  authorizeRoles('DOCTOR', 'SUPERVISOR', 'ADMIN'),
  asyncHandler(getLiveBedBoardHandler)
);

// GET /api/v1/departments/:departmentId/beds/calendar-availability
departmentBedsRouter.get(
  '/:departmentId/beds/calendar-availability',
  authenticate,
  authorizeRoles('DOCTOR', 'SUPERVISOR', 'ADMIN'),
  asyncHandler(getCalendarAvailabilityHandler)
);

/**
 * Case Beds Router — mounted at `/api/v1/cases`
 */
export const caseBedsRouter = Router();

// POST /api/v1/cases/:caseId/occupy-bed (Path A — Immediate Live Bed Assignment)
caseBedsRouter.post(
  '/:caseId/occupy-bed',
  authenticate,
  authorizeRoles('DOCTOR'),
  idempotencyGuard,
  asyncHandler(occupyBedHandler)
);

// POST /api/v1/cases/:caseId/schedule-bed (Path B — Reserve Future Date & Period Ticket)
caseBedsRouter.post(
  '/:caseId/schedule-bed',
  authenticate,
  authorizeRoles('DOCTOR'),
  idempotencyGuard,
  asyncHandler(scheduleBedHandler)
);

/**
 * Appointments Router — mounted at `/api/v1/appointments`
 */
export const appointmentsRouter = Router();

// POST /api/v1/appointments/:appointmentId/start-session (with Automatic Bed-Swap fallback)
appointmentsRouter.post(
  '/:appointmentId/start-session',
  authenticate,
  authorizeRoles('DOCTOR', 'ADMIN'),
  idempotencyGuard,
  asyncHandler(startSessionHandler)
);

// POST /api/v1/appointments/:appointmentId/cancel
appointmentsRouter.post(
  '/:appointmentId/cancel',
  authenticate,
  authorizeRoles('DOCTOR', 'PATIENT', 'ADMIN'),
  idempotencyGuard,
  asyncHandler(cancelAppointmentHandler)
);

// POST /api/v1/appointments/:appointmentId/reschedule
appointmentsRouter.post(
  '/:appointmentId/reschedule',
  authenticate,
  authorizeRoles('DOCTOR', 'ADMIN'),
  idempotencyGuard,
  asyncHandler(rescheduleAppointmentHandler)
);

/**
 * Bed Tickets Router — mounted at `/api/v1/bed-tickets`
 */
export const bedTicketsRouter = Router();

// POST /api/v1/bed-tickets/:ticketId/free
bedTicketsRouter.post(
  '/:ticketId/free',
  authenticate,
  authorizeRoles('DOCTOR', 'ADMIN'),
  idempotencyGuard,
  asyncHandler(freeBedTicketHandler)
);

export default {
  departmentBedsRouter,
  caseBedsRouter,
  appointmentsRouter,
  bedTicketsRouter,
};
