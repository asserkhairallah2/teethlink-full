import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { pool } from './db/pool.js';
import {
  asyncHandler,
  requestContextMiddleware,
  sendSuccess,
} from './utils/errors.js';
import { authenticate } from './middlewares/auth.js';
import { errorHandler, notFoundHandler } from './middlewares/errorHandler.js';
import { filesRouter } from './modules/files/files.controller.js';
import { authRouter, medicalCatalogRouter } from './modules/auth/auth.routes.js';
import { patientsRouter } from './modules/patients/patients.routes.js';
import { adminAccountsRouter } from './modules/admin/admin-accounts.routes.js';
import {
  adminExamSchedulingRouter,
  examBookingsRouter,
  examSlotsRouter,
} from './modules/exam-scheduling/exam-scheduling.routes.js';
import { triageRouter } from './modules/triage/triage.routes.js';
import {
  casesClaimRouter,
  doctorFeedRouter,
} from './modules/doctor-feed/doctor-feed.routes.js';
import {
  caseConversationRouter,
  conversationsRouter,
} from './modules/chat/chat.routes.js';
import {
  appointmentsRouter,
  bedTicketsRouter,
  caseBedsRouter,
  departmentBedsRouter,
} from './modules/beds/beds.routes.js';
import {
  caseTreatmentRouter,
  doctorTreatmentRouter,
  patientCasesHistoryRouter,
} from './modules/treatment/treatment.routes.js';
import { adminReportsRouter } from './modules/reports/reports.routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.resolve(__dirname, '../public');

const app = express();

// Trust reverse proxy headers (X-Forwarded-For) when deployed behind Nginx / load balancer
app.set('trust proxy', 1);

// 1. Security HTTP headers (CSP disabled for local interactive GUI assets)
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginResourcePolicy: { policy: 'cross-origin' },
  })
);

// 2. CORS policy
const allowedOrigins = process.env.CORS_ORIGINS
  ? process.env.CORS_ORIGINS.split(',').map((origin) => origin.trim())
  : '*';

app.use(
  cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Request-Id',
      'Accept-Language',
    ],
    exposedHeaders: ['X-Request-Id', 'X-Idempotency-Replayed'],
  })
);

// 3. Request ID & localization context
app.use(requestContextMiddleware);

// 4. Body parsers
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true, limit: '5mb' }));

// 5. Base API v1 Router
export const apiV1Router = express.Router();

/**
 * GET /api/v1/health
 * Liveness & PostgreSQL connectivity probe.
 */
apiV1Router.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const start = Date.now();
    const { rows } = await pool.query(
      `SELECT
         current_database() AS db_name,
         now() AS server_time,
         (SELECT COUNT(*)::INT FROM departments WHERE is_active = TRUE) AS active_departments,
         (SELECT COUNT(*)::INT FROM clinic_beds WHERE operational_status = 'ACTIVE') AS active_beds,
         (SELECT COUNT(*)::INT FROM users) AS total_users,
         (SELECT COUNT(*)::INT FROM cases) AS total_cases`
    );
    const latencyMs = Date.now() - start;
    const dbInfo = rows[0];

    return sendSuccess(res, {
      status: 'healthy',
      service: 'teethlink-backend',
      version: '1.0.0',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
      database: {
        connected: true,
        engine: pool.isEmbeddedPGlite ? 'PostgreSQL 16 (Embedded PGlite)' : 'PostgreSQL',
        name: dbInfo.db_name,
        serverTime: dbInfo.server_time,
        latencyMs,
        activeDepartments: dbInfo.active_departments,
        activeBeds: dbInfo.active_beds,
        totalUsers: dbInfo.total_users,
        totalCases: dbInfo.total_cases,
      },
    });
  })
);

/**
 * GET /api/v1/demo/overview
 * Public catalog & system overview for the interactive TeethLink GUI.
 */
apiV1Router.get(
  '/demo/overview',
  asyncHandler(async (_req, res) => {
    const [
      deptRes,
      srvRes,
      periodsRes,
      statsRes,
      postsRes,
    ] = await Promise.all([
      pool.query(
        `SELECT department_id, code, name_en, name_ar
         FROM departments
         WHERE is_active = TRUE
         ORDER BY department_id ASC`
      ),
      pool.query(
        `SELECT service_id, department_id, code, name_en, name_ar, typical_sessions, requires_permission
         FROM services
         WHERE is_active = TRUE
         ORDER BY department_id ASC, service_id ASC`
      ),
      pool.query(
        `SELECT period_id, code, name_en, name_ar, start_time::TEXT AS start_time, end_time::TEXT AS end_time
         FROM bed_ticket_periods
         WHERE is_active = TRUE
         ORDER BY display_order ASC`
      ),
      pool.query(
        `SELECT
           (SELECT COUNT(*)::INT FROM users) AS total_users,
           (SELECT COUNT(*)::INT FROM cases) AS total_cases,
           (SELECT COUNT(*)::INT FROM cases WHERE status = 'WAITING_FOR_DOCTOR') AS waiting_cases,
           (SELECT COUNT(*)::INT FROM cases WHERE status IN ('CLAIMED', 'SCHEDULED', 'IN_TREATMENT')) AS active_cases,
           (SELECT COUNT(*)::INT FROM cases WHERE status = 'FINISHED') AS finished_cases,
           (SELECT COUNT(*)::INT FROM bed_tickets WHERE status = 'OCCUPIED') AS occupied_beds,
           (SELECT COUNT(*)::INT FROM bed_tickets WHERE status = 'RESERVED') AS reserved_beds,
           (SELECT COUNT(*)::INT FROM initial_exam_bookings WHERE status IN ('BOOKED', 'CHECKED_IN')) AS open_exam_bookings,
           (SELECT COUNT(*)::INT FROM users WHERE account_status = 'PENDING_APPROVAL') AS pending_approvals`
      ),
      pool.query(
        `SELECT
           sp.post_id,
           sp.case_id,
           COALESCE(s.name_ar, d.name_ar, 'حالة إكلينيكية') AS title,
           sp.description AS caption,
           c.tooth_numbers[1] AS tooth_number,
           COALESCE(r.score, 5) AS supervisor_rating,
           sp.published_at,
           u.full_name AS doctor_name,
           sdp.academic_year,
           sdp.doctor_category,
           d.code AS department_code,
           d.name_en AS department_name_en,
           d.name_ar AS department_name_ar,
           s.name_en AS service_name_en,
           s.name_ar AS service_name_ar
         FROM student_posts sp
         JOIN cases c ON c.case_id = sp.case_id
         JOIN users u ON u.user_id = sp.doctor_id
         LEFT JOIN student_doctor_profiles sdp ON sdp.doctor_id = sp.doctor_id
         JOIN departments d ON d.department_id = c.department_id
         LEFT JOIN services s ON s.service_id = c.service_id
         LEFT JOIN ratings r ON r.case_id = sp.case_id
         WHERE sp.is_published = TRUE
         ORDER BY sp.published_at DESC
         LIMIT 20`
      ),
    ]);

    return sendSuccess(res, {
      departments: deptRes.rows,
      services: srvRes.rows,
      clinicPeriods: periodsRes.rows,
      stats: statsRes.rows[0],
      portfolioPosts: postsRes.rows,
    });
  })
);

/**
 * GET /api/v1/notifications
 * Returns recent notifications for the currently authenticated user.
 */
apiV1Router.get(
  '/notifications',
  authenticate,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query(
      `SELECT
         notification_id,
         type,
         type AS event_type,
         title,
         title AS title_en,
         title AS title_ar,
         body,
         body AS body_en,
         body AS body_ar,
         data,
         data AS payload,
         case_id,
         is_read,
         read_at,
         created_at
       FROM notifications
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT 30`,
      [req.user.userId]
    );
    return sendSuccess(res, { notifications: rows });
  })
);

/**
 * POST /api/v1/notifications/read-all
 * Marks all unread notifications for the authenticated user as read.
 */
apiV1Router.post(
  '/notifications/read-all',
  authenticate,
  asyncHandler(async (req, res) => {
    const { rowCount } = await pool.query(
      `UPDATE notifications
       SET is_read = TRUE, read_at = now()
       WHERE user_id = $1 AND is_read = FALSE`,
      [req.user.userId]
    );
    return sendSuccess(res, { markedReadCount: rowCount });
  })
);

// Mount Phase 2 Domain Routers
apiV1Router.use('/files', filesRouter);
apiV1Router.use('/medical-catalog', medicalCatalogRouter);
apiV1Router.use('/auth', authRouter);
apiV1Router.use('/patients', patientsRouter);
apiV1Router.use('/admin/accounts', adminAccountsRouter);

// Mount Phase 3 Domain Routers (Module 2: Initial Exam Slots & Module 3: Supervisor Triage)
apiV1Router.use('/exam-slots', examSlotsRouter);
apiV1Router.use('/exam-bookings', examBookingsRouter);
apiV1Router.use('/exams/bookings', examBookingsRouter);
apiV1Router.use('/admin', adminExamSchedulingRouter);
apiV1Router.use('/triage', triageRouter);

// Mount Phase 4 Domain Routers (Module 4: Doctor InDrive Feed & Claiming, Module 7: Chat & Calls)
apiV1Router.use('/doctor', doctorFeedRouter);
apiV1Router.use('/cases', casesClaimRouter);
apiV1Router.use('/cases', caseConversationRouter);
apiV1Router.use('/conversations', conversationsRouter);

// Mount Phase 5 Domain Routers (Module 5: Clinic Beds/Tickets, Module 6: Treatment/Portfolio/Ratings, Module 8: Admin Reports & CRUD)
apiV1Router.use('/departments', departmentBedsRouter);
apiV1Router.use('/cases', caseBedsRouter);
apiV1Router.use('/cases', caseTreatmentRouter);
apiV1Router.use('/appointments', appointmentsRouter);
apiV1Router.use('/bed-tickets', bedTicketsRouter);
apiV1Router.use('/doctor', doctorTreatmentRouter);
apiV1Router.use('/patients', patientCasesHistoryRouter);
apiV1Router.use('/admin', adminReportsRouter);

app.use('/api/v1', apiV1Router);

// Serve static frontend GUI from public/
app.use(express.static(PUBLIC_DIR));

// SPA fallback for non-API GET routes
app.get(/^(?!\/api\/).*/, (_req, res, next) => {
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'), (err) => {
    if (err) next();
  });
});

// 6. 404 Not Found & Global Error Handler
app.use(notFoundHandler);
app.use(errorHandler);

export default app;
