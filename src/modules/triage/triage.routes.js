import express from 'express';
import { authenticate, authorizeRoles } from '../../middlewares/auth.js';
import { idempotencyGuard } from '../../middlewares/idempotency.js';
import {
  checkInTriageBookingHandler,
  getTriageDailyListHandler,
  routeTriageBookingHandler,
} from './triage.controller.js';

export const triageRouter = express.Router();

// All triage routes require an authenticated SUPERVISOR or ADMIN
triageRouter.use(authenticate, authorizeRoles('SUPERVISOR', 'ADMIN'));

// GET /api/v1/triage/daily-list
triageRouter.get('/daily-list', getTriageDailyListHandler);

// POST /api/v1/triage/bookings/:bookingId/check-in
triageRouter.post('/bookings/:bookingId/check-in', checkInTriageBookingHandler);

// POST /api/v1/triage/bookings/:bookingId/route (and alias /route-to-department)
triageRouter.post(
  '/bookings/:bookingId/route',
  idempotencyGuard({ required: false }),
  routeTriageBookingHandler
);

triageRouter.post(
  '/bookings/:bookingId/route-to-department',
  idempotencyGuard({ required: false }),
  routeTriageBookingHandler
);
