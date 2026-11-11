import { AppError, sendSuccess } from '../../utils/errors.js';
import {
  calendarAvailabilityQuerySchema,
  cancelAppointmentSchema,
   cancelScheduledAppointment,
  freeBedTicketSchema,
  freeOccupiedBedTicket,
  getDepartmentCalendarAvailability,
  getDepartmentLiveBedBoard,
  occupyBedSchema,
  occupyLiveBedForCase,
  rescheduleAppointmentSchema,
  rescheduleScheduledAppointment,
  scheduleBedSchema,
  scheduleFutureBedForCase,
  startScheduledAppointmentSession,
  startSessionSchema,
} from './beds.service.js';

/**
 * GET /api/v1/departments/:departmentId/beds/live-board
 * Queries `v_bed_live_board` with the 30-minute `WINDOW` reservation protection mode (§4.5).
 */
export async function getLiveBedBoardHandler(req, res) {
  const departmentId = Number(req.params.departmentId);
  if (!Number.isInteger(departmentId) || departmentId <= 0) {
    throw new AppError(400, 'INVALID_DEPARTMENT_ID', 'Invalid departmentId parameter.');
  }

  const data = await getDepartmentLiveBedBoard(departmentId, req.lang || 'ar');
  return sendSuccess(res, data, 200);
}

/**
 * POST /api/v1/cases/:caseId/occupy-bed
 * Path A — Immediate / Same-Day Live Bed Assignment (§3.4.3A & §4.5).
 */
export async function occupyBedHandler(req, res) {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'Invalid caseId parameter.');
  }

  const parsed = occupyBedSchema.parse(req.body || {});
  const data = await occupyLiveBedForCase(caseId, req.user.userId, parsed, req);
  return sendSuccess(res, data, 201);
}

/**
 * GET /api/v1/departments/:departmentId/beds/calendar-availability
 * Path B — Calendar Picker for future reservable bed tickets (§4.5).
 */
export async function getCalendarAvailabilityHandler(req, res) {
  const departmentId = Number(req.params.departmentId);
  if (!Number.isInteger(departmentId) || departmentId <= 0) {
    throw new AppError(400, 'INVALID_DEPARTMENT_ID', 'Invalid departmentId parameter.');
  }

  const parsedQuery = calendarAvailabilityQuerySchema.parse(req.query || {});
  const data = await getDepartmentCalendarAvailability(
    departmentId,
    parsedQuery,
    req.lang || 'ar'
  );
  return sendSuccess(res, data, 200);
}

/**
 * POST /api/v1/cases/:caseId/schedule-bed
 * Path B — Reserve Future Date & Period Ticket (§3.4.3B & §4.5).
 */
export async function scheduleBedHandler(req, res) {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'Invalid caseId parameter.');
  }

  const parsed = scheduleBedSchema.parse(req.body || {});
  const data = await scheduleFutureBedForCase(
    caseId,
    req.user.userId,
    parsed,
    req
  );
  return sendSuccess(res, data, 201);
}

/**
 * POST /api/v1/appointments/:appointmentId/start-session
 * Starts a scheduled appointment on the day, with automatic bed-swap fallback (§3.4.3C & §4.5).
 */
export async function startSessionHandler(req, res) {
  const appointmentId = Number(req.params.appointmentId);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    throw new AppError(
      400,
      'INVALID_APPOINTMENT_ID',
      'Invalid appointmentId parameter.'
    );
  }

  const parsed = startSessionSchema.parse(req.body || {});
  const data = await startScheduledAppointmentSession(
    appointmentId,
    req.user,
    parsed,
    req
  );
  return sendSuccess(res, data, 200);
}

/**
 * POST /api/v1/bed-tickets/:ticketId/free
 * Frees an occupied physical bed immediately (§4.5).
 */
export async function freeBedTicketHandler(req, res) {
  const ticketId = Number(req.params.ticketId);
  if (!Number.isInteger(ticketId) || ticketId <= 0) {
    throw new AppError(400, 'INVALID_TICKET_ID', 'Invalid ticketId parameter.');
  }

  const parsed = freeBedTicketSchema.parse(req.body || {});
  const data = await freeOccupiedBedTicket(ticketId, req.user, parsed, req);
  return sendSuccess(res, data, 200);
}

/**
 * POST /api/v1/appointments/:appointmentId/cancel
 * Cancels a scheduled appointment and its reserved bed ticket (§3.3.2).
 */
export async function cancelAppointmentHandler(req, res) {
  const appointmentId = Number(req.params.appointmentId);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    throw new AppError(
      400,
      'INVALID_APPOINTMENT_ID',
      'Invalid appointmentId parameter.'
    );
  }

  const parsed = cancelAppointmentSchema.parse(req.body || {});
  const data = await cancelScheduledAppointment(
    appointmentId,
    req.user,
    parsed,
    req
  );
  return sendSuccess(res, data, 200);
}

/**
 * POST /api/v1/appointments/:appointmentId/reschedule
 * Reschedules a scheduled appointment to a new date/period/time/bed (§3.3.2 & §4.5).
 */
export async function rescheduleAppointmentHandler(req, res) {
  const appointmentId = Number(req.params.appointmentId);
  if (!Number.isInteger(appointmentId) || appointmentId <= 0) {
    throw new AppError(
      400,
      'INVALID_APPOINTMENT_ID',
      'Invalid appointmentId parameter.'
    );
  }

  const parsed = rescheduleAppointmentSchema.parse(req.body || {});
  const data = await rescheduleScheduledAppointment(
    appointmentId,
    req.user,
    parsed,
    req
  );
  return sendSuccess(res, data, 200);
}
