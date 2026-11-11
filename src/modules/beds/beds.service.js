import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import { createNotification, writeAuditLog } from '../../utils/audit.js';
import { emitToRooms } from '../../realtime/socketGateway.js';

// =============================================================================
// Zod Validation Schemas (§4.5)
// =============================================================================

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

export const occupyBedSchema = z.object({
  bedId: z.coerce.number().int().positive(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export const calendarAvailabilityQuerySchema = z.object({
  fromDate: z
    .string()
    .trim()
    .regex(isoDateRegex, 'fromDate must be in YYYY-MM-DD format')
    .optional(),
  toDate: z
    .string()
    .trim()
    .regex(isoDateRegex, 'toDate must be in YYYY-MM-DD format')
    .optional(),
});

export const scheduleBedSchema = z.object({
  serviceDate: z
    .string()
    .trim()
    .regex(isoDateRegex, 'serviceDate must be in YYYY-MM-DD format'),
  periodId: z.coerce.number().int().positive(),
  plannedStartTime: z
    .string()
    .trim()
    .regex(timeRegex, 'plannedStartTime must be in HH:MM or HH:MM:SS format')
    .transform((val) => (val.length === 5 ? `${val}:00` : val)),
  bedId: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export const startSessionSchema = z.object({
  preferredBedId: z.coerce.number().int().positive().optional().nullable(),
  notes: z.string().trim().max(2000).optional().nullable(),
});

export const completionReportInputSchema = z.object({
  finalDiagnosis: z.string().trim().max(2000).optional().nullable(),
  procedureSummary: z.string().trim().min(5).max(4000),
  materialsUsed: z.string().trim().max(2000).optional().nullable(),
  result: z.string().trim().max(2000).optional().nullable(),
  postCareInstructions: z.string().trim().max(2000).optional().nullable(),
  photoIds: z.array(z.coerce.number().int().positive()).optional().default([]),
});

export const freeBedTicketSchema = z.object({
  outcome: z.enum(['NEEDS_FOLLOW_UP', 'FINISHED']).optional().nullable(),
  procedurePerformed: z.string().trim().max(4000).optional().nullable(),
  sessionNotes: z.string().trim().max(4000).optional().nullable(),
  nextSteps: z.string().trim().max(2000).optional().nullable(),
  completionReport: completionReportInputSchema.optional().nullable(),
});

export const cancelAppointmentSchema = z.object({
  reason: z.string().trim().min(3).max(200),
});

export const rescheduleAppointmentSchema = z.object({
  serviceDate: z
    .string()
    .trim()
    .regex(isoDateRegex, 'serviceDate must be in YYYY-MM-DD format'),
  periodId: z.coerce.number().int().positive(),
  plannedStartTime: z
    .string()
    .trim()
    .regex(timeRegex, 'plannedStartTime must be in HH:MM or HH:MM:SS format')
    .transform((val) => (val.length === 5 ? `${val}:00` : val)),
  bedId: z.coerce.number().int().positive().optional().nullable(),
  reason: z.string().trim().max(200).optional().nullable(),
});

// =============================================================================
// Internal Helpers
// =============================================================================

/**
 * Loads bed/reservation runtime settings from `system_settings`.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} db
 */
export async function loadBedSettings(db = pool) {
  const { rows } = await db.query(
    `SELECT key, value
     FROM system_settings
     WHERE key IN (
       'hospital_timezone',
       'reservation_protection_mode',
       'reservation_protect_minutes',
       'bed_reservation_grace_minutes',
       'require_before_after_photos_on_finish',
       'require_supervisor_report_review'
     )`
  );

  const settings = {
    hospitalTimezone: 'Africa/Cairo',
    reservationProtectionMode: 'WINDOW',
    reservationProtectMinutes: 30,
    bedReservationGraceMinutes: 30,
    requireBeforeAfterPhotosOnFinish: false,
    requireSupervisorReportReview: false,
  };

  for (const row of rows) {
    if (row.key === 'hospital_timezone' && typeof row.value === 'string') {
      settings.hospitalTimezone = row.value;
    } else if (
      row.key === 'reservation_protection_mode' &&
      typeof row.value === 'string'
    ) {
      settings.reservationProtectionMode = row.value.toUpperCase();
    } else if (row.key === 'reservation_protect_minutes') {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) settings.reservationProtectMinutes = n;
    } else if (row.key === 'bed_reservation_grace_minutes') {
      const n = Number(row.value);
      if (Number.isFinite(n) && n >= 0) settings.bedReservationGraceMinutes = n;
    } else if (row.key === 'require_before_after_photos_on_finish') {
      settings.requireBeforeAfterPhotosOnFinish =
        row.value === true || row.value === 'true';
    } else if (row.key === 'require_supervisor_report_review') {
      settings.requireSupervisorReportReview =
        row.value === true || row.value === 'true';
    }
  }

  return settings;
}

/**
 * Formats a timestamp into a readable Cairo time string for dashboard log lines.
 *
 * @param {Date | string} dateInput
 * @param {string} timezone
 */
export function formatCairoTime(dateInput, timezone = 'Africa/Cairo') {
  try {
    const dt = dateInput instanceof Date ? dateInput : new Date(dateInput);
    return new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }).format(dt);
  } catch {
    return new Date(dateInput).toISOString();
  }
}

/**
 * Builds the dashboard log sentence required by §3.4.3A and §4.8:
 * "Bed C3-B01 booked by Dr. Omar Khaled with Patient Sara Ahmed Hassan at 02:10 PM (Cairo)"
 */
export function buildBedDashboardLogLine({
  bedLabel,
  doctorName,
  patientName,
  timestamp,
  timezone = 'Africa/Cairo',
}) {
  const formattedTime = formatCairoTime(timestamp, timezone);
  const cleanDocName = String(doctorName || '').replace(/^Dr\.?\s*/i, '');
  return `Bed ${bedLabel} booked by Dr. ${cleanDocName} with Patient ${patientName} at ${formattedTime} (Cairo)`;
}

/**
 * Finds the active `bed_ticket_periods` row matching the current time in hospital timezone
 * (or falls back to the first active period of the day).
 *
 * @param {import('pg').Pool | import('pg').PoolClient} db
 * @param {string} timezone
 */
async function resolveCurrentPeriod(db, timezone) {
  const { rows } = await db.query(
    `SELECT
       period_id,
       code,
       name_en,
       name_ar,
       start_time::TEXT AS start_time,
       end_time::TEXT AS end_time,
       ((now() AT TIME ZONE $1)::TIME BETWEEN start_time AND end_time) AS is_current
     FROM bed_ticket_periods
     WHERE is_active = TRUE
     ORDER BY
       CASE WHEN ((now() AT TIME ZONE $1)::TIME BETWEEN start_time AND end_time) THEN 0 ELSE 1 END,
       display_order ASC,
       start_time ASC
     LIMIT 1`,
    [timezone]
  );

  return rows[0] || null;
}

// =============================================================================
// 1. GET /api/v1/departments/:departmentId/beds/live-board (§4.5)
// =============================================================================

/**
 * Queries `v_bed_live_board` for a department with the 30-minute `WINDOW` reservation
 * protection mode, enriched with active ticket/doctor/case details.
 *
 * @param {number} departmentId
 * @param {string} lang
 */
export async function getDepartmentLiveBedBoard(departmentId, lang = 'ar') {
  const isAr = lang === 'ar';
  const settings = await loadBedSettings(pool);

  const deptRes = await pool.query(
    `SELECT department_id, code, name_en, name_ar, is_active
     FROM departments
     WHERE department_id = $1
     LIMIT 1`,
    [departmentId]
  );

  if (deptRes.rows.length === 0) {
    throw new AppError(
      404,
      'DEPARTMENT_NOT_FOUND',
      `Department ${departmentId} was not found.`
    );
  }

  const dept = deptRes.rows[0];
  const currentPeriodRow = await resolveCurrentPeriod(
    pool,
    settings.hospitalTimezone
  );

  const boardRes = await pool.query(
    `SELECT
       vb.bed_id,
       vb.label,
       vb.bed_number,
       vb.clinic_id,
       vb.clinic_number,
       vb.department_id,
       vb.operational_status,
       vb.occupied_ticket_id,
       vb.occupied_at,
       vb.occupied_by_doctor_id,
       vb.occupied_patient_id,
       vb.occupied_case_id,
       vb.upcoming_reserved_ticket_id,
       vb.reserved_planned_start_at,
       vb.next_reservation_at,
       vb.live_status,
       occ_bt.ticket_code AS occupied_ticket_code,
       occ_bt.ticket_type AS occupied_ticket_type,
       occ_doc.full_name AS occupied_doctor_name,
       occ_pat.full_name AS occupied_patient_name,
       occ_case.case_number AS occupied_case_number,
       res_bt.ticket_code AS reserved_ticket_code,
       res_doc.user_id AS reserved_doctor_id,
       res_doc.full_name AS reserved_doctor_name,
       res_case.case_number AS reserved_case_number
     FROM v_bed_live_board vb
     LEFT JOIN bed_tickets occ_bt ON occ_bt.ticket_id = vb.occupied_ticket_id
     LEFT JOIN users occ_doc ON occ_doc.user_id = vb.occupied_by_doctor_id
     LEFT JOIN users occ_pat ON occ_pat.user_id = vb.occupied_patient_id
     LEFT JOIN cases occ_case ON occ_case.case_id = vb.occupied_case_id
     LEFT JOIN bed_tickets res_bt ON res_bt.ticket_id = vb.upcoming_reserved_ticket_id
     LEFT JOIN users res_doc ON res_doc.user_id = res_bt.doctor_id
     LEFT JOIN cases res_case ON res_case.case_id = res_bt.case_id
     WHERE vb.department_id = $1
     ORDER BY vb.clinic_number ASC, vb.bed_number ASC`,
    [departmentId]
  );

  const summary = {
    totalBeds: boardRes.rows.length,
    free: 0,
    occupied: 0,
    reservedWindowActive: 0,
    outOfService: 0,
  };

  const beds = boardRes.rows.map((row) => {
    if (row.live_status === 'FREE') summary.free += 1;
    else if (row.live_status === 'OCCUPIED') summary.occupied += 1;
    else if (row.live_status === 'RESERVED_WINDOW_ACTIVE')
      summary.reservedWindowActive += 1;
    else if (row.live_status === 'OUT_OF_SERVICE') summary.outOfService += 1;

    let currentTicket = null;
    if (row.occupied_ticket_id) {
      currentTicket = {
        ticketId: Number(row.occupied_ticket_id),
        ticketCode: row.occupied_ticket_code,
        ticketType: row.occupied_ticket_type,
        status: 'OCCUPIED',
        occupiedAt: row.occupied_at,
        doctor: {
          doctorId: Number(row.occupied_by_doctor_id),
          fullName: row.occupied_doctor_name,
        },
        patient: {
          patientId: Number(row.occupied_patient_id),
          fullName: row.occupied_patient_name,
        },
        caseId: Number(row.occupied_case_id),
        caseNumber: row.occupied_case_number,
      };
    } else if (row.upcoming_reserved_ticket_id) {
      currentTicket = {
        ticketId: Number(row.upcoming_reserved_ticket_id),
        ticketCode: row.reserved_ticket_code,
        ticketType: 'SCHEDULED',
        status: 'RESERVED',
        plannedStartAt: row.reserved_planned_start_at,
        doctor: {
          doctorId: Number(row.reserved_doctor_id),
          fullName: row.reserved_doctor_name,
        },
        caseNumber: row.reserved_case_number,
      };
    }

    return {
      bedId: Number(row.bed_id),
      label: row.label,
      bedNumber: Number(row.bed_number),
      clinicId: Number(row.clinic_id),
      clinicNumber: row.clinic_number,
      operationalStatus: row.operational_status,
      liveStatus: row.live_status,
      currentTicket,
      nextReservationAt: row.next_reservation_at,
    };
  });

  return {
    departmentId: Number(dept.department_id),
    departmentCode: dept.code,
    departmentName: isAr ? dept.name_ar : dept.name_en,
    reservationProtectionMode: settings.reservationProtectionMode,
    reservationProtectMinutes: settings.reservationProtectMinutes,
    currentPeriod: currentPeriodRow
      ? {
          periodId: Number(currentPeriodRow.period_id),
          code: currentPeriodRow.code,
          name: isAr ? currentPeriodRow.name_ar : currentPeriodRow.name_en,
          startTime: currentPeriodRow.start_time,
          endTime: currentPeriodRow.end_time,
          isCurrentShift: Boolean(currentPeriodRow.is_current),
        }
      : null,
    summary,
    beds,
  };
}

// =============================================================================
// 2. POST /api/v1/cases/:caseId/occupy-bed (Path A — Live Bed Assignment, §3.4.3A)
// =============================================================================

/**
 * Atomically occupies a physical clinic bed right now (Path A — Open-Ended `LIVE` Ticket).
 * Follows the exact lock ordering and 30-minute `WINDOW` reservation protection in §3.4.3A.
 *
 * @param {number} caseId
 * @param {number} doctorId
 * @param {import('z').infer<typeof occupyBedSchema>} payload
 * @param {import('express').Request} req
 */
export async function occupyLiveBedForCase(caseId, doctorId, payload, req) {
  const { bedId, notes } = payload;

  return withTransaction(
    async (client, afterCommit) => {
      const settings = await loadBedSettings(client);

      // 1) Lock Doctor row (prevents one doctor occupying two beds in parallel requests)
      const docRes = await client.query(
        `SELECT d.doctor_id, u.full_name AS doctor_name, u.account_status
         FROM student_doctor_profiles d
         JOIN users u ON u.user_id = d.doctor_id
         WHERE d.doctor_id = $1
         FOR UPDATE`,
        [doctorId]
      );

      if (docRes.rows.length === 0) {
        throw new AppError(404, 'DOCTOR_NOT_FOUND', 'Doctor profile not found.');
      }

      const doctorRow = docRes.rows[0];
      if (doctorRow.account_status !== 'ACTIVE') {
        throw new AppError(
          403,
          'DOCTOR_ACCOUNT_NOT_ACTIVE',
          'Your doctor account must be ACTIVE to occupy a clinic bed.'
        );
      }

      // Fast check if doctor is already occupying another bed right now
      const docOccRes = await client.query(
        `SELECT ticket_id, bed_id, case_id
         FROM bed_tickets
         WHERE doctor_id = $1 AND status = 'OCCUPIED'
         LIMIT 1`,
        [doctorId]
      );
      if (docOccRes.rows.length > 0) {
        throw new AppError(
          409,
          'DOCTOR_ALREADY_OCCUPYING_BED',
          'You are already occupying an active clinic bed. Please free your current bed before occupying another one.',
          {
            activeTicketId: Number(docOccRes.rows[0].ticket_id),
            activeBedId: Number(docOccRes.rows[0].bed_id),
            activeCaseId: Number(docOccRes.rows[0].case_id),
          }
        );
      }

      // 2) Lock Case row with NOWAIT (verify ownership & valid state CLAIMED or NEEDS_FOLLOW_UP)
      const caseRes = await client.query(
        `SELECT
           c.case_id,
           c.case_number,
           c.patient_id,
           c.department_id,
           c.assigned_doctor_id,
           c.status,
           c.total_sessions,
           pu.full_name AS patient_name
         FROM cases c
         JOIN users pu ON pu.user_id = c.patient_id
         WHERE c.case_id = $1
         FOR UPDATE OF c NOWAIT`,
        [caseId]
      );

      if (caseRes.rows.length === 0) {
        throw new AppError(404, 'CASE_NOT_FOUND', `Case ${caseId} was not found.`);
      }

      const caseRow = caseRes.rows[0];
      if (Number(caseRow.assigned_doctor_id) !== Number(doctorId)) {
        throw new AppError(
          403,
          'NOT_CASE_DOCTOR',
          'Only the doctor assigned to this case can occupy a clinic bed for it.'
        );
      }

      if (!['CLAIMED', 'NEEDS_FOLLOW_UP'].includes(caseRow.status)) {
        throw new AppError(
          422,
          'INVALID_CASE_STATE',
          `Case must be in 'CLAIMED' or 'NEEDS_FOLLOW_UP' status to occupy a live bed (current status: '${caseRow.status}').`
        );
      }

      const patientId = Number(caseRow.patient_id);
      const departmentId = Number(caseRow.department_id);
      const oldStatus = caseRow.status;
      const nextSessionNo = Number(caseRow.total_sessions) + 1;

      // 3) Lock the physical Clinic Bed row with NOWAIT
      const bedRes = await client.query(
        `SELECT
           b.bed_id,
           b.label,
           b.bed_number,
           b.operational_status,
           c.clinic_id,
           c.clinic_number,
           c.department_id AS bed_department_id
         FROM clinic_beds b
         JOIN clinics c ON c.clinic_id = b.clinic_id
         WHERE b.bed_id = $1
         FOR UPDATE OF b NOWAIT`,
        [bedId]
      );

      if (bedRes.rows.length === 0) {
        throw new AppError(404, 'BED_NOT_FOUND', `Clinic bed ${bedId} was not found.`);
      }

      const bedRow = bedRes.rows[0];
      if (bedRow.operational_status !== 'ACTIVE') {
        throw new AppError(
          409,
          'BED_OUT_OF_SERVICE',
          `Bed ${bedRow.label} is currently ${bedRow.operational_status} and cannot be occupied.`
        );
      }

      if (Number(bedRow.bed_department_id) !== departmentId) {
        throw new AppError(
          422,
          'BED_DEPARTMENT_MISMATCH',
          `Bed ${bedRow.label} belongs to department ${bedRow.bed_department_id}, but case ${caseRow.case_number} belongs to department ${departmentId}.`
        );
      }

      // 4) Verify the bed is not currently OCCUPIED and not within the 30-min pre-arrival WINDOW of a RESERVED ticket today
      const currentPeriod = await resolveCurrentPeriod(
        client,
        settings.hospitalTimezone
      );
      const currentPeriodId = currentPeriod
        ? Number(currentPeriod.period_id)
        : null;

      let conflictRes;
      if (settings.reservationProtectionMode === 'STRICT' && currentPeriodId) {
        conflictRes = await client.query(
          `SELECT ticket_id, status, ticket_type, doctor_id, planned_start_at
           FROM bed_tickets
           WHERE bed_id = $1
             AND (
               status = 'OCCUPIED'
               OR (
                 status = 'RESERVED'
                 AND service_date = CURRENT_DATE
                 AND period_id = $2
               )
             )
           LIMIT 1`,
          [bedId, currentPeriodId]
        );
      } else {
        // Default WINDOW mode (§3.4.3A): blocks live occupancy only within reservation_protect_minutes (30 min) before planned_start_at
        conflictRes = await client.query(
          `SELECT ticket_id, status, ticket_type, doctor_id, planned_start_at
           FROM bed_tickets
           WHERE bed_id = $1
             AND (
               status = 'OCCUPIED'
               OR (
                 status = 'RESERVED'
                 AND service_date = CURRENT_DATE
                 AND now() >= (planned_start_at - ($2 || ' minutes')::INTERVAL)
               )
             )
           LIMIT 1`,
          [bedId, String(settings.reservationProtectMinutes)]
        );
      }

      if (conflictRes.rows.length > 0) {
        const conflict = conflictRes.rows[0];
        if (conflict.status === 'OCCUPIED') {
          throw new AppError(
            409,
            'BED_ALREADY_OCCUPIED',
            `Bed ${bedRow.label} is currently occupied by another treatment session.`
          );
        }
        throw new AppError(
          409,
          'BED_RESERVED_WINDOW_ACTIVE',
          `Bed ${bedRow.label} has a scheduled reservation arriving within ${settings.reservationProtectMinutes} minutes (${new Date(conflict.planned_start_at).toISOString()}). Please choose another free bed.`,
          {
            reservedTicketId: Number(conflict.ticket_id),
            plannedStartAt: conflict.planned_start_at,
          }
        );
      }

      // 5) Create the treatment session Appointment (path = LIVE_BED, status = IN_PROGRESS)
      const apptRes = await client.query(
        `INSERT INTO appointments (
           case_id,
           session_no,
           doctor_id,
           patient_id,
           department_id,
           path,
           appointment_date,
           period_id,
           planned_start_at,
           status,
           checked_in_at,
           started_at,
           session_notes,
           created_by
         )
         VALUES (
           $1, $2, $3, $4, $5,
           'LIVE_BED', CURRENT_DATE, $6, now(),
           'IN_PROGRESS', now(), now(), $7, $3
         )
         RETURNING appointment_id, session_no, appointment_date::TEXT AS appointment_date, started_at`,
        [
          caseId,
          nextSessionNo,
          doctorId,
          patientId,
          departmentId,
          currentPeriodId,
          notes || null,
        ]
      );
      const apptRow = apptRes.rows[0];
      const appointmentId = Number(apptRow.appointment_id);

      // 6) Create the open-ended LIVE Bed Ticket (status = OCCUPIED, freed_at = NULL)
      const cleanBedCode = String(bedRow.label).replace(/[^A-Za-z0-9]/g, '');
      const ticketRes = await client.query(
        `INSERT INTO bed_tickets (
           ticket_code,
           ticket_type,
           status,
           bed_id,
           department_id,
           appointment_id,
           case_id,
           doctor_id,
           patient_id,
           service_date,
           period_id,
           planned_start_at,
           occupied_at,
           created_by
         )
         VALUES (
           'BT-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-' || $1 || '-L' || $2::TEXT,
           'LIVE',
           'OCCUPIED',
           $3,
           $4,
           $2,
           $5,
           $6,
           $7,
           CURRENT_DATE,
           $8,
           now(),
           now(),
           $6
         )
         RETURNING ticket_id, ticket_code, occupied_at`,
        [
          cleanBedCode,
          appointmentId,
          bedId,
          departmentId,
          caseId,
          doctorId,
          patientId,
          currentPeriodId,
        ]
      );
      const ticketRow = ticketRes.rows[0];
      const ticketId = Number(ticketRow.ticket_id);

      // 7) Transition Case to IN_TREATMENT and increment total_sessions
      await client.query(
        `UPDATE cases
         SET status = 'IN_TREATMENT',
             total_sessions = total_sessions + 1,
             version = version + 1,
             updated_at = now()
         WHERE case_id = $1`,
        [caseId]
      );

      await client.query(
        `INSERT INTO case_status_history (
           case_id,
           from_status,
           to_status,
           changed_by,
           reason,
           metadata
         )
         VALUES ($1, $2, 'IN_TREATMENT', $3, $4, $5::jsonb)`,
        [
          caseId,
          oldStatus,
          doctorId,
          `Occupied live clinic bed ${bedRow.label}`,
          JSON.stringify({
            bedId,
            bedLabel: bedRow.label,
            clinicNumber: bedRow.clinic_number,
            ticketId,
            appointmentId,
          }),
        ]
      );

      const dashboardLogLine = buildBedDashboardLogLine({
        bedLabel: bedRow.label,
        doctorName: doctorRow.doctor_name,
        patientName: caseRow.patient_name,
        timestamp: ticketRow.occupied_at,
        timezone: settings.hospitalTimezone,
      });

      // 8) Notify Patient in DB + write audit log
      await createNotification(client, {
        userId: patientId,
        type: 'BED_ASSIGNED_LIVE',
        title: 'Clinic Bed Ready Now',
        body: `Dr. ${doctorRow.doctor_name} booked Clinic ${bedRow.clinic_number} / Bed ${bedRow.label} for your session now.`,
        caseId,
        data: {
          caseId,
          caseNumber: caseRow.case_number,
          appointmentId,
          sessionNo: nextSessionNo,
          bedId,
          bedLabel: bedRow.label,
          clinicNumber: bedRow.clinic_number,
          ticketId,
          ticketCode: ticketRow.ticket_code,
        },
      });

      await writeAuditLog(client, {
        actorUserId: doctorId,
        actorRole: 'DOCTOR',
        action: 'BED_OCCUPIED_LIVE',
        entityType: 'bed_tickets',
        entityId: ticketId,
        afterData: {
          ticketId,
          ticketCode: ticketRow.ticket_code,
          bedId,
          bedLabel: bedRow.label,
          clinicNumber: bedRow.clinic_number,
          caseId,
          appointmentId,
          dashboardLogLine,
        },
        req,
      });

      // 9) Post-Commit Socket.io Broadcast (§3.4.3A Step 9)
      afterCommit(async () => {
        const eventPayload = {
          ticketId,
          ticketCode: ticketRow.ticket_code,
          ticketType: 'LIVE',
          bedId,
          bedLabel: bedRow.label,
          clinicNumber: bedRow.clinic_number,
          departmentId,
          liveStatus: 'OCCUPIED',
          occupiedAt: ticketRow.occupied_at,
          doctor: {
            doctorId,
            fullName: doctorRow.doctor_name,
          },
          patient: {
            patientId,
            fullName: caseRow.patient_name,
          },
          caseId,
          caseNumber: caseRow.case_number,
          dashboardLogLine,
        };

        emitToRooms(
          [
            `dept:${departmentId}:beds`,
            'admin:dashboard',
            `user:${patientId}`,
            `case:${caseId}`,
          ],
          'bed.occupied',
          eventPayload
        );
      });

      return {
        caseId,
        caseNumber: caseRow.case_number,
        caseStatus: 'IN_TREATMENT',
        appointmentId,
        sessionNo: nextSessionNo,
        ticket: {
          ticketId,
          ticketCode: ticketRow.ticket_code,
          ticketType: 'LIVE',
          status: 'OCCUPIED',
          bedId,
          bedLabel: bedRow.label,
          clinicNumber: bedRow.clinic_number,
          occupiedAt: ticketRow.occupied_at,
          freedAt: null,
          dashboardLogLine,
        },
      };
    },
    { resourceHint: 'BED' }
  );
}

// =============================================================================
// 3. GET /api/v1/departments/:departmentId/beds/calendar-availability (Path B)
// =============================================================================

/**
 * Returns Path B calendar ticket availability across a date range for a department,
 * excluding closed dates and already-reserved beds per `(service_date, period_id)` (§4.5).
 *
 * @param {number} departmentId
 * @param {{ fromDate?: string, toDate?: string }} queryParams
 * @param {string} lang
 */
export async function getDepartmentCalendarAvailability(
  departmentId,
  queryParams = {},
  lang = 'ar'
) {
  const isAr = lang === 'ar';
  const settings = await loadBedSettings(pool);

  const deptRes = await pool.query(
    `SELECT department_id, code, name_en, name_ar
     FROM departments
     WHERE department_id = $1
     LIMIT 1`,
    [departmentId]
  );

  if (deptRes.rows.length === 0) {
    throw new AppError(
      404,
      'DEPARTMENT_NOT_FOUND',
      `Department ${departmentId} was not found.`
    );
  }
  const dept = deptRes.rows[0];

  // Resolve date range (default: today .. today + 14 days in hospital timezone)
  const dateRangeRes = await pool.query(
    `SELECT
       COALESCE($1::DATE, (now() AT TIME ZONE $3)::DATE) AS from_date,
       COALESCE($2::DATE, ((now() AT TIME ZONE $3)::DATE + INTERVAL '14 days')::DATE) AS to_date,
       (now() AT TIME ZONE $3)::DATE AS today_date`,
    [queryParams.fromDate || null, queryParams.toDate || null, settings.hospitalTimezone]
  );
  const { from_date: fromDateObj, to_date: toDateObj, today_date: todayDateObj } =
    dateRangeRes.rows[0];

  const daysSpanRes = await pool.query(
    `SELECT
       ($2::DATE - $1::DATE)::INT AS diff_days,
       to_char(d::DATE, 'YYYY-MM-DD') AS date_str
     FROM generate_series($1::DATE, $2::DATE, INTERVAL '1 day') AS d`,
    [fromDateObj, toDateObj]
  );

  if (daysSpanRes.rows.length === 0 || daysSpanRes.rows[0].diff_days < 0) {
    throw new AppError(
      400,
      'INVALID_DATE_RANGE',
      'toDate must be greater than or equal to fromDate.'
    );
  }
  if (daysSpanRes.rows[0].diff_days > 31) {
    throw new AppError(
      400,
      'DATE_RANGE_TOO_LARGE',
      'Calendar availability query range cannot exceed 31 days.'
    );
  }

  const datesList = daysSpanRes.rows.map((r) => r.date_str);
  const fromDateStr = datesList[0];
  const toDateStr = datesList[datesList.length - 1];
  const todayStr =
    todayDateObj instanceof Date
      ? todayDateObj.toISOString().slice(0, 10)
      : String(todayDateObj).slice(0, 10);

  // 1) Load all active reservable beds in this department
  const bedsRes = await pool.query(
    `SELECT
       b.bed_id,
       b.label,
       b.bed_number,
       c.clinic_id,
       c.clinic_number
     FROM clinic_beds b
     JOIN clinics c ON c.clinic_id = b.clinic_id
     WHERE c.department_id = $1
       AND c.is_active = TRUE
       AND b.operational_status = 'ACTIVE'
       AND b.is_reservable = TRUE
     ORDER BY c.clinic_number ASC, b.bed_number ASC`,
    [departmentId]
  );
  const reservableBeds = bedsRes.rows.map((b) => ({
    bedId: Number(b.bed_id),
    label: b.label,
    bedNumber: Number(b.bed_number),
    clinicId: Number(b.clinic_id),
    clinicNumber: b.clinic_number,
  }));

  // 2) Load active periods
  const periodsRes = await pool.query(
    `SELECT
       period_id,
       code,
       name_en,
       name_ar,
       start_time::TEXT AS start_time,
       end_time::TEXT AS end_time,
       display_order
     FROM bed_ticket_periods
     WHERE is_active = TRUE
     ORDER BY display_order ASC, start_time ASC`
  );

  // 3) Load calendar exceptions in range for HOSPITAL or this DEPARTMENT
  const excRes = await pool.query(
    `SELECT
       to_char(exception_date, 'YYYY-MM-DD') AS exception_date,
       scope,
       is_closed,
       custom_start_time::TEXT AS custom_start_time,
       custom_end_time::TEXT AS custom_end_time,
       reason
     FROM calendar_exceptions
     WHERE exception_date BETWEEN $1::DATE AND $2::DATE
       AND (
         scope = 'HOSPITAL'
         OR (scope = 'DEPARTMENT' AND department_id = $3)
       )`,
    [fromDateStr, toDateStr, departmentId]
  );
  const exceptionsByDate = new Map();
  for (const exc of excRes.rows) {
    const existing = exceptionsByDate.get(exc.exception_date);
    if (!existing || exc.scope === 'HOSPITAL' || exc.is_closed) {
      exceptionsByDate.set(exc.exception_date, exc);
    }
  }

  // 4) Load RESERVED bed tickets in date range (and OCCUPIED tickets for today)
  const reservedRes = await pool.query(
    `SELECT
       to_char(service_date, 'YYYY-MM-DD') AS service_date,
       period_id,
       bed_id,
       status
     FROM bed_tickets
     WHERE department_id = $1
       AND service_date BETWEEN $2::DATE AND $3::DATE
       AND (
         status = 'RESERVED'
         OR (status = 'OCCUPIED' AND service_date = CURRENT_DATE)
       )`,
    [departmentId, fromDateStr, toDateStr]
  );

  // Map: `${date}:${periodId}` -> Set of unavailable bedIds
  const unavailableMap = new Map();
  const occupiedTodayBeds = new Set();

  for (const row of reservedRes.rows) {
    const bedIdNum = Number(row.bed_id);
    if (row.status === 'OCCUPIED') {
      occupiedTodayBeds.add(bedIdNum);
    } else if (row.period_id) {
      const key = `${row.service_date}:${Number(row.period_id)}`;
      if (!unavailableMap.has(key)) unavailableMap.set(key, new Set());
      unavailableMap.get(key).add(bedIdNum);
    }
  }

  const totalReservableBeds = reservableBeds.length;

  const days = datesList.map((dateStr) => {
    const exc = exceptionsByDate.get(dateStr);
    const isClosed = Boolean(exc?.is_closed);

    if (isClosed) {
      return {
        date: dateStr,
        isClosed: true,
        closedReason: exc?.reason || 'Clinic closed on this date',
        periods: [],
      };
    }

    const periods = periodsRes.rows.map((p) => {
      const periodId = Number(p.period_id);
      const key = `${dateStr}:${periodId}`;
      const reservedSet = unavailableMap.get(key) || new Set();

      const availableBeds = reservableBeds.filter((bed) => {
        if (reservedSet.has(bed.bedId)) return false;
        if (dateStr === todayStr && occupiedTodayBeds.has(bed.bedId)) {
          return false;
        }
        return true;
      });

      const reservedTicketsCount = totalReservableBeds - availableBeds.length;

      return {
        periodId,
        code: p.code,
        name: isAr ? p.name_ar : p.name_en,
        startTime: p.start_time,
        endTime: p.end_time,
        totalTickets: totalReservableBeds,
        reservedTickets: reservedTicketsCount,
        availableTickets: availableBeds.length,
        availableBeds: availableBeds.map((b) => ({
          bedId: b.bedId,
          label: b.label,
          clinicNumber: b.clinicNumber,
        })),
      };
    });

    return {
      date: dateStr,
      isClosed: false,
      closedReason: null,
      periods,
    };
  });

  return {
    departmentId: Number(dept.department_id),
    departmentCode: dept.code,
    departmentName: isAr ? dept.name_ar : dept.name_en,
    totalReservableBeds,
    fromDate: fromDateStr,
    toDate: toDateStr,
    days,
  };
}

// =============================================================================
// 4. POST /api/v1/cases/:caseId/schedule-bed (Path B — Reserve Future Ticket, §3.4.3B)
// =============================================================================

/**
 * Internal reusable transactional helper that executes Path B future bed ticket reservation (§3.4.3B).
 * Can be called standalone by `POST /cases/:caseId/schedule-bed` or inline by `POST /cases/:caseId/outcome`.
 *
 * @param {import('pg').PoolClient} client
 * @param {(fn: () => Promise<void> | void) => void} afterCommit
 * @param {{
 *   caseRow: any,
 *   doctorId: number,
 *   doctorName: string,
 *   patientName: string,
 *   scheduleInput: {
 *     serviceDate: string,
 *     periodId: number,
 *     plannedStartTime: string,
 *     bedId?: number | null,
 *     notes?: string | null,
 *     rescheduledFromId?: number | null
 *   },
 *   settings: Awaited<ReturnType<typeof loadBedSettings>>,
 *   req?: import('express').Request
 * }} params
 */
export async function scheduleBedTicketInTx(
  client,
  afterCommit,
  { caseRow, doctorId, doctorName, patientName, scheduleInput, settings, req }
) {
  const {
    serviceDate,
    periodId,
    plannedStartTime,
    bedId: requestedBedId,
    notes,
    rescheduledFromId = null,
  } = scheduleInput;

  const caseId = Number(caseRow.case_id);
  const patientId = Number(caseRow.patient_id);
  const departmentId = Number(caseRow.department_id);
  const oldStatus = caseRow.status;

  // 1) Verify period exists & is active, and plannedStartTime falls within period [start_time, end_time)
  const periodRes = await client.query(
    `SELECT
       period_id,
       code,
       name_en,
       name_ar,
       start_time::TEXT AS start_time,
       end_time::TEXT AS end_time,
       ($2::TIME >= start_time AND $2::TIME < end_time) AS time_in_period,
       (($3::DATE + $2::TIME) AT TIME ZONE $4) AS planned_start_at,
       ($3::DATE < (now() AT TIME ZONE $4)::DATE) AS is_past_date,
       ((($3::DATE + $2::TIME) AT TIME ZONE $4) <= now()) AS is_past_timestamp
     FROM bed_ticket_periods
     WHERE period_id = $1
       AND is_active = TRUE
     LIMIT 1`,
    [periodId, plannedStartTime, serviceDate, settings.hospitalTimezone]
  );

  if (periodRes.rows.length === 0) {
    throw new AppError(
      404,
      'PERIOD_NOT_FOUND',
      `Bed ticket period ${periodId} was not found or is inactive.`
    );
  }

  const periodRow = periodRes.rows[0];
  if (periodRow.is_past_date || periodRow.is_past_timestamp) {
    throw new AppError(
      422,
      'PAST_SCHEDULE_TIME',
      'Cannot schedule a bed ticket in the past.'
    );
  }

  if (!periodRow.time_in_period) {
    throw new AppError(
      422,
      'TIME_OUTSIDE_PERIOD_RANGE',
      `plannedStartTime (${plannedStartTime}) must fall within period ${periodRow.code} (${periodRow.start_time} - ${periodRow.end_time}).`
    );
  }

  const plannedStartAt = periodRow.planned_start_at;

  // 2) Check calendar_exceptions for HOSPITAL or DEPARTMENT closure on serviceDate
  const excRes = await client.query(
    `SELECT exception_id, scope, is_closed, reason
     FROM calendar_exceptions
     WHERE exception_date = $1::DATE
       AND (
         scope = 'HOSPITAL'
         OR (scope = 'DEPARTMENT' AND department_id = $2)
       )
       AND is_closed = TRUE
     LIMIT 1`,
    [serviceDate, departmentId]
  );

  if (excRes.rows.length > 0) {
    throw new AppError(
      422,
      'CLINIC_CLOSED_ON_DATE',
      `Clinic is closed on ${serviceDate}${excRes.rows[0].reason ? `: ${excRes.rows[0].reason}` : ''}.`
    );
  }

  // 3) Check doctor / patient exact timestamp collision (`uq_bt_doctor_planned_start` & `uq_bt_patient_planned_start`)
  const docConflictRes = await client.query(
    `SELECT ticket_id, case_id
     FROM bed_tickets
     WHERE doctor_id = $1
       AND status = 'RESERVED'
       AND planned_start_at = $2
     LIMIT 1`,
    [doctorId, plannedStartAt]
  );
  if (docConflictRes.rows.length > 0) {
    throw new AppError(
      409,
      'DOCTOR_SCHEDULE_CONFLICT',
      `You already have another patient scheduled at the exact same time (${serviceDate} ${plannedStartTime}). You may schedule another patient at a different time in the same shift (e.g., 1 hour later).`
    );
  }

  const patConflictRes = await client.query(
    `SELECT ticket_id, case_id
     FROM bed_tickets
     WHERE patient_id = $1
       AND status = 'RESERVED'
       AND planned_start_at = $2
     LIMIT 1`,
    [patientId, plannedStartAt]
  );
  if (patConflictRes.rows.length > 0) {
    throw new AppError(
      409,
      'PATIENT_SCHEDULE_CONFLICT',
      `This patient already has another reservation at ${serviceDate} ${plannedStartTime}.`
    );
  }

  // 4) Lock target clinic_bed (Option 1: explicit bedId with FOR UPDATE NOWAIT; Option 2: auto-pick with FOR UPDATE SKIP LOCKED)
  let selectedBed;
  if (requestedBedId) {
    const bedRes = await client.query(
      `SELECT
         b.bed_id,
         b.label,
         b.bed_number,
         b.operational_status,
         b.is_reservable,
         c.clinic_id,
         c.clinic_number,
         c.department_id AS bed_department_id,
         c.is_active AS clinic_is_active
       FROM clinic_beds b
       JOIN clinics c ON c.clinic_id = b.clinic_id
       WHERE b.bed_id = $1
       FOR UPDATE OF b NOWAIT`,
      [requestedBedId]
    );

    if (bedRes.rows.length === 0) {
      throw new AppError(
        404,
        'BED_NOT_FOUND',
        `Clinic bed ${requestedBedId} was not found.`
      );
    }

    const bRow = bedRes.rows[0];
    if (
      bRow.operational_status !== 'ACTIVE' ||
      !bRow.is_reservable ||
      !bRow.clinic_is_active
    ) {
      throw new AppError(
        409,
        'BED_NOT_RESERVABLE',
        `Bed ${bRow.label} is not currently active or reservable.`
      );
    }

    if (Number(bRow.bed_department_id) !== departmentId) {
      throw new AppError(
        422,
        'BED_DEPARTMENT_MISMATCH',
        `Bed ${bRow.label} does not belong to department ${departmentId}.`
      );
    }

    const existingRes = await client.query(
      `SELECT ticket_id
       FROM bed_tickets
       WHERE bed_id = $1
         AND service_date = $2::DATE
         AND period_id = $3
         AND status = 'RESERVED'
       LIMIT 1`,
      [requestedBedId, serviceDate, periodId]
    );

    if (existingRes.rows.length > 0) {
      throw new AppError(
        409,
        'BED_ALREADY_RESERVED_FOR_PERIOD',
        `Bed ${bRow.label} is already reserved for ${serviceDate} (${periodRow.code}).`
      );
    }

    selectedBed = bRow;
  } else {
    // §3.4.3B Option 2: Auto-pick & lock one free reservable bed in the department using FOR UPDATE OF b SKIP LOCKED
    const autoBedRes = await client.query(
      `SELECT
         b.bed_id,
         b.label,
         b.bed_number,
         c.clinic_id,
         c.clinic_number
       FROM clinic_beds b
       JOIN clinics c ON c.clinic_id = b.clinic_id
       WHERE c.department_id = $1
         AND c.is_active = TRUE
         AND b.operational_status = 'ACTIVE'
         AND b.is_reservable = TRUE
         AND NOT EXISTS (
           SELECT 1
           FROM bed_tickets bt
           WHERE bt.bed_id = b.bed_id
             AND bt.service_date = $2::DATE
             AND bt.period_id = $3
             AND bt.status = 'RESERVED'
         )
         AND (
           $2::DATE > CURRENT_DATE
           OR NOT EXISTS (
             SELECT 1
             FROM bed_tickets bt2
             WHERE bt2.bed_id = b.bed_id
               AND bt2.status = 'OCCUPIED'
           )
         )
       ORDER BY c.clinic_number ASC, b.bed_number ASC
       LIMIT 1
       FOR UPDATE OF b SKIP LOCKED`,
      [departmentId, serviceDate, periodId]
    );

    if (autoBedRes.rows.length === 0) {
      throw new AppError(
        409,
        'NO_TICKETS_AVAILABLE_FOR_PERIOD',
        `All reservable bed tickets in this department are booked for ${serviceDate} (${periodRow.code}). Please choose another period or date.`
      );
    }

    selectedBed = autoBedRes.rows[0];
  }

  const finalBedId = Number(selectedBed.bed_id);

  // Compute next session_no for this case
  const maxSessionRes = await client.query(
    `SELECT COALESCE(MAX(session_no), 0)::INT AS max_session
     FROM appointments
     WHERE case_id = $1`,
    [caseId]
  );
  const nextSessionNo =
    Math.max(Number(caseRow.total_sessions || 0), Number(maxSessionRes.rows[0].max_session)) + 1;

  // 5) Insert appointments (path = 'SCHEDULED', status = 'SCHEDULED')
  const apptRes = await client.query(
    `INSERT INTO appointments (
       case_id,
       session_no,
       doctor_id,
       patient_id,
       department_id,
       path,
       appointment_date,
       period_id,
       planned_start_at,
       status,
       session_notes,
       rescheduled_from_id,
       created_by
     )
     VALUES (
       $1, $2, $3, $4, $5,
       'SCHEDULED', $6::DATE, $7, $8,
       'SCHEDULED', $9, $10, $3
     )
     RETURNING appointment_id, session_no, appointment_date::TEXT AS appointment_date, planned_start_at, status`,
    [
      caseId,
      nextSessionNo,
      doctorId,
      patientId,
      departmentId,
      serviceDate,
      periodId,
      plannedStartAt,
      notes || null,
      rescheduledFromId,
    ]
  );
  const apptRow = apptRes.rows[0];
  const appointmentId = Number(apptRow.appointment_id);

  // 6) Insert bed_tickets (ticket_type = 'SCHEDULED', status = 'RESERVED', reserved_at = now())
  const cleanBedCode = String(selectedBed.label).replace(/[^A-Za-z0-9]/g, '');
  const periodPrefix = String(periodRow.code).slice(0, 3).toUpperCase();
  const compactDate = serviceDate.replace(/-/g, '');
  const ticketCode = `BT-${compactDate}-${cleanBedCode}-${periodPrefix}-${appointmentId}`;

  const ticketRes = await client.query(
    `INSERT INTO bed_tickets (
       ticket_code,
       ticket_type,
       status,
       bed_id,
       department_id,
       appointment_id,
       case_id,
       doctor_id,
       patient_id,
       service_date,
       period_id,
       planned_start_at,
       reserved_at,
       created_by
     )
     VALUES (
       $1, 'SCHEDULED', 'RESERVED', $2, $3,
       $4, $5, $6, $7,
       $8::DATE, $9, $10, now(), $6
     )
     RETURNING ticket_id, ticket_code, reserved_at, planned_start_at`,
    [
      ticketCode,
      finalBedId,
      departmentId,
      appointmentId,
      caseId,
      doctorId,
      patientId,
      serviceDate,
      periodId,
      plannedStartAt,
    ]
  );
  const ticketRow = ticketRes.rows[0];
  const ticketId = Number(ticketRow.ticket_id);

  // 7) Transition cases.status -> 'SCHEDULED'
  if (oldStatus !== 'SCHEDULED') {
    await client.query(
      `UPDATE cases
       SET status = 'SCHEDULED',
           version = version + 1,
           updated_at = now()
       WHERE case_id = $1`,
      [caseId]
    );

    await client.query(
      `INSERT INTO case_status_history (
         case_id,
         from_status,
         to_status,
         changed_by,
         reason,
         metadata
       )
       VALUES ($1, $2, 'SCHEDULED', $3, $4, $5::jsonb)`,
      [
        caseId,
        oldStatus,
        doctorId,
        `Scheduled bed ticket ${ticketRow.ticket_code} for ${serviceDate} (${periodRow.code})`,
        JSON.stringify({
          appointmentId,
          ticketId,
          bedId: finalBedId,
          bedLabel: selectedBed.label,
          serviceDate,
          periodCode: periodRow.code,
          plannedStartTime,
        }),
      ]
    );
  }

  // 8) Insert system message into open chat_conversations (if present) + notify Patient
  const convRes = await client.query(
    `SELECT conversation_id
     FROM chat_conversations
     WHERE case_id = $1 AND status = 'OPEN'
     LIMIT 1`,
    [caseId]
  );

  if (convRes.rows.length > 0) {
    const convId = Number(convRes.rows[0].conversation_id);
    const sysMsgRes = await client.query(
      `INSERT INTO chat_messages (conversation_id, sender_id, message_type, body, metadata)
       VALUES ($1, NULL, 'SYSTEM', $2, $3::jsonb)
       RETURNING message_id, created_at`,
      [
        convId,
        `Appointment scheduled with Dr. ${doctorName} on ${serviceDate} at ${plannedStartTime.slice(0, 5)} (Clinic ${selectedBed.clinic_number}, Bed ${selectedBed.label}).`,
        JSON.stringify({
          appointmentId,
          ticketId,
          serviceDate,
          plannedStartTime,
          clinicNumber: selectedBed.clinic_number,
          bedLabel: selectedBed.label,
        }),
      ]
    );
    await client.query(
      `UPDATE chat_conversations
       SET last_message_id = $2,
           last_message_at = $3
       WHERE conversation_id = $1`,
      [convId, sysMsgRes.rows[0].message_id, sysMsgRes.rows[0].created_at]
    );
  }

  const dashboardLogLine = buildBedDashboardLogLine({
    bedLabel: selectedBed.label,
    doctorName,
    patientName,
    timestamp: plannedStartAt,
    timezone: settings.hospitalTimezone,
  });

  await createNotification(client, {
    userId: patientId,
    type: 'APPOINTMENT_SCHEDULED',
    title: 'Treatment Appointment Scheduled',
    body: `Dr. ${doctorName} scheduled your session on ${serviceDate} at ${plannedStartTime.slice(0, 5)} in Clinic ${selectedBed.clinic_number} (Bed ${selectedBed.label}).`,
    caseId,
    data: {
      caseId,
      caseNumber: caseRow.case_number,
      appointmentId,
      sessionNo: nextSessionNo,
      serviceDate,
      periodId,
      periodCode: periodRow.code,
      plannedStartTime,
      plannedStartAt,
      bedId: finalBedId,
      bedLabel: selectedBed.label,
      clinicNumber: selectedBed.clinic_number,
      ticketId,
      ticketCode: ticketRow.ticket_code,
    },
  });

  await writeAuditLog(client, {
    actorUserId: doctorId,
    actorRole: 'DOCTOR',
    action: 'BED_TICKET_SCHEDULED',
    entityType: 'bed_tickets',
    entityId: ticketId,
    afterData: {
      ticketId,
      ticketCode: ticketRow.ticket_code,
      appointmentId,
      caseId,
      bedId: finalBedId,
      bedLabel: selectedBed.label,
      serviceDate,
      periodCode: periodRow.code,
      plannedStartAt,
    },
    req,
  });

  // 9) Post-commit real-time events
  afterCommit(async () => {
    emitToRooms(
      [`dept:${departmentId}:beds`, 'admin:dashboard'],
      'beds.calendar_updated',
      {
        departmentId,
        serviceDate,
        periodId,
        periodCode: periodRow.code,
        bedId: finalBedId,
        bedLabel: selectedBed.label,
        clinicNumber: selectedBed.clinic_number,
        ticketId,
        ticketCode: ticketRow.ticket_code,
        status: 'RESERVED',
        plannedStartAt,
        dashboardLogLine,
      }
    );

    emitToRooms(
      [`user:${patientId}`, `case:${caseId}`],
      'case.appointment_scheduled',
      {
        caseId,
        caseNumber: caseRow.case_number,
        caseStatus: 'SCHEDULED',
        appointment: {
          appointmentId,
          sessionNo: nextSessionNo,
          path: 'SCHEDULED',
          appointmentDate: serviceDate,
          periodId,
          periodCode: periodRow.code,
          plannedStartAt,
          status: 'SCHEDULED',
        },
        ticket: {
          ticketId,
          ticketCode: ticketRow.ticket_code,
          ticketType: 'SCHEDULED',
          status: 'RESERVED',
          bedId: finalBedId,
          bedLabel: selectedBed.label,
          clinicNumber: selectedBed.clinic_number,
        },
        doctor: {
          doctorId,
          fullName: doctorName,
        },
      }
    );
  });

  return {
    caseId,
    caseNumber: caseRow.case_number,
    caseStatus: 'SCHEDULED',
    appointment: {
      appointmentId,
      sessionNo: nextSessionNo,
      path: 'SCHEDULED',
      appointmentDate: serviceDate,
      periodId,
      periodCode: periodRow.code,
      plannedStartAt,
      status: 'SCHEDULED',
    },
    ticket: {
      ticketId,
      ticketCode: ticketRow.ticket_code,
      ticketType: 'SCHEDULED',
      status: 'RESERVED',
      bedId: finalBedId,
      bedLabel: selectedBed.label,
      clinicNumber: selectedBed.clinic_number,
      reservedAt: ticketRow.reserved_at,
    },
  };
}

/**
 * Public service method for `POST /api/v1/cases/:caseId/schedule-bed` (§4.5).
 *
 * @param {number} caseId
 * @param {number} doctorId
 * @param {import('z').infer<typeof scheduleBedSchema>} payload
 * @param {import('express').Request} req
 */
export async function scheduleFutureBedForCase(caseId, doctorId, payload, req) {
  return withTransaction(
    async (client, afterCommit) => {
      const settings = await loadBedSettings(client);

      // 1) Lock student_doctor_profiles (FOR UPDATE)
      const docRes = await client.query(
        `SELECT d.doctor_id, u.full_name AS doctor_name, u.account_status
         FROM student_doctor_profiles d
         JOIN users u ON u.user_id = d.doctor_id
         WHERE d.doctor_id = $1
         FOR UPDATE`,
        [doctorId]
      );

      if (docRes.rows.length === 0) {
        throw new AppError(404, 'DOCTOR_NOT_FOUND', 'Doctor profile not found.');
      }

      const doctorRow = docRes.rows[0];
      if (doctorRow.account_status !== 'ACTIVE') {
        throw new AppError(
          403,
          'DOCTOR_ACCOUNT_NOT_ACTIVE',
          'Your doctor account must be ACTIVE to schedule a clinic bed.'
        );
      }

      // 2) Lock cases (FOR UPDATE NOWAIT)
      const caseRes = await client.query(
        `SELECT
           c.case_id,
           c.case_number,
           c.patient_id,
           c.department_id,
           c.assigned_doctor_id,
           c.status,
           c.total_sessions,
           pu.full_name AS patient_name
         FROM cases c
         JOIN users pu ON pu.user_id = c.patient_id
         WHERE c.case_id = $1
         FOR UPDATE OF c NOWAIT`,
        [caseId]
      );

      if (caseRes.rows.length === 0) {
        throw new AppError(404, 'CASE_NOT_FOUND', `Case ${caseId} was not found.`);
      }

      const caseRow = caseRes.rows[0];
      if (Number(caseRow.assigned_doctor_id) !== Number(doctorId)) {
        throw new AppError(
          403,
          'NOT_CASE_DOCTOR',
          'Only the doctor assigned to this case can schedule a bed ticket for it.'
        );
      }

      if (!['CLAIMED', 'NEEDS_FOLLOW_UP'].includes(caseRow.status)) {
        throw new AppError(
          422,
          'INVALID_CASE_STATE',
          `Case must be in 'CLAIMED' or 'NEEDS_FOLLOW_UP' status to schedule a bed ticket (current status: '${caseRow.status}').`
        );
      }

      return scheduleBedTicketInTx(client, afterCommit, {
        caseRow,
        doctorId,
        doctorName: doctorRow.doctor_name,
        patientName: caseRow.patient_name,
        scheduleInput: payload,
        settings,
        req,
      });
    },
    { resourceHint: 'BED' }
  );
}

// =============================================================================
// 5. POST /api/v1/appointments/:appointmentId/start-session (§3.4.3C Bed-Swap)
// =============================================================================

/**
 * Starts a scheduled treatment session on the day of the appointment (`RESERVED -> OCCUPIED`).
 * Implements the §3.4.3C Automatic Bed-Swap fallback (`swapped_from_bed_id`) if the
 * originally reserved bed is still occupied by an overrunning live session or out of service.
 *
 * @param {number} appointmentId
 * @param {{ userId: number, role: string }} actor
 * @param {import('z').infer<typeof startSessionSchema>} payload
 * @param {import('express').Request} req
 */
export async function startScheduledAppointmentSession(
  appointmentId,
  actor,
  payload,
  req
) {
  return withTransaction(
    async (client, afterCommit) => {
      const settings = await loadBedSettings(client);

      // Fetch appointment & case IDs first so we lock in canonical hierarchy order:
      // 1. student_doctor_profiles -> 2. cases -> 3. appointments -> 4. clinic_beds -> 5. bed_tickets
      const lookupRes = await client.query(
        `SELECT appointment_id, case_id, doctor_id, patient_id, department_id
         FROM appointments
         WHERE appointment_id = $1
         LIMIT 1`,
        [appointmentId]
      );

      if (lookupRes.rows.length === 0) {
        throw new AppError(
          404,
          'APPOINTMENT_NOT_FOUND',
          `Appointment ${appointmentId} was not found.`
        );
      }

      const {
        case_id: caseIdRaw,
        doctor_id: apptDoctorIdRaw,
      } = lookupRes.rows[0];
      const caseId = Number(caseIdRaw);
      const doctorId = Number(apptDoctorIdRaw);

      if (actor.role === 'DOCTOR' && Number(actor.userId) !== doctorId) {
        throw new AppError(
          403,
          'NOT_APPOINTMENT_DOCTOR',
          'Only the assigned doctor (or an admin) can start this scheduled session.'
        );
      }

      // 1) Lock Doctor profile
      const docRes = await client.query(
        `SELECT d.doctor_id, u.full_name AS doctor_name
         FROM student_doctor_profiles d
         JOIN users u ON u.user_id = d.doctor_id
         WHERE d.doctor_id = $1
         FOR UPDATE`,
        [doctorId]
      );
      const doctorName = docRes.rows[0]?.doctor_name || 'Doctor';

      // Verify doctor is not currently occupying another bed
      const docOccRes = await client.query(
        `SELECT ticket_id, bed_id
         FROM bed_tickets
         WHERE doctor_id = $1 AND status = 'OCCUPIED'
         LIMIT 1`,
        [doctorId]
      );
      if (docOccRes.rows.length > 0) {
        throw new AppError(
          409,
          'DOCTOR_ALREADY_OCCUPYING_BED',
          'Doctor is already occupying an active clinic bed. Free that bed first.'
        );
      }

      // 2) Lock Case
      const caseRes = await client.query(
        `SELECT
           c.case_id,
           c.case_number,
           c.patient_id,
           c.department_id,
           c.status,
           c.total_sessions,
           pu.full_name AS patient_name
         FROM cases c
         JOIN users pu ON pu.user_id = c.patient_id
         WHERE c.case_id = $1
         FOR UPDATE OF c NOWAIT`,
        [caseId]
      );
      const caseRow = caseRes.rows[0];
      const patientId = Number(caseRow.patient_id);
      const departmentId = Number(caseRow.department_id);

      // 3) Lock Appointment
      const apptRes = await client.query(
        `SELECT
           appointment_id,
           session_no,
           appointment_date::TEXT AS appointment_date,
           period_id,
           planned_start_at,
           status
         FROM appointments
         WHERE appointment_id = $1
         FOR UPDATE NOWAIT`,
        [appointmentId]
      );
      const apptRow = apptRes.rows[0];

      if (apptRow.status !== 'SCHEDULED') {
        throw new AppError(
          409,
          'APPOINTMENT_NOT_SCHEDULED',
          `Appointment ${appointmentId} cannot be started because its status is '${apptRow.status}'.`
        );
      }

      // 4) Find the RESERVED bed ticket for this appointment
      const ticketLookupRes = await client.query(
        `SELECT ticket_id, ticket_code, bed_id, status
         FROM bed_tickets
         WHERE appointment_id = $1
         FOR UPDATE NOWAIT`,
        [appointmentId]
      );

      if (
        ticketLookupRes.rows.length === 0 ||
        ticketLookupRes.rows[0].status !== 'RESERVED'
      ) {
        throw new AppError(
          409,
          'RESERVED_TICKET_NOT_FOUND',
          'No active RESERVED bed ticket was found for this appointment.'
        );
      }

      const ticketRow = ticketLookupRes.rows[0];
      const ticketId = Number(ticketRow.ticket_id);
      const originalBedId = Number(ticketRow.bed_id);

      // 5) Lock the originally reserved bed B1 (and check if preferredBedId was requested or if B1 is occupied)
      const origBedRes = await client.query(
        `SELECT
           b.bed_id,
           b.label,
           b.bed_number,
           b.operational_status,
           c.clinic_id,
           c.clinic_number,
           c.department_id,
           EXISTS (
             SELECT 1 FROM bed_tickets bt
             WHERE bt.bed_id = b.bed_id AND bt.status = 'OCCUPIED'
           ) AS is_currently_occupied
         FROM clinic_beds b
         JOIN clinics c ON c.clinic_id = b.clinic_id
         WHERE b.bed_id = $1
         FOR UPDATE OF b`,
        [originalBedId]
      );

      const origBed = origBedRes.rows[0];
      let finalBed = origBed;
      let swappedFromBedId = null;

      const requestedOverrideBedId = payload?.preferredBedId
        ? Number(payload.preferredBedId)
        : null;

      const needsSwap =
        origBed.operational_status !== 'ACTIVE' ||
        Boolean(origBed.is_currently_occupied) ||
        (requestedOverrideBedId !== null &&
          requestedOverrideBedId !== originalBedId);

      if (needsSwap) {
        if (
          requestedOverrideBedId !== null &&
          requestedOverrideBedId !== originalBedId
        ) {
          // Doctor explicitly requested a specific replacement bed
          const prefRes = await client.query(
            `SELECT
               b.bed_id,
               b.label,
               b.bed_number,
               b.operational_status,
               c.clinic_id,
               c.clinic_number,
               c.department_id,
               EXISTS (
                 SELECT 1 FROM bed_tickets bt
                 WHERE bt.bed_id = b.bed_id
                   AND (
                     bt.status = 'OCCUPIED'
                     OR (
                       bt.status = 'RESERVED'
                       AND bt.ticket_id <> $2
                       AND bt.service_date = CURRENT_DATE
                       AND now() >= (bt.planned_start_at - ($3 || ' minutes')::INTERVAL)
                     )
                   )
               ) AS is_unavailable
             FROM clinic_beds b
             JOIN clinics c ON c.clinic_id = b.clinic_id
             WHERE b.bed_id = $1
             FOR UPDATE OF b NOWAIT`,
            [
              requestedOverrideBedId,
              ticketId,
              String(settings.reservationProtectMinutes),
            ]
          );

          if (
            prefRes.rows.length === 0 ||
            prefRes.rows[0].operational_status !== 'ACTIVE' ||
            Number(prefRes.rows[0].department_id) !== departmentId ||
            prefRes.rows[0].is_unavailable
          ) {
            throw new AppError(
              409,
              'PREFERRED_BED_UNAVAILABLE',
              'The requested replacement bed is not available in this department.'
            );
          }

          finalBed = prefRes.rows[0];
          swappedFromBedId = originalBedId;
        } else {
          // §3.4.3C Automatic Bed-Swap Fallback: find and lock another free bed B2 in the same department
          const swapRes = await client.query(
            `SELECT
               b.bed_id,
               b.label,
               b.bed_number,
               c.clinic_id,
               c.clinic_number
             FROM clinic_beds b
             JOIN clinics c ON c.clinic_id = b.clinic_id
             WHERE c.department_id = $1
               AND c.is_active = TRUE
               AND b.operational_status = 'ACTIVE'
               AND b.bed_id <> $2
               AND NOT EXISTS (
                 SELECT 1
                 FROM bed_tickets bt
                 WHERE bt.bed_id = b.bed_id
                   AND (
                     bt.status = 'OCCUPIED'
                     OR (
                       bt.status = 'RESERVED'
                       AND bt.ticket_id <> $3
                       AND bt.service_date = CURRENT_DATE
                       AND now() >= (bt.planned_start_at - ($4 || ' minutes')::INTERVAL)
                     )
                   )
               )
             ORDER BY c.clinic_number ASC, b.bed_number ASC
             LIMIT 1
             FOR UPDATE OF b SKIP LOCKED`,
            [
              departmentId,
              originalBedId,
              ticketId,
              String(settings.reservationProtectMinutes),
            ]
          );

          if (swapRes.rows.length === 0) {
            throw new AppError(
              409,
              'NO_FREE_BED_FOR_SWAP',
              `Originally reserved bed ${origBed.label} is still occupied, and no other free bed is currently available in this department for automatic swap.`
            );
          }

          finalBed = swapRes.rows[0];
          swappedFromBedId = originalBedId;
        }
      }

      const finalBedId = Number(finalBed.bed_id);

      // 6) Update bed_tickets -> status = 'OCCUPIED', occupied_at = now(), swapped_from_bed_id
      const updTicketRes = await client.query(
        `UPDATE bed_tickets
         SET status = 'OCCUPIED',
             bed_id = $2,
             swapped_from_bed_id = $3,
             occupied_at = now(),
             version = version + 1,
             updated_at = now()
         WHERE ticket_id = $1
         RETURNING occupied_at`,
        [ticketId, finalBedId, swappedFromBedId]
      );
      const occupiedAt = updTicketRes.rows[0].occupied_at;

      // 7) Update appointments -> status = 'IN_PROGRESS', started_at = now()
      await client.query(
        `UPDATE appointments
         SET status = 'IN_PROGRESS',
             checked_in_at = COALESCE(checked_in_at, now()),
             started_at = now(),
             session_notes = COALESCE($2, session_notes),
             updated_at = now()
         WHERE appointment_id = $1`,
        [appointmentId, payload?.notes || null]
      );

      // 8) Transition cases -> status = 'IN_TREATMENT', total_sessions = total_sessions + 1
      await client.query(
        `UPDATE cases
         SET status = 'IN_TREATMENT',
             total_sessions = total_sessions + 1,
             version = version + 1,
             updated_at = now()
         WHERE case_id = $1`,
        [caseId]
      );

      await client.query(
        `INSERT INTO case_status_history (
           case_id,
           from_status,
           to_status,
           changed_by,
           reason,
           metadata
         )
         VALUES ($1, $2, 'IN_TREATMENT', $3, $4, $5::jsonb)`,
        [
          caseId,
          caseRow.status,
          actor.userId,
          swappedFromBedId
            ? `Started scheduled session on Bed ${finalBed.label} (auto-swapped from ${origBed.label})`
            : `Started scheduled session on reserved Bed ${finalBed.label}`,
          JSON.stringify({
            appointmentId,
            ticketId,
            bedId: finalBedId,
            bedLabel: finalBed.label,
            swappedFromBedId,
            swappedFromBedLabel: swappedFromBedId ? origBed.label : null,
          }),
        ]
      );

      const dashboardLogLine = buildBedDashboardLogLine({
        bedLabel: finalBed.label,
        doctorName,
        patientName: caseRow.patient_name,
        timestamp: occupiedAt,
        timezone: settings.hospitalTimezone,
      });

      await createNotification(client, {
        userId: patientId,
        type: 'BED_ASSIGNED_LIVE',
        title: swappedFromBedId
          ? 'Session Started (Bed Updated)'
          : 'Your Treatment Session Has Started',
        body: swappedFromBedId
          ? `Dr. ${doctorName} started your session at Clinic ${finalBed.clinic_number} / Bed ${finalBed.label} (moved from Bed ${origBed.label}).`
          : `Dr. ${doctorName} started your scheduled session at Clinic ${finalBed.clinic_number} / Bed ${finalBed.label}.`,
        caseId,
        data: {
          caseId,
          caseNumber: caseRow.case_number,
          appointmentId,
          ticketId,
          bedId: finalBedId,
          bedLabel: finalBed.label,
          clinicNumber: finalBed.clinic_number,
          swappedFromBedId,
        },
      });

      await writeAuditLog(client, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'SCHEDULED_SESSION_STARTED',
        entityType: 'bed_tickets',
        entityId: ticketId,
        afterData: {
          appointmentId,
          ticketId,
          caseId,
          bedId: finalBedId,
          bedLabel: finalBed.label,
          swappedFromBedId,
          dashboardLogLine,
        },
        req,
      });

      afterCommit(async () => {
        emitToRooms(
          [
            `dept:${departmentId}:beds`,
            'admin:dashboard',
            `user:${patientId}`,
            `case:${caseId}`,
          ],
          'bed.occupied',
          {
            ticketId,
            ticketCode: ticketRow.ticket_code,
            ticketType: 'SCHEDULED',
            bedId: finalBedId,
            bedLabel: finalBed.label,
            clinicNumber: finalBed.clinic_number,
            departmentId,
            liveStatus: 'OCCUPIED',
            occupiedAt,
            swappedFromBedId,
            swappedFromBedLabel: swappedFromBedId ? origBed.label : null,
            doctor: {
              doctorId,
              fullName: doctorName,
            },
            patient: {
              patientId,
              fullName: caseRow.patient_name,
            },
            caseId,
            caseNumber: caseRow.case_number,
            dashboardLogLine,
          }
        );
      });

      return {
        caseId,
        caseNumber: caseRow.case_number,
        caseStatus: 'IN_TREATMENT',
        appointment: {
          appointmentId,
          sessionNo: Number(apptRow.session_no),
          status: 'IN_PROGRESS',
          startedAt: occupiedAt,
        },
        ticket: {
          ticketId,
          ticketCode: ticketRow.ticket_code,
          ticketType: 'SCHEDULED',
          status: 'OCCUPIED',
          bedId: finalBedId,
          bedLabel: finalBed.label,
          clinicNumber: finalBed.clinic_number,
          occupiedAt,
          swappedFromBedId,
          swappedFromBedLabel: swappedFromBedId ? origBed.label : null,
          dashboardLogLine,
        },
      };
    },
    { resourceHint: 'BED' }
  );
}

// =============================================================================
// 6. POST /api/v1/bed-tickets/:ticketId/free (Free Physical Bed — End Occupancy)
// =============================================================================

/**
 * Helper to validate and insert a `completion_reports` row when a case transitions to `FINISHED`.
 * Shared between `POST /bed-tickets/:ticketId/free` and `POST /cases/:caseId/outcome`.
 *
 * @param {import('pg').PoolClient} client
 * @param {{
 *   caseId: number,
 *   doctorId: number,
 *   totalSessions: number,
 *   reportInput: import('z').infer<typeof completionReportInputSchema>,
 *   settings: Awaited<ReturnType<typeof loadBedSettings>>
 * }} params
 */
export async function upsertCompletionReportInTx(
  client,
  { caseId, doctorId, totalSessions, reportInput, settings }
) {
  if (!reportInput || !reportInput.procedureSummary) {
    throw new AppError(
      422,
      'COMPLETION_REPORT_REQUIRED',
      'A completionReport with procedureSummary is required when finishing a case (outcome = FINISHED).'
    );
  }

  if (settings.requireBeforeAfterPhotosOnFinish) {
    const photosRes = await client.query(
      `SELECT DISTINCT photo_type
       FROM case_photos
       WHERE case_id = $1
         AND photo_type IN ('BEFORE', 'AFTER')`,
      [caseId]
    );
    const types = new Set(photosRes.rows.map((r) => r.photo_type));
    if (!types.has('BEFORE') || !types.has('AFTER')) {
      throw new AppError(
        422,
        'BEFORE_AFTER_PHOTOS_REQUIRED',
        'At least one BEFORE photo and one AFTER photo must be uploaded for this case before marking it FINISHED.'
      );
    }
  }

  const reviewStatus = settings.requireSupervisorReportReview
    ? 'PENDING'
    : 'NOT_REQUIRED';

  const effectiveSessions = Math.max(1, Number(totalSessions || 1));

  const reportRes = await client.query(
    `INSERT INTO completion_reports (
       case_id,
       doctor_id,
       final_diagnosis,
       procedure_summary,
       materials_used,
       result,
       total_sessions,
       post_care_instructions,
       review_status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::review_status)
     ON CONFLICT (case_id) DO UPDATE
       SET final_diagnosis = EXCLUDED.final_diagnosis,
           procedure_summary = EXCLUDED.procedure_summary,
           materials_used = EXCLUDED.materials_used,
           result = EXCLUDED.result,
           total_sessions = EXCLUDED.total_sessions,
           post_care_instructions = EXCLUDED.post_care_instructions,
           updated_at = now()
     RETURNING
       report_id,
       case_id,
       doctor_id,
       final_diagnosis,
       procedure_summary,
       materials_used,
       result,
       total_sessions,
       post_care_instructions,
       review_status,
       created_at`,
    [
      caseId,
      doctorId,
      reportInput.finalDiagnosis || null,
      reportInput.procedureSummary,
      reportInput.materialsUsed || null,
      reportInput.result || null,
      effectiveSessions,
      reportInput.postCareInstructions || null,
      reviewStatus,
    ]
  );

  const reportRow = reportRes.rows[0];
  const reportId = Number(reportRow.report_id);

  if (Array.isArray(reportInput.photoIds) && reportInput.photoIds.length > 0) {
    await client.query(
      `UPDATE case_photos
       SET report_id = $1
       WHERE case_id = $2
         AND photo_id = ANY($3::BIGINT[])`,
      [reportId, caseId, reportInput.photoIds]
    );
  } else {
    await client.query(
      `UPDATE case_photos
       SET report_id = $1
       WHERE case_id = $2
         AND report_id IS NULL`,
      [reportId, caseId]
    );
  }

  return {
    reportId,
    caseId: Number(reportRow.case_id),
    doctorId: Number(reportRow.doctor_id),
    finalDiagnosis: reportRow.final_diagnosis,
    procedureSummary: reportRow.procedure_summary,
    materialsUsed: reportRow.materials_used,
    result: reportRow.result,
    totalSessions: Number(reportRow.total_sessions),
    postCareInstructions: reportRow.post_care_instructions,
    reviewStatus: reportRow.review_status,
    createdAt: reportRow.created_at,
  };
}

/**
 * Frees an occupied physical bed (`POST /api/v1/bed-tickets/:ticketId/free`, §4.5).
 * Immediately releases the chair (`status = 'FREED'`, `freed_at = now()`), marks the
 * appointment `COMPLETED`, transitions the case to `AWAITING_OUTCOME`, `NEEDS_FOLLOW_UP`,
 * or `FINISHED`, and broadcasts `bed.freed`.
 *
 * @param {number} ticketId
 * @param {{ userId: number, role: string }} actor
 * @param {import('z').infer<typeof freeBedTicketSchema>} payload
 * @param {import('express').Request} req
 */
export async function freeOccupiedBedTicket(ticketId, actor, payload, req) {
  return withTransaction(
    async (client, afterCommit) => {
      const settings = await loadBedSettings(client);

      const lookupRes = await client.query(
        `SELECT ticket_id, case_id, appointment_id, bed_id, doctor_id, patient_id, department_id
         FROM bed_tickets
         WHERE ticket_id = $1
         LIMIT 1`,
        [ticketId]
      );

      if (lookupRes.rows.length === 0) {
        throw new AppError(
          404,
          'BED_TICKET_NOT_FOUND',
          `Bed ticket ${ticketId} was not found.`
        );
      }

      const {
        case_id: caseIdRaw,
        appointment_id: apptIdRaw,
        bed_id: bedIdRaw,
        doctor_id: docIdRaw,
      } = lookupRes.rows[0];
      const caseId = Number(caseIdRaw);
      const appointmentId = Number(apptIdRaw);
      const bedId = Number(bedIdRaw);
      const ticketDoctorId = Number(docIdRaw);

      if (actor.role === 'DOCTOR' && Number(actor.userId) !== ticketDoctorId) {
        throw new AppError(
          403,
          'NOT_TICKET_DOCTOR',
          'Only the doctor occupying this bed (or an admin) can free it.'
        );
      }

      // Lock in canonical hierarchy order: cases -> appointments -> clinic_beds -> bed_tickets
      const caseRes = await client.query(
        `SELECT case_id, case_number, patient_id, department_id, status, total_sessions
         FROM cases
         WHERE case_id = $1
         FOR UPDATE NOWAIT`,
        [caseId]
      );
      const caseRow = caseRes.rows[0];
      const patientId = Number(caseRow.patient_id);
      const departmentId = Number(caseRow.department_id);

      await client.query(
        `SELECT appointment_id, status
         FROM appointments
         WHERE appointment_id = $1
         FOR UPDATE NOWAIT`,
        [appointmentId]
      );

      const bedRes = await client.query(
        `SELECT b.bed_id, b.label, c.clinic_number
         FROM clinic_beds b
         JOIN clinics c ON c.clinic_id = b.clinic_id
         WHERE b.bed_id = $1
         FOR UPDATE OF b NOWAIT`,
        [bedId]
      );
      const bedRow = bedRes.rows[0];

      const ticketRes = await client.query(
        `SELECT ticket_id, ticket_code, status, occupied_at
         FROM bed_tickets
         WHERE ticket_id = $1
         FOR UPDATE NOWAIT`,
        [ticketId]
      );
      const ticketRow = ticketRes.rows[0];

      if (ticketRow.status !== 'OCCUPIED') {
        throw new AppError(
          409,
          'BED_TICKET_NOT_OCCUPIED',
          `Bed ticket ${ticketId} cannot be freed because its status is '${ticketRow.status}'.`
        );
      }

      const freeReason =
        actor.role === 'ADMIN' ? 'ADMIN_FORCED' : 'DOCTOR_FINISHED';

      // 1) Update bed_tickets -> FREED
      const updTicketRes = await client.query(
        `UPDATE bed_tickets
         SET status = 'FREED',
             freed_at = now(),
             freed_by = $2,
             free_reason = $3::bed_free_reason,
             version = version + 1,
             updated_at = now()
         WHERE ticket_id = $1
         RETURNING freed_at`,
        [ticketId, actor.userId, freeReason]
      );
      const freedAt = updTicketRes.rows[0].freed_at;

      // 2) Update appointments -> COMPLETED
      const outcomeVal = payload?.outcome || null;
      await client.query(
        `UPDATE appointments
         SET status = 'COMPLETED',
             started_at = COALESCE(started_at, $2),
             ended_at = $3,
             outcome = COALESCE($4::session_outcome, outcome),
             procedure_performed = COALESCE($5, procedure_performed),
             session_notes = COALESCE($6, session_notes),
             next_steps = COALESCE($7, next_steps),
             updated_at = now()
         WHERE appointment_id = $1`,
        [
          appointmentId,
          ticketRow.occupied_at,
          freedAt,
          outcomeVal,
          payload?.procedurePerformed || null,
          payload?.sessionNotes || null,
          payload?.nextSteps || null,
        ]
      );

      // 3) Determine target case status
      let targetCaseStatus = 'AWAITING_OUTCOME';
      let completionReport = null;

      if (outcomeVal === 'NEEDS_FOLLOW_UP') {
        targetCaseStatus = 'NEEDS_FOLLOW_UP';
      } else if (outcomeVal === 'FINISHED') {
        targetCaseStatus = 'FINISHED';
        completionReport = await upsertCompletionReportInTx(client, {
          caseId,
          doctorId: ticketDoctorId,
          totalSessions: Number(caseRow.total_sessions),
          reportInput: payload?.completionReport || {
            procedureSummary:
              payload?.procedurePerformed ||
              payload?.sessionNotes ||
              'Clinical treatment completed.',
          },
          settings,
        });

        await client.query(
          `UPDATE chat_conversations
           SET status = 'READ_ONLY',
               read_only_at = now()
           WHERE case_id = $1
             AND status = 'OPEN'`,
          [caseId]
        );
      }

      if (caseRow.status !== targetCaseStatus) {
        await client.query(
          `UPDATE cases
           SET status = $2::case_status,
               finished_at = CASE WHEN $2 = 'FINISHED' THEN now() ELSE finished_at END,
               version = version + 1,
               updated_at = now()
           WHERE case_id = $1`,
          [caseId, targetCaseStatus]
        );

        await client.query(
          `INSERT INTO case_status_history (
             case_id,
             from_status,
             to_status,
             changed_by,
             reason,
             metadata
           )
           VALUES ($1, $2, $3::case_status, $4, $5, $6::jsonb)`,
          [
            caseId,
            caseRow.status,
            targetCaseStatus,
            actor.userId,
            `Freed physical clinic bed ${bedRow.label} (${freeReason})`,
            JSON.stringify({
              ticketId,
              appointmentId,
              bedId,
              bedLabel: bedRow.label,
              freeReason,
              outcome: outcomeVal,
            }),
          ]
        );
      }

      if (targetCaseStatus === 'NEEDS_FOLLOW_UP') {
        await createNotification(client, {
          userId: patientId,
          type: 'FOLLOW_UP_REQUIRED',
          title: 'Session Completed — Follow-Up Required',
          body: `Your treatment session for case ${caseRow.case_number} is complete. Your doctor will schedule a follow-up visit.`,
          caseId,
          data: {
            caseId,
            caseNumber: caseRow.case_number,
            appointmentId,
            nextSteps: payload?.nextSteps || null,
          },
        });
      } else if (targetCaseStatus === 'FINISHED') {
        await createNotification(client, {
          userId: patientId,
          type: 'CASE_FINISHED',
          title: 'Treatment Completed!',
          body: `Your dental treatment for case ${caseRow.case_number} is now complete. You can view your summary and rate your visit.`,
          caseId,
          data: {
            caseId,
            caseNumber: caseRow.case_number,
            reportId: completionReport?.reportId || null,
          },
        });
      }

      // Check derived live_status of the bed now that it is freed
      const liveBoardRes = await client.query(
        `SELECT live_status, next_reservation_at
         FROM v_bed_live_board
         WHERE bed_id = $1
         LIMIT 1`,
        [bedId]
      );
      const bedLiveStatus = liveBoardRes.rows[0]?.live_status || 'FREE';

      await writeAuditLog(client, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'BED_TICKET_FREED',
        entityType: 'bed_tickets',
        entityId: ticketId,
        afterData: {
          ticketId,
          bedId,
          bedLabel: bedRow.label,
          freedAt,
          freeReason,
          caseId,
          caseStatus: targetCaseStatus,
        },
        req,
      });

      afterCommit(async () => {
        emitToRooms(
          [
            `dept:${departmentId}:beds`,
            'admin:dashboard',
            `user:${patientId}`,
            `case:${caseId}`,
          ],
          'bed.freed',
          {
            ticketId,
            ticketCode: ticketRow.ticket_code,
            bedId,
            bedLabel: bedRow.label,
            clinicNumber: bedRow.clinic_number,
            departmentId,
            liveStatus: bedLiveStatus,
            freedAt,
            freeReason,
            caseId,
            caseNumber: caseRow.case_number,
            caseStatus: targetCaseStatus,
          }
        );
      });

      return {
        ticketId,
        ticketCode: ticketRow.ticket_code,
        ticketStatus: 'FREED',
        bedId,
        bedLabel: bedRow.label,
        clinicNumber: bedRow.clinic_number,
        bedLiveStatus,
        freedAt,
        freeReason,
        appointmentId,
        appointmentStatus: 'COMPLETED',
        caseId,
        caseNumber: caseRow.case_number,
        caseStatus: targetCaseStatus,
        completionReport,
      };
    },
    { resourceHint: 'BED' }
  );
}

// =============================================================================
// 7. Cancel & Reschedule Scheduled Appointments (§3.3.2 & §4.5)
// =============================================================================

/**
 * Cancels a `SCHEDULED` appointment and its `RESERVED` bed ticket, returning the
 * case status from `SCHEDULED` back to `CLAIMED` (if `total_sessions = 0`) or
 * `NEEDS_FOLLOW_UP` (if `total_sessions > 0`) so the doctor retains ownership and can reschedule.
 *
 * @param {number} appointmentId
 * @param {{ userId: number, role: string }} actor
 * @param {import('z').infer<typeof cancelAppointmentSchema>} payload
 * @param {import('express').Request} req
 */
export async function cancelScheduledAppointment(
  appointmentId,
  actor,
  payload,
  req
) {
  return withTransaction(
    async (client, afterCommit) => {
      const lookupRes = await client.query(
        `SELECT appointment_id, case_id, doctor_id, patient_id, department_id
         FROM appointments
         WHERE appointment_id = $1
         LIMIT 1`,
        [appointmentId]
      );

      if (lookupRes.rows.length === 0) {
        throw new AppError(
          404,
          'APPOINTMENT_NOT_FOUND',
          `Appointment ${appointmentId} was not found.`
        );
      }

      const {
        case_id: caseIdRaw,
        doctor_id: docIdRaw,
        patient_id: patIdRaw,
      } = lookupRes.rows[0];
      const caseId = Number(caseIdRaw);
      const doctorId = Number(docIdRaw);
      const patientId = Number(patIdRaw);

      if (
        actor.role === 'DOCTOR' &&
        Number(actor.userId) !== doctorId
      ) {
        throw new AppError(
          403,
          'NOT_APPOINTMENT_DOCTOR',
          'Only the assigned doctor, the patient, or an admin can cancel this appointment.'
        );
      }
      if (
        actor.role === 'PATIENT' &&
        Number(actor.userId) !== patientId
      ) {
        throw new AppError(
          403,
          'NOT_APPOINTMENT_PATIENT',
          'You can only cancel your own appointments.'
        );
      }

      const caseRes = await client.query(
        `SELECT case_id, case_number, department_id, status, total_sessions
         FROM cases
         WHERE case_id = $1
         FOR UPDATE NOWAIT`,
        [caseId]
      );
      const caseRow = caseRes.rows[0];
      const departmentId = Number(caseRow.department_id);

      const apptRes = await client.query(
        `SELECT appointment_id, status, appointment_date::TEXT AS appointment_date, period_id
         FROM appointments
         WHERE appointment_id = $1
         FOR UPDATE NOWAIT`,
        [appointmentId]
      );
      const apptRow = apptRes.rows[0];

      if (apptRow.status !== 'SCHEDULED') {
        throw new AppError(
          409,
          'APPOINTMENT_NOT_SCHEDULED',
          `Only SCHEDULED appointments can be cancelled (current status: '${apptRow.status}').`
        );
      }

      await client.query(
        `UPDATE appointments
         SET status = 'CANCELLED',
             cancel_reason = $2,
             updated_at = now()
         WHERE appointment_id = $1`,
        [appointmentId, payload.reason]
      );

      const ticketRes = await client.query(
        `UPDATE bed_tickets
         SET status = 'CANCELLED',
             cancelled_at = now(),
             cancel_reason = $2,
             version = version + 1,
             updated_at = now()
         WHERE appointment_id = $1
           AND status = 'RESERVED'
         RETURNING ticket_id, ticket_code, bed_id, service_date::TEXT AS service_date, period_id`,
        [appointmentId, payload.reason]
      );
      const cancelledTicket = ticketRes.rows[0] || null;

      // Note: case_status_transitions allows SCHEDULED -> CLAIMED
      const nextCaseStatus = 'CLAIMED';
      if (caseRow.status === 'SCHEDULED') {
        await client.query(
          `UPDATE cases
           SET status = $2::case_status,
               version = version + 1,
               updated_at = now()
           WHERE case_id = $1`,
          [caseId, nextCaseStatus]
        );

        await client.query(
          `INSERT INTO case_status_history (
             case_id,
             from_status,
             to_status,
             changed_by,
             reason,
             metadata
           )
           VALUES ($1, 'SCHEDULED', $2::case_status, $3, $4, $5::jsonb)`,
          [
            caseId,
            nextCaseStatus,
            actor.userId,
            `Cancelled scheduled appointment: ${payload.reason}`,
            JSON.stringify({
              appointmentId,
              ticketId: cancelledTicket ? Number(cancelledTicket.ticket_id) : null,
            }),
          ]
        );
      }

      const recipientUserId =
        Number(actor.userId) === patientId ? doctorId : patientId;

      await createNotification(client, {
        userId: recipientUserId,
        type: 'APPOINTMENT_CANCELLED',
        title: 'Scheduled Appointment Cancelled',
        body: `Appointment on ${apptRow.appointment_date} for case ${caseRow.case_number} was cancelled: ${payload.reason}`,
        caseId,
        data: {
          caseId,
          caseNumber: caseRow.case_number,
          appointmentId,
          reason: payload.reason,
        },
      });

      await writeAuditLog(client, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'APPOINTMENT_CANCELLED',
        entityType: 'appointments',
        entityId: appointmentId,
        afterData: {
          appointmentId,
          caseId,
          reason: payload.reason,
        },
        req,
      });

      afterCommit(async () => {
        emitToRooms(
          [
            `dept:${departmentId}:beds`,
            'admin:dashboard',
            `user:${patientId}`,
            `user:${doctorId}`,
          ],
          'beds.calendar_updated',
          {
            departmentId,
            serviceDate: apptRow.appointment_date,
            periodId: apptRow.period_id ? Number(apptRow.period_id) : null,
            bedId: cancelledTicket ? Number(cancelledTicket.bed_id) : null,
            ticketId: cancelledTicket ? Number(cancelledTicket.ticket_id) : null,
            status: 'CANCELLED',
          }
        );
      });

      return {
        appointmentId,
        appointmentStatus: 'CANCELLED',
        ticketId: cancelledTicket ? Number(cancelledTicket.ticket_id) : null,
        ticketStatus: 'CANCELLED',
        caseId,
        caseStatus: nextCaseStatus,
      };
    },
    { resourceHint: 'BED' }
  );
}

/**
 * Atomically reschedules a `SCHEDULED` appointment to a new date/period/time/bed (§4.5).
 *
 * @param {number} appointmentId
 * @param {{ userId: number, role: string }} actor
 * @param {import('z').infer<typeof rescheduleAppointmentSchema>} payload
 * @param {import('express').Request} req
 */
export async function rescheduleScheduledAppointment(
  appointmentId,
  actor,
  payload,
  req
) {
  return withTransaction(
    async (client, afterCommit) => {
      const settings = await loadBedSettings(client);

      const lookupRes = await client.query(
        `SELECT appointment_id, case_id, doctor_id
         FROM appointments
         WHERE appointment_id = $1
         LIMIT 1`,
        [appointmentId]
      );

      if (lookupRes.rows.length === 0) {
        throw new AppError(
          404,
          'APPOINTMENT_NOT_FOUND',
          `Appointment ${appointmentId} was not found.`
        );
      }

      const caseId = Number(lookupRes.rows[0].case_id);
      const doctorId = Number(lookupRes.rows[0].doctor_id);

      if (actor.role === 'DOCTOR' && Number(actor.userId) !== doctorId) {
        throw new AppError(
          403,
          'NOT_APPOINTMENT_DOCTOR',
          'Only the assigned doctor (or an admin) can reschedule this appointment.'
        );
      }

      const docRes = await client.query(
        `SELECT d.doctor_id, u.full_name AS doctor_name
         FROM student_doctor_profiles d
         JOIN users u ON u.user_id = d.doctor_id
         WHERE d.doctor_id = $1
         FOR UPDATE`,
        [doctorId]
      );
      const doctorName = docRes.rows[0]?.doctor_name || 'Doctor';

      const caseRes = await client.query(
        `SELECT
           c.case_id,
           c.case_number,
           c.patient_id,
           c.department_id,
           c.assigned_doctor_id,
           c.status,
           c.total_sessions,
           pu.full_name AS patient_name
         FROM cases c
         JOIN users pu ON pu.user_id = c.patient_id
         WHERE c.case_id = $1
         FOR UPDATE OF c NOWAIT`,
        [caseId]
      );
      const caseRow = caseRes.rows[0];

      const apptRes = await client.query(
        `SELECT appointment_id, status
         FROM appointments
         WHERE appointment_id = $1
         FOR UPDATE NOWAIT`,
        [appointmentId]
      );
      if (apptRes.rows[0].status !== 'SCHEDULED') {
        throw new AppError(
          409,
          'APPOINTMENT_NOT_SCHEDULED',
          'Only SCHEDULED appointments can be rescheduled.'
        );
      }

      const reasonText = payload.reason || 'Rescheduled to a new date/time';

      // Cancel old appointment & ticket first so unique indexes uq_appt_one_open_per_case & uq_bt_case_active are free
      await client.query(
        `UPDATE appointments
         SET status = 'RESCHEDULED',
             cancel_reason = $2,
             updated_at = now()
         WHERE appointment_id = $1`,
        [appointmentId, reasonText]
      );

      await client.query(
        `UPDATE bed_tickets
         SET status = 'CANCELLED',
             cancelled_at = now(),
             cancel_reason = $2,
             version = version + 1,
             updated_at = now()
         WHERE appointment_id = $1
           AND status = 'RESERVED'`,
        [appointmentId, reasonText]
      );

      // Schedule the new appointment + ticket in the same transaction
      const result = await scheduleBedTicketInTx(client, afterCommit, {
        caseRow,
        doctorId,
        doctorName,
        patientName: caseRow.patient_name,
        scheduleInput: {
          serviceDate: payload.serviceDate,
          periodId: payload.periodId,
          plannedStartTime: payload.plannedStartTime,
          bedId: payload.bedId || null,
          notes: reasonText,
          rescheduledFromId: appointmentId,
        },
        settings,
        req,
      });

      return {
        rescheduledFromAppointmentId: appointmentId,
        ...result,
      };
    },
    { resourceHint: 'BED' }
  );
}
