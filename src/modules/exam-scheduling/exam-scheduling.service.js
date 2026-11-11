import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import {
  createNotification,
  normalizeUuidOrNull,
  writeAuditLog,
} from '../../utils/audit.js';
import { emitToRooms } from '../../realtime/socketGateway.js';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const TIME_REGEX = /^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/;

/**
 * Normalizes `"HH:MM"` or `"HH:MM:SS"` into `"HH:MM:SS"`.
 *
 * @param {string} rawTime
 * @returns {string}
 */
export function normalizeTimeString(rawTime) {
  const trimmed = String(rawTime || '').trim();
  if (/^([01]\d|2[0-3]):[0-5]\d$/.test(trimmed)) {
    return `${trimmed}:00`;
  }
  return trimmed;
}

export const availabilityQuerySchema = z.object({
  date: z.string().regex(ISO_DATE_REGEX, 'Query param "date" must be YYYY-MM-DD.'),
  includeUnavailable: z
    .preprocess((val) => val === 'true' || val === true, z.boolean())
    .optional()
    .default(false),
});

export const createExamBookingSchema = z.object({
  examDate: z.string().regex(ISO_DATE_REGEX, 'examDate must be YYYY-MM-DD.'),
  startTime: z
    .string()
    .regex(TIME_REGEX, 'startTime must be HH:MM or HH:MM:SS.')
    .transform(normalizeTimeString),
  slotId: z.coerce.number().int().positive().optional(),
});

export const cancelExamBookingSchema = z.object({
  reason: z.string().trim().min(2).max(200).optional(),
});

export const rescheduleExamBookingSchema = z.object({
  newExamDate: z.string().regex(ISO_DATE_REGEX, 'newExamDate must be YYYY-MM-DD.'),
  newStartTime: z
    .string()
    .regex(TIME_REGEX, 'newStartTime must be HH:MM or HH:MM:SS.')
    .transform(normalizeTimeString),
});

export const scheduleTemplateItemSchema = z.object({
  templateId: z.coerce.number().int().positive().optional(),
  dayOfWeek: z.coerce.number().int().min(1).max(7),
  startTime: z.string().regex(TIME_REGEX).transform(normalizeTimeString),
  endTime: z.string().regex(TIME_REGEX).transform(normalizeTimeString),
  slotMinutes: z.coerce.number().int().min(5).max(60).optional().default(10),
  stations: z.coerce.number().int().min(1).max(20).optional().default(2),
  effectiveFrom: z.string().regex(ISO_DATE_REGEX).optional(),
  effectiveTo: z.string().regex(ISO_DATE_REGEX).nullable().optional(),
  isActive: z.boolean().optional().default(true),
});

export const upsertScheduleTemplatesSchema = z.union([
  scheduleTemplateItemSchema,
  z.object({
    templates: z.array(scheduleTemplateItemSchema).min(1),
  }),
]);

export const createCalendarExceptionSchema = z.object({
  exceptionDate: z.string().regex(ISO_DATE_REGEX, 'exceptionDate must be YYYY-MM-DD.'),
  scope: z.enum(['EXAM_CLINIC', 'DEPARTMENT', 'HOSPITAL']),
  departmentId: z.coerce.number().int().positive().nullable().optional(),
  isClosed: z.boolean().optional().default(true),
  customStartTime: z
    .string()
    .regex(TIME_REGEX)
    .transform(normalizeTimeString)
    .nullable()
    .optional(),
  customEndTime: z
    .string()
    .regex(TIME_REGEX)
    .transform(normalizeTimeString)
    .nullable()
    .optional(),
  reason: z.string().trim().max(200).nullable().optional(),
});

export const generateExamSlotsSchema = z.object({
  fromDate: z.string().regex(ISO_DATE_REGEX).optional(),
  toDate: z.string().regex(ISO_DATE_REGEX).optional(),
  daysAhead: z.coerce.number().int().min(1).max(60).optional(),
});

/**
 * Reads exam scheduling settings (`exam_booking_window_days`, `exam_cancel_cutoff_minutes`,
 * `hospital_timezone`, `exam_slot_minutes`) from `system_settings`, along with the current date
 * in the hospital timezone.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} [dbClient=pool]
 */
export async function loadExamSchedulingSettings(dbClient = pool) {
  const { rows } = await dbClient.query(
    `SELECT
       COALESCE((SELECT (value)::INT FROM system_settings WHERE key = 'exam_booking_window_days'), 2) AS booking_window_days,
       COALESCE((SELECT (value)::INT FROM system_settings WHERE key = 'exam_cancel_cutoff_minutes'), 60) AS cancel_cutoff_minutes,
       COALESCE((SELECT (value)::INT FROM system_settings WHERE key IN ('exam_slot_duration_minutes', 'exam_slot_minutes') LIMIT 1), 10) AS slot_minutes,
       COALESCE((SELECT trim(both '"' from value::TEXT) FROM system_settings WHERE key = 'hospital_timezone'), 'Africa/Cairo') AS hospital_timezone`
  );

  const cfg = rows[0];
  const tz = cfg.hospital_timezone || 'Africa/Cairo';

  const dateRes = await dbClient.query(
    `SELECT
       (now() AT TIME ZONE $1)::DATE::TEXT AS today_date,
       ((now() AT TIME ZONE $1)::DATE + ($2 || ' days')::INTERVAL)::DATE::TEXT AS max_booking_date`,
    [tz, Number(cfg.booking_window_days)]
  );

  return {
    bookingWindowDays: Number(cfg.booking_window_days),
    cancelCutoffMinutes: Number(cfg.cancel_cutoff_minutes),
    slotMinutes: Number(cfg.slot_minutes),
    hospitalTimezone: tz,
    todayDate: dateRes.rows[0].today_date,
    maxBookingDate: dateRes.rows[0].max_booking_date,
  };
}

/**
 * Materializes 10-minute `initial_exam_slots` rows for `fromDate .. toDate`
 * idempotently (`ON CONFLICT (exam_date, start_time, station_no) DO NOTHING`),
 * respecting `exam_schedule_templates` and `calendar_exceptions`.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} dbClient
 * @param {string} fromDate - YYYY-MM-DD
 * @param {string} toDate - YYYY-MM-DD
 * @param {string} [hospitalTimezone='Africa/Cairo']
 */
export async function materializeExamSlotsRange(
  dbClient,
  fromDate,
  toDate,
  hospitalTimezone = 'Africa/Cairo'
) {
  const insertSql = `
    INSERT INTO initial_exam_slots (
      exam_date,
      start_time,
      end_time,
      station_no,
      starts_at,
      ends_at,
      status,
      template_id
    )
    SELECT
      d::DATE AS exam_date,
      slot_ts::TIME AS start_time,
      (slot_ts + (est.slot_minutes || ' minutes')::INTERVAL)::TIME AS end_time,
      st_no::SMALLINT AS station_no,
      (slot_ts AT TIME ZONE $3) AS starts_at,
      ((slot_ts + (est.slot_minutes || ' minutes')::INTERVAL) AT TIME ZONE $3) AS ends_at,
      'AVAILABLE'::exam_slot_status AS status,
      est.template_id
    FROM generate_series($1::DATE, $2::DATE, INTERVAL '1 day') AS d
    JOIN exam_schedule_templates est
      ON est.is_active = TRUE
     AND est.day_of_week = EXTRACT(ISODOW FROM d)::SMALLINT
     AND d::DATE >= est.effective_from
     AND (est.effective_to IS NULL OR d::DATE <= est.effective_to)
    LEFT JOIN LATERAL (
      SELECT ce.is_closed, ce.custom_start_time, ce.custom_end_time
      FROM calendar_exceptions ce
      WHERE ce.exception_date = d::DATE
        AND ce.scope IN ('EXAM_CLINIC', 'HOSPITAL')
      ORDER BY CASE WHEN ce.scope = 'EXAM_CLINIC' THEN 0 ELSE 1 END
      LIMIT 1
    ) exc ON TRUE
    CROSS JOIN LATERAL generate_series(
      d::DATE + COALESCE(exc.custom_start_time, est.start_time),
      d::DATE + COALESCE(exc.custom_end_time, est.end_time) - (est.slot_minutes || ' minutes')::INTERVAL,
      (est.slot_minutes || ' minutes')::INTERVAL
    ) AS slot_ts
    CROSS JOIN LATERAL generate_series(1, est.stations) AS st_no
    WHERE COALESCE(exc.is_closed, FALSE) = FALSE
    ON CONFLICT (exam_date, start_time, station_no) DO NOTHING
  `;

  const result = await dbClient.query(insertSql, [fromDate, toDate, hospitalTimezone]);
  return result.rowCount || 0;
}

/**
 * GET /api/v1/exam-slots/availability
 * Returns available 10-minute Initial Examination slots for a given date (§4.2).
 *
 * @param {{ date: string, includeUnavailable?: boolean }} queryParams
 * @param {{ userId: number, role: string }} user
 */
export async function getExamSlotsAvailability(queryParams, user) {
  const { date, includeUnavailable } = queryParams;
  const settings = await loadExamSchedulingSettings(pool);

  if (user.role === 'PATIENT') {
    if (date < settings.todayDate || date > settings.maxBookingDate) {
      throw new AppError(
        422,
        'OUTSIDE_BOOKING_WINDOW',
        `Initial exam bookings are only open from ${settings.todayDate} to ${settings.maxBookingDate} (${settings.bookingWindowDays} days ahead).`,
        {
          requestedDate: date,
          minDate: settings.todayDate,
          maxDate: settings.maxBookingDate,
          bookingWindowDays: settings.bookingWindowDays,
        }
      );
    }
  }

  // Check if date is closed in calendar_exceptions
  const excRes = await pool.query(
    `SELECT is_closed, custom_start_time, custom_end_time, reason
     FROM calendar_exceptions
     WHERE exception_date = $1::DATE
       AND scope IN ('EXAM_CLINIC', 'HOSPITAL')
     ORDER BY CASE WHEN scope = 'EXAM_CLINIC' THEN 0 ELSE 1 END
     LIMIT 1`,
    [date]
  );

  if (excRes.rows.length > 0 && excRes.rows[0].is_closed) {
    return {
      examDate: date,
      slotDurationMinutes: settings.slotMinutes,
      isClinicClosed: true,
      closureReason: excRes.rows[0].reason || 'Clinic is closed on this date.',
      slots: [],
    };
  }

  // Auto-materialize slots for the requested date if within window and none exist yet
  if (date >= settings.todayDate && date <= settings.maxBookingDate) {
    const existingCountRes = await pool.query(
      `SELECT COUNT(*)::INT AS cnt FROM initial_exam_slots WHERE exam_date = $1::DATE`,
      [date]
    );
    if (existingCountRes.rows[0].cnt === 0) {
      await materializeExamSlotsRange(pool, date, date, settings.hospitalTimezone);
    }
  }

  const canSeeUnavailable =
    Boolean(includeUnavailable) && ['ADMIN', 'SUPERVISOR'].includes(user.role);

  let slotsQuery;
  if (canSeeUnavailable) {
    slotsQuery = `
      SELECT
        to_char(start_time, 'HH24:MI:SS') AS start_time,
        to_char(end_time, 'HH24:MI:SS') AS end_time,
        starts_at,
        ends_at,
        COUNT(*) FILTER (WHERE status = 'AVAILABLE' AND starts_at > now())::INT AS remaining_stations,
        COUNT(*)::INT AS total_stations
      FROM initial_exam_slots
      WHERE exam_date = $1::DATE
      GROUP BY start_time, end_time, starts_at, ends_at
      ORDER BY start_time ASC
    `;
  } else {
    slotsQuery = `
      SELECT
        to_char(start_time, 'HH24:MI:SS') AS start_time,
        to_char(end_time, 'HH24:MI:SS') AS end_time,
        starts_at,
        ends_at,
        COUNT(*)::INT AS remaining_stations
      FROM initial_exam_slots
      WHERE exam_date = $1::DATE
        AND status = 'AVAILABLE'
        AND starts_at > now()
      GROUP BY start_time, end_time, starts_at, ends_at
      ORDER BY start_time ASC
    `;
  }

  const { rows } = await pool.query(slotsQuery, [date]);

  const slots = rows.map((row) => ({
    startTime: row.start_time,
    endTime: row.end_time,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    remainingStations: Number(row.remaining_stations),
    ...(row.total_stations !== undefined ? { totalStations: Number(row.total_stations) } : {}),
    isAvailable: Number(row.remaining_stations) > 0,
  }));

  return {
    examDate: date,
    slotDurationMinutes: settings.slotMinutes,
    isClinicClosed: false,
    minDate: settings.todayDate,
    maxDate: settings.maxBookingDate,
    bookingWindowDays: settings.bookingWindowDays,
    slots,
  };
}

/**
 * POST /api/v1/exam-bookings
 * Atomically books a 10-minute Initial Exam slot using `FOR UPDATE SKIP LOCKED` (or `FOR UPDATE NOWAIT`
 * if `slotId` is explicitly specified) per §3.4.1 & §4.2, creates the `cases` (`EXAM_BOOKED`)
 * and `initial_exam_bookings` (`BOOKED`) rows, and emits `exam_slot.booked` via `afterCommit()`.
 *
 * @param {number} patientId
 * @param {import('z').infer<typeof createExamBookingSchema>} payload
 * @param {import('express').Request} req
 */
export async function bookInitialExamSlot(patientId, payload, req) {
  const settings = await loadExamSchedulingSettings(pool);

  if (payload.examDate < settings.todayDate || payload.examDate > settings.maxBookingDate) {
    throw new AppError(
      422,
      'OUTSIDE_BOOKING_WINDOW',
      `Initial exam bookings are only open from ${settings.todayDate} to ${settings.maxBookingDate}.`,
      {
        examDate: payload.examDate,
        minDate: settings.todayDate,
        maxDate: settings.maxBookingDate,
      }
    );
  }

  const idempotencyUuid = normalizeUuidOrNull(req?.headers?.['idempotency-key']);

  return withTransaction(
    async (client, afterCommit) => {
      // 1) Lock patient profile first (serializes concurrent requests from the same patient)
      const profileRes = await client.query(
        `SELECT
           patient_id,
           questionnaire_completed_at,
           has_critical_condition,
           medical_document_status,
           booking_blocked_until
         FROM patient_profiles
         WHERE patient_id = $1
         FOR UPDATE`,
        [patientId]
      );

      if (profileRes.rows.length === 0) {
        throw new AppError(404, 'PATIENT_PROFILE_NOT_FOUND', 'Patient profile was not found.');
      }

      const profile = profileRes.rows[0];

      if (!profile.questionnaire_completed_at) {
        throw new AppError(
          422,
          'QUESTIONNAIRE_INCOMPLETE',
          'You must complete the medical questionnaire before booking an initial examination slot.'
        );
      }

      if (
        profile.booking_blocked_until &&
        new Date(profile.booking_blocked_until).getTime() > Date.now()
      ) {
        throw new AppError(
          423,
          'PATIENT_BOOKING_BLOCKED',
          `Booking is temporarily blocked due to repeated no-shows until ${new Date(
            profile.booking_blocked_until
          ).toISOString()}.`,
          { blockedUntil: profile.booking_blocked_until }
        );
      }

      // 2) Ensure patient has no active upcoming exam booking
      const activeBookingRes = await client.query(
        `SELECT booking_id, booking_ref
         FROM initial_exam_bookings
         WHERE patient_id = $1
           AND status IN ('BOOKED', 'CHECKED_IN')
         LIMIT 1`,
        [patientId]
      );

      if (activeBookingRes.rows.length > 0) {
        throw new AppError(
          409,
          'PATIENT_ALREADY_HAS_ACTIVE_EXAM',
          'You already have an active initial examination booking.',
          {
            existingBookingId: Number(activeBookingRes.rows[0].booking_id),
            existingBookingRef: activeBookingRes.rows[0].booking_ref,
          }
        );
      }

      // 3) Atomically pick & lock ONE available station row (Case 1A: FOR UPDATE SKIP LOCKED; Case 1B: FOR UPDATE NOWAIT)
      let lockedSlot;
      if (payload.slotId) {
        const directRes = await client.query(
          `SELECT
             slot_id,
             exam_date::TEXT AS exam_date,
             to_char(start_time, 'HH24:MI:SS') AS start_time,
             to_char(end_time, 'HH24:MI:SS') AS end_time,
             station_no,
             starts_at,
             ends_at,
             status,
             held_by_patient_id,
             hold_expires_at
           FROM initial_exam_slots
           WHERE slot_id = $1
           FOR UPDATE NOWAIT`,
          [Number(payload.slotId)]
        );

        if (directRes.rows.length === 0) {
          throw new AppError(404, 'SLOT_NOT_FOUND', 'Specified examination slot was not found.');
        }

        const candidate = directRes.rows[0];
        const isHeldBySelf =
          candidate.status === 'HELD' &&
          Number(candidate.held_by_patient_id) === patientId &&
          candidate.hold_expires_at &&
          new Date(candidate.hold_expires_at).getTime() > Date.now();

        if (
          new Date(candidate.starts_at).getTime() <= Date.now() ||
          (candidate.status !== 'AVAILABLE' && !isHeldBySelf)
        ) {
          throw new AppError(
            409,
            'SLOT_UNAVAILABLE',
            'This 10-minute examination slot was just booked by another patient.'
          );
        }

        const updRes = await client.query(
          `UPDATE initial_exam_slots
           SET status = 'BOOKED',
               held_by_patient_id = NULL,
               hold_expires_at = NULL,
               version = version + 1,
               updated_at = now()
           WHERE slot_id = $1
           RETURNING
             slot_id,
             exam_date::TEXT AS exam_date,
             to_char(start_time, 'HH24:MI:SS') AS start_time,
             to_char(end_time, 'HH24:MI:SS') AS end_time,
             station_no,
             starts_at,
             ends_at`,
          [Number(payload.slotId)]
        );
        lockedSlot = updRes.rows[0];
      } else {
        const skipLockedRes = await client.query(
          `WITH candidate AS (
             SELECT slot_id
             FROM initial_exam_slots
             WHERE exam_date = $2::DATE
               AND start_time = $3::TIME
               AND starts_at > now()
               AND (
                 status = 'AVAILABLE'
                 OR (status = 'HELD' AND held_by_patient_id = $1 AND hold_expires_at > now())
               )
             ORDER BY
               CASE WHEN held_by_patient_id = $1 THEN 0 ELSE 1 END,
               station_no ASC
             LIMIT 1
             FOR UPDATE SKIP LOCKED
           )
           UPDATE initial_exam_slots s
           SET status             = 'BOOKED',
               held_by_patient_id = NULL,
               hold_expires_at    = NULL,
               version            = s.version + 1,
               updated_at         = now()
           FROM candidate c
           WHERE s.slot_id = c.slot_id
           RETURNING
             s.slot_id,
             s.exam_date::TEXT AS exam_date,
             to_char(s.start_time, 'HH24:MI:SS') AS start_time,
             to_char(s.end_time, 'HH24:MI:SS') AS end_time,
             s.station_no,
             s.starts_at,
             s.ends_at`,
          [patientId, payload.examDate, payload.startTime]
        );

        if (skipLockedRes.rows.length === 0) {
          throw new AppError(
            409,
            'SLOT_UNAVAILABLE',
            'This 10-minute examination slot was just booked by another patient. Please choose another available time.'
          );
        }
        lockedSlot = skipLockedRes.rows[0];
      }

      const slotId = Number(lockedSlot.slot_id);

      // 4) Create the Case record in EXAM_BOOKED state
      const caseInsert = await client.query(
        `INSERT INTO cases (patient_id, status)
         VALUES ($1, 'EXAM_BOOKED')
         RETURNING case_id, case_number, status`,
        [patientId]
      );
      const caseRow = caseInsert.rows[0];
      const caseId = Number(caseRow.case_id);

      // 5) Create the Initial Exam Booking
      const bookingInsert = await client.query(
        `INSERT INTO initial_exam_bookings (
           slot_id,
           patient_id,
           case_id,
           status,
           idempotency_key
         )
         VALUES ($1, $2, $3, 'BOOKED', $4)
         RETURNING booking_id, booking_ref, booked_at`,
        [slotId, patientId, caseId, idempotencyUuid]
      );
      const bookingRow = bookingInsert.rows[0];
      const bookingId = Number(bookingRow.booking_id);

      // 6) Log initial case state history
      await client.query(
        `INSERT INTO case_status_history (
           case_id,
           from_status,
           to_status,
           changed_by,
           reason,
           metadata
         )
         VALUES ($1, NULL, 'EXAM_BOOKED', $2, 'Initial examination slot booked', $3::jsonb)`,
        [
          caseId,
          patientId,
          JSON.stringify({
            bookingId,
            bookingRef: bookingRow.booking_ref,
            slotId,
            examDate: lockedSlot.exam_date,
            startTime: lockedSlot.start_time,
            stationNo: Number(lockedSlot.station_no),
          }),
        ]
      );

      // 7) Count remaining free stations for this 10-minute time (for real-time disappearance)
      const remRes = await client.query(
        `SELECT COUNT(*)::INT AS remaining_stations
         FROM initial_exam_slots
         WHERE exam_date = $1::DATE
           AND start_time = $2::TIME
           AND status = 'AVAILABLE'
           AND starts_at > now()`,
        [lockedSlot.exam_date, lockedSlot.start_time]
      );
      const remainingStations = Number(remRes.rows[0].remaining_stations);

      const bringMedicalDocumentReminder =
        profile.medical_document_status === 'WILL_BRING_PHYSICALLY';

      await writeAuditLog(client, {
        actorUserId: patientId,
        actorRole: 'PATIENT',
        action: 'EXAM_SLOT_BOOKED',
        entityType: 'initial_exam_bookings',
        entityId: bookingId,
        afterData: {
          bookingRef: bookingRow.booking_ref,
          caseId,
          caseNumber: caseRow.case_number,
          slotId,
          examDate: lockedSlot.exam_date,
          startTime: lockedSlot.start_time,
          stationNo: Number(lockedSlot.station_no),
          remainingStations,
        },
        req,
      });

      await createNotification(
        client,
        {
          userId: patientId,
          type: 'EXAM_BOOKED',
          title:
            req?.lang === 'en'
              ? 'Initial Examination Appointment Confirmed'
              : 'تم تأكيد موعد الكشف المبدئي',
          body:
            req?.lang === 'en'
              ? `Your initial examination (${bookingRow.booking_ref}) is booked for ${lockedSlot.exam_date} at ${lockedSlot.start_time}.${
                  bringMedicalDocumentReminder
                    ? ' Please remember to bring your medical diagnosis/prescription physically.'
                    : ''
                }`
              : `تم حجز موعد الكشف المبدئي (${bookingRow.booking_ref}) ليوم ${lockedSlot.exam_date} الساعة ${lockedSlot.start_time}.${
                  bringMedicalDocumentReminder
                    ? ' يرجى إحضار التقرير الطبي أو الروشتة معك عند الحضور.'
                    : ''
                }`,
          data: {
            bookingId,
            bookingRef: bookingRow.booking_ref,
            caseId,
            caseNumber: caseRow.case_number,
            examDate: lockedSlot.exam_date,
            startTime: lockedSlot.start_time,
            endTime: lockedSlot.end_time,
            stationNo: Number(lockedSlot.station_no),
            bringMedicalDocumentReminder,
          },
          caseId,
        },
        afterCommit
      );

      // 8) Post-Commit Hook: broadcast slot update / real-time disappearance
      afterCommit(() => {
        emitToRooms(
          [
            `exam_slots:${lockedSlot.exam_date}`,
            `triage:${lockedSlot.exam_date}`,
            'admin:dashboard',
          ],
          'exam_slot.booked',
          {
            examDate: lockedSlot.exam_date,
            startTime: lockedSlot.start_time,
            endTime: lockedSlot.end_time,
            remainingStations,
            isAvailable: remainingStations > 0,
            bookingId,
            bookingRef: bookingRow.booking_ref,
            caseId,
            caseNumber: caseRow.case_number,
            patientId,
          }
        );
      });

      return {
        bookingId,
        bookingRef: bookingRow.booking_ref,
        caseId,
        caseNumber: caseRow.case_number,
        caseStatus: caseRow.status,
        examDate: lockedSlot.exam_date,
        startTime: lockedSlot.start_time,
        endTime: lockedSlot.end_time,
        stationNo: Number(lockedSlot.station_no),
        bringMedicalDocumentReminder,
      };
    },
    { lockContext: 'SLOT' }
  );
}

/**
 * POST /api/v1/exam-bookings/:bookingId/cancel
 * Cancels an upcoming `BOOKED` initial examination booking, frees the 10-minute slot
 * back to `AVAILABLE` (if in the future), transitions the case to `CANCELLED`,
 * and broadcasts `exam_slot.available` via `afterCommit()` (§4.2).
 *
 * @param {number} bookingId
 * @param {{ userId: number, role: string }} actor
 * @param {import('z').infer<typeof cancelExamBookingSchema>} payload
 * @param {import('express').Request} req
 */
export async function cancelInitialExamBooking(bookingId, actor, payload, req) {
  const settings = await loadExamSchedulingSettings(pool);

  return withTransaction(async (client, afterCommit) => {
    // Look up case_id and slot_id first so we lock in §3.4.0 order: cases -> initial_exam_slots -> initial_exam_bookings
    const lookupRes = await client.query(
      `SELECT booking_id, case_id, slot_id, patient_id
       FROM initial_exam_bookings
       WHERE booking_id = $1`,
      [bookingId]
    );

    if (lookupRes.rows.length === 0) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', `Exam booking ${bookingId} was not found.`);
    }

    const { case_id: caseId, slot_id: slotId, patient_id: patientId } = lookupRes.rows[0];

    if (actor.role === 'PATIENT' && Number(patientId) !== Number(actor.userId)) {
      throw new AppError(
        403,
        'FORBIDDEN_BOOKING_ACCESS',
        'Patients can only cancel their own examination bookings.'
      );
    }

    // Lock in strict hierarchy: 1) cases, 2) initial_exam_slots, 3) initial_exam_bookings
    const caseRes = await client.query(
      `SELECT case_id, case_number, status
       FROM cases
       WHERE case_id = $1
       FOR UPDATE`,
      [caseId]
    );

    const slotRes = await client.query(
      `SELECT
         slot_id,
         exam_date::TEXT AS exam_date,
         to_char(start_time, 'HH24:MI:SS') AS start_time,
         to_char(end_time, 'HH24:MI:SS') AS end_time,
         starts_at,
         status
       FROM initial_exam_slots
       WHERE slot_id = $1
       FOR UPDATE`,
      [slotId]
    );

    const bookingRes = await client.query(
      `SELECT booking_id, booking_ref, status
       FROM initial_exam_bookings
       WHERE booking_id = $1
       FOR UPDATE`,
      [bookingId]
    );

    const bookingRow = bookingRes.rows[0];
    const slotRow = slotRes.rows[0];
    const caseRow = caseRes.rows[0];

    if (bookingRow.status !== 'BOOKED') {
      throw new AppError(
        409,
        'BOOKING_NOT_CANCELLABLE',
        `Cannot cancel booking in status '${bookingRow.status}'. Only BOOKED appointments can be cancelled.`
      );
    }

    if (actor.role === 'PATIENT') {
      const cutoffMs = settings.cancelCutoffMinutes * 60 * 1000;
      const startsAtMs = new Date(slotRow.starts_at).getTime();
      if (Date.now() > startsAtMs - cutoffMs) {
        throw new AppError(
          422,
          'CANCEL_CUTOFF_PASSED',
          `Bookings cannot be cancelled less than ${settings.cancelCutoffMinutes} minutes before the appointment start time.`
        );
      }
    }

    const cancelReason = payload.reason || 'Cancelled by user';

    await client.query(
      `UPDATE initial_exam_bookings
       SET status = 'CANCELLED',
           cancelled_at = now(),
           cancelled_by = $2,
           cancel_reason = $3
       WHERE booking_id = $1`,
      [bookingId, actor.userId, cancelReason]
    );

    const newSlotStatus =
      new Date(slotRow.starts_at).getTime() > Date.now() ? 'AVAILABLE' : 'EXPIRED';

    await client.query(
      `UPDATE initial_exam_slots
       SET status = $2::exam_slot_status,
           held_by_patient_id = NULL,
           hold_expires_at = NULL,
           version = version + 1
       WHERE slot_id = $1`,
      [slotId, newSlotStatus]
    );

    await client.query(
      `UPDATE cases
       SET status = 'CANCELLED',
           closed_reason = $2
       WHERE case_id = $1`,
      [caseId, cancelReason]
    );

    await client.query(
      `INSERT INTO case_status_history (
         case_id,
         from_status,
         to_status,
         changed_by,
         reason
       )
       VALUES ($1, $2, 'CANCELLED', $3, $4)`,
      [caseId, caseRow.status, actor.userId, cancelReason]
    );

    const remRes = await client.query(
      `SELECT COUNT(*)::INT AS remaining_stations
       FROM initial_exam_slots
       WHERE exam_date = $1::DATE
         AND start_time = $2::TIME
         AND status = 'AVAILABLE'
         AND starts_at > now()`,
      [slotRow.exam_date, slotRow.start_time]
    );
    const remainingStations = Number(remRes.rows[0].remaining_stations);

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'EXAM_BOOKING_CANCELLED',
      entityType: 'initial_exam_bookings',
      entityId: bookingId,
      beforeData: { status: 'BOOKED', slotId },
      afterData: { status: 'CANCELLED', reason: cancelReason, remainingStations },
      req,
    });

    if (newSlotStatus === 'AVAILABLE') {
      afterCommit(() => {
        emitToRooms(
          [
            `exam_slots:${slotRow.exam_date}`,
            `triage:${slotRow.exam_date}`,
            'admin:dashboard',
          ],
          'exam_slot.available',
          {
            examDate: slotRow.exam_date,
            startTime: slotRow.start_time,
            endTime: slotRow.end_time,
            remainingStations,
            isAvailable: remainingStations > 0,
          }
        );
      });
    }

    return {
      bookingId: Number(bookingRow.booking_id),
      bookingRef: bookingRow.booking_ref,
      bookingStatus: 'CANCELLED',
      caseId: Number(caseRow.case_id),
      caseNumber: caseRow.case_number,
      caseStatus: 'CANCELLED',
      freedSlot: {
        examDate: slotRow.exam_date,
        startTime: slotRow.start_time,
        endTime: slotRow.end_time,
        remainingStations,
      },
    };
  });
}

/**
 * POST /api/v1/exam-bookings/:bookingId/reschedule
 * Atomically cancels the old `initial_exam_bookings` row, frees the old slot to `AVAILABLE`,
 * locks a free station in `(newExamDate, newStartTime)` via `FOR UPDATE SKIP LOCKED`,
 * inserts a new `initial_exam_bookings` row linked to the same `case_id`
 * (`rescheduled_from_booking_id`), and emits both `exam_slot.available` and `exam_slot.booked` (§4.2).
 *
 * @param {number} bookingId
 * @param {{ userId: number, role: string }} actor
 * @param {import('z').infer<typeof rescheduleExamBookingSchema>} payload
 * @param {import('express').Request} req
 */
export async function rescheduleInitialExamBooking(bookingId, actor, payload, req) {
  const settings = await loadExamSchedulingSettings(pool);

  if (actor.role === 'PATIENT') {
    if (
      payload.newExamDate < settings.todayDate ||
      payload.newExamDate > settings.maxBookingDate
    ) {
      throw new AppError(
        422,
        'OUTSIDE_BOOKING_WINDOW',
        `New exam date must be between ${settings.todayDate} and ${settings.maxBookingDate}.`
      );
    }
  }

  return withTransaction(
    async (client, afterCommit) => {
      const lookupRes = await client.query(
        `SELECT booking_id, case_id, slot_id, patient_id
         FROM initial_exam_bookings
         WHERE booking_id = $1`,
        [bookingId]
      );

      if (lookupRes.rows.length === 0) {
        throw new AppError(404, 'BOOKING_NOT_FOUND', `Exam booking ${bookingId} was not found.`);
      }

      const { case_id: caseId, slot_id: oldSlotId, patient_id: patientId } = lookupRes.rows[0];

      if (actor.role === 'PATIENT' && Number(patientId) !== Number(actor.userId)) {
        throw new AppError(
          403,
          'FORBIDDEN_BOOKING_ACCESS',
          'Patients can only reschedule their own examination bookings.'
        );
      }

      // 1) Lock case
      const caseRes = await client.query(
        `SELECT case_id, case_number, status
         FROM cases
         WHERE case_id = $1
         FOR UPDATE`,
        [caseId]
      );
      const caseRow = caseRes.rows[0];

      // 2) Lock old slot
      const oldSlotRes = await client.query(
        `SELECT
           slot_id,
           exam_date::TEXT AS exam_date,
           to_char(start_time, 'HH24:MI:SS') AS start_time,
           to_char(end_time, 'HH24:MI:SS') AS end_time,
           starts_at
         FROM initial_exam_slots
         WHERE slot_id = $1
         FOR UPDATE`,
        [oldSlotId]
      );
      const oldSlot = oldSlotRes.rows[0];

      // 3) Lock old booking
      const oldBookingRes = await client.query(
        `SELECT booking_id, booking_ref, status
         FROM initial_exam_bookings
         WHERE booking_id = $1
         FOR UPDATE`,
        [bookingId]
      );
      const oldBooking = oldBookingRes.rows[0];

      if (oldBooking.status !== 'BOOKED') {
        throw new AppError(
          409,
          'BOOKING_NOT_RESCHEDULABLE',
          `Cannot reschedule booking in status '${oldBooking.status}'.`
        );
      }

      if (
        oldSlot.exam_date === payload.newExamDate &&
        oldSlot.start_time === payload.newStartTime
      ) {
        throw new AppError(
          422,
          'SAME_SLOT_TIME',
          'The requested new exam date and time are identical to your current booking.'
        );
      }

      if (actor.role === 'PATIENT') {
        const cutoffMs = settings.cancelCutoffMinutes * 60 * 1000;
        const startsAtMs = new Date(oldSlot.starts_at).getTime();
        if (Date.now() > startsAtMs - cutoffMs) {
          throw new AppError(
            422,
            'RESCHEDULE_CUTOFF_PASSED',
            `Bookings cannot be rescheduled less than ${settings.cancelCutoffMinutes} minutes before the appointment start time.`
          );
        }
      }

      // 4) Cancel old booking first (so uq_exam_booking_patient_active and uq_exam_booking_case_active allow the new row)
      const rescheduleReason = `Rescheduled to ${payload.newExamDate} ${payload.newStartTime}`;
      await client.query(
        `UPDATE initial_exam_bookings
         SET status = 'CANCELLED',
             cancelled_at = now(),
             cancelled_by = $2,
             cancel_reason = $3
         WHERE booking_id = $1`,
        [bookingId, actor.userId, rescheduleReason]
      );

      // 5) Free old slot
      const oldSlotNextStatus =
        new Date(oldSlot.starts_at).getTime() > Date.now() ? 'AVAILABLE' : 'EXPIRED';

      await client.query(
        `UPDATE initial_exam_slots
         SET status = $2::exam_slot_status,
             held_by_patient_id = NULL,
             hold_expires_at = NULL,
             version = version + 1
         WHERE slot_id = $1`,
        [oldSlotId, oldSlotNextStatus]
      );

      // 6) Pick and lock a new slot using FOR UPDATE SKIP LOCKED
      const newSlotRes = await client.query(
        `WITH candidate AS (
           SELECT slot_id
           FROM initial_exam_slots
           WHERE exam_date = $2::DATE
             AND start_time = $3::TIME
             AND starts_at > now()
             AND (
               status = 'AVAILABLE'
               OR (status = 'HELD' AND held_by_patient_id = $1 AND hold_expires_at > now())
             )
           ORDER BY station_no ASC
           LIMIT 1
           FOR UPDATE SKIP LOCKED
         )
         UPDATE initial_exam_slots s
         SET status = 'BOOKED',
             held_by_patient_id = NULL,
             hold_expires_at = NULL,
             version = s.version + 1,
             updated_at = now()
         FROM candidate c
         WHERE s.slot_id = c.slot_id
         RETURNING
           s.slot_id,
           s.exam_date::TEXT AS exam_date,
           to_char(s.start_time, 'HH24:MI:SS') AS start_time,
           to_char(s.end_time, 'HH24:MI:SS') AS end_time,
           s.station_no,
           s.starts_at,
           s.ends_at`,
        [patientId, payload.newExamDate, payload.newStartTime]
      );

      if (newSlotRes.rows.length === 0) {
        throw new AppError(
          409,
          'SLOT_UNAVAILABLE',
          'The requested new 10-minute examination slot is unavailable. Your existing booking was kept unchanged.'
        );
      }

      const newSlot = newSlotRes.rows[0];
      const newSlotId = Number(newSlot.slot_id);

      // 7) Insert new booking row linked via rescheduled_from_booking_id
      const newBookingInsert = await client.query(
        `INSERT INTO initial_exam_bookings (
           slot_id,
           patient_id,
           case_id,
           status,
           rescheduled_from_booking_id
         )
         VALUES ($1, $2, $3, 'BOOKED', $4)
         RETURNING booking_id, booking_ref, booked_at`,
        [newSlotId, patientId, caseId, bookingId]
      );

      const newBooking = newBookingInsert.rows[0];
      const newBookingId = Number(newBooking.booking_id);

      // 8) Compute remaining stations for old and new slot times
      const [oldRemRes, newRemRes] = await Promise.all([
        client.query(
          `SELECT COUNT(*)::INT AS remaining_stations
           FROM initial_exam_slots
           WHERE exam_date = $1::DATE
             AND start_time = $2::TIME
             AND status = 'AVAILABLE'
             AND starts_at > now()`,
          [oldSlot.exam_date, oldSlot.start_time]
        ),
        client.query(
          `SELECT COUNT(*)::INT AS remaining_stations
           FROM initial_exam_slots
           WHERE exam_date = $1::DATE
             AND start_time = $2::TIME
             AND status = 'AVAILABLE'
             AND starts_at > now()`,
          [newSlot.exam_date, newSlot.start_time]
        ),
      ]);

      const oldRemainingStations = Number(oldRemRes.rows[0].remaining_stations);
      const newRemainingStations = Number(newRemRes.rows[0].remaining_stations);

      await writeAuditLog(client, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'EXAM_BOOKING_RESCHEDULED',
        entityType: 'initial_exam_bookings',
        entityId: newBookingId,
        beforeData: {
          oldBookingId: bookingId,
          oldExamDate: oldSlot.exam_date,
          oldStartTime: oldSlot.start_time,
        },
        afterData: {
          newBookingId,
          newBookingRef: newBooking.booking_ref,
          newExamDate: newSlot.exam_date,
          newStartTime: newSlot.start_time,
          stationNo: Number(newSlot.station_no),
        },
        req,
      });

      afterCommit(() => {
        if (oldSlotNextStatus === 'AVAILABLE') {
          emitToRooms(
            [
              `exam_slots:${oldSlot.exam_date}`,
              `triage:${oldSlot.exam_date}`,
              'admin:dashboard',
            ],
            'exam_slot.available',
            {
              examDate: oldSlot.exam_date,
              startTime: oldSlot.start_time,
              endTime: oldSlot.end_time,
              remainingStations: oldRemainingStations,
              isAvailable: oldRemainingStations > 0,
            }
          );
        }

        emitToRooms(
          [
            `exam_slots:${newSlot.exam_date}`,
            `triage:${newSlot.exam_date}`,
            'admin:dashboard',
          ],
          'exam_slot.booked',
          {
            examDate: newSlot.exam_date,
            startTime: newSlot.start_time,
            endTime: newSlot.end_time,
            remainingStations: newRemainingStations,
            isAvailable: newRemainingStations > 0,
            bookingId: newBookingId,
            bookingRef: newBooking.booking_ref,
            caseId: Number(caseRow.case_id),
            caseNumber: caseRow.case_number,
            patientId: Number(patientId),
          }
        );
      });

      return {
        bookingId: newBookingId,
        bookingRef: newBooking.booking_ref,
        rescheduledFromBookingId: bookingId,
        caseId: Number(caseRow.case_id),
        caseNumber: caseRow.case_number,
        caseStatus: caseRow.status,
        examDate: newSlot.exam_date,
        startTime: newSlot.start_time,
        endTime: newSlot.end_time,
        stationNo: Number(newSlot.station_no),
      };
    },
    { lockContext: 'SLOT' }
  );
}

/**
 * PUT /api/v1/admin/exam-schedule-templates
 * Creates or updates daily working hours per weekday (`start_time`, `end_time`, `slot_minutes`, `stations`) (§4.2).
 *
 * @param {number} adminUserId
 * @param {import('z').infer<typeof upsertScheduleTemplatesSchema>} payload
 * @param {import('express').Request} req
 */
export async function upsertExamScheduleTemplates(adminUserId, payload, req) {
  const items = Array.isArray(payload.templates) ? payload.templates : [payload];

  return withTransaction(async (client) => {
    const savedTemplates = [];

    for (const item of items) {
      if (item.endTime <= item.startTime) {
        throw new AppError(
          422,
          'INVALID_TEMPLATE_TIME_RANGE',
          `endTime (${item.endTime}) must be strictly after startTime (${item.startTime}).`
        );
      }

      if (item.templateId) {
        const updRes = await client.query(
          `UPDATE exam_schedule_templates
           SET day_of_week = $2,
               start_time = $3::TIME,
               end_time = $4::TIME,
               slot_minutes = $5,
               stations = $6,
               effective_from = COALESCE($7::DATE, effective_from),
               effective_to = $8::DATE,
               is_active = $9
           WHERE template_id = $1
           RETURNING
             template_id,
             day_of_week,
             to_char(start_time, 'HH24:MI:SS') AS start_time,
             to_char(end_time, 'HH24:MI:SS') AS end_time,
             slot_minutes,
             stations,
             effective_from::TEXT AS effective_from,
             effective_to::TEXT AS effective_to,
             is_active`,
          [
            Number(item.templateId),
            item.dayOfWeek,
            item.startTime,
            item.endTime,
            item.slotMinutes,
            item.stations,
            item.effectiveFrom || null,
            item.effectiveTo ?? null,
            Boolean(item.isActive),
          ]
        );

        if (updRes.rows.length === 0) {
          throw new AppError(404, 'TEMPLATE_NOT_FOUND', `Template ${item.templateId} not found.`);
        }
        savedTemplates.push(updRes.rows[0]);
      } else {
        // Deactivate previous active template on same weekday if replacing with active template
        if (item.isActive !== false) {
          await client.query(
            `UPDATE exam_schedule_templates
             SET is_active = FALSE
             WHERE day_of_week = $1
               AND is_active = TRUE`,
            [item.dayOfWeek]
          );
        }

        const insRes = await client.query(
          `INSERT INTO exam_schedule_templates (
             day_of_week,
             start_time,
             end_time,
             slot_minutes,
             stations,
             effective_from,
             effective_to,
             is_active,
             created_by
           )
           VALUES ($1, $2::TIME, $3::TIME, $4, $5, COALESCE($6::DATE, CURRENT_DATE), $7::DATE, $8, $9)
           RETURNING
             template_id,
             day_of_week,
             to_char(start_time, 'HH24:MI:SS') AS start_time,
             to_char(end_time, 'HH24:MI:SS') AS end_time,
             slot_minutes,
             stations,
             effective_from::TEXT AS effective_from,
             effective_to::TEXT AS effective_to,
             is_active`,
          [
            item.dayOfWeek,
            item.startTime,
            item.endTime,
            item.slotMinutes,
            item.stations,
            item.effectiveFrom || null,
            item.effectiveTo ?? null,
            Boolean(item.isActive),
            adminUserId,
          ]
        );
        savedTemplates.push(insRes.rows[0]);
      }
    }

    await writeAuditLog(client, {
      actorUserId: adminUserId,
      actorRole: 'ADMIN',
      action: 'EXAM_SCHEDULE_TEMPLATES_UPDATED',
      entityType: 'exam_schedule_templates',
      entityId: savedTemplates[0] ? Number(savedTemplates[0].template_id) : null,
      afterData: { templates: savedTemplates },
      req,
    });

    return {
      templates: savedTemplates.map((t) => ({
        templateId: Number(t.template_id),
        dayOfWeek: Number(t.day_of_week),
        startTime: t.start_time,
        endTime: t.end_time,
        slotMinutes: Number(t.slot_minutes),
        stations: Number(t.stations),
        effectiveFrom: t.effective_from,
        effectiveTo: t.effective_to || null,
        isActive: Boolean(t.is_active),
      })),
    };
  });
}

/**
 * POST /api/v1/admin/calendar-exceptions
 * Marks holidays or custom hours for `EXAM_CLINIC`, `DEPARTMENT`, or `HOSPITAL`,
 * and blocks any unbooked `AVAILABLE` exam slots if the exam clinic is closed on that date (§4.2).
 *
 * @param {number} adminUserId
 * @param {import('z').infer<typeof createCalendarExceptionSchema>} payload
 * @param {import('express').Request} req
 */
export async function upsertCalendarException(adminUserId, payload, req) {
  if (payload.scope === 'DEPARTMENT' && !payload.departmentId) {
    throw new AppError(
      422,
      'DEPARTMENT_ID_REQUIRED',
      'departmentId is required when scope is DEPARTMENT.'
    );
  }
  if (payload.scope !== 'DEPARTMENT' && payload.departmentId) {
    throw new AppError(
      422,
      'DEPARTMENT_ID_NOT_ALLOWED',
      'departmentId must be null when scope is EXAM_CLINIC or HOSPITAL.'
    );
  }
  if (!payload.isClosed && (!payload.customStartTime || !payload.customEndTime)) {
    throw new AppError(
      422,
      'CUSTOM_HOURS_REQUIRED',
      'customStartTime and customEndTime are required when isClosed is false.'
    );
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO calendar_exceptions (
         exception_date,
         scope,
         department_id,
         is_closed,
         custom_start_time,
         custom_end_time,
         reason,
         created_by
       )
       VALUES ($1::DATE, $2, $3, $4, $5::TIME, $6::TIME, $7, $8)
       ON CONFLICT (exception_date, scope, department_id) DO UPDATE
         SET is_closed = EXCLUDED.is_closed,
             custom_start_time = EXCLUDED.custom_start_time,
             custom_end_time = EXCLUDED.custom_end_time,
             reason = EXCLUDED.reason,
             created_by = EXCLUDED.created_by
       RETURNING
         exception_id,
         exception_date::TEXT AS exception_date,
         scope,
         department_id,
         is_closed,
         to_char(custom_start_time, 'HH24:MI:SS') AS custom_start_time,
         to_char(custom_end_time, 'HH24:MI:SS') AS custom_end_time,
         reason,
         created_at`,
      [
        payload.exceptionDate,
        payload.scope,
        payload.departmentId || null,
        Boolean(payload.isClosed),
        payload.isClosed ? null : payload.customStartTime,
        payload.isClosed ? null : payload.customEndTime,
        payload.reason || null,
        adminUserId,
      ]
    );

    const exc = rows[0];
    let blockedSlotsCount = 0;

    if (exc.is_closed && ['EXAM_CLINIC', 'HOSPITAL'].includes(exc.scope)) {
      const blkRes = await client.query(
        `UPDATE initial_exam_slots
         SET status = 'BLOCKED',
             blocked_reason = $2,
             held_by_patient_id = NULL,
             hold_expires_at = NULL,
             version = version + 1
         WHERE exam_date = $1::DATE
           AND status IN ('AVAILABLE', 'HELD')`,
        [exc.exception_date, exc.reason || 'Clinic closed by calendar exception']
      );
      blockedSlotsCount = blkRes.rowCount || 0;
    }

    await writeAuditLog(client, {
      actorUserId: adminUserId,
      actorRole: 'ADMIN',
      action: 'CALENDAR_EXCEPTION_UPSERTED',
      entityType: 'calendar_exceptions',
      entityId: Number(exc.exception_id),
      afterData: {
        exceptionDate: exc.exception_date,
        scope: exc.scope,
        isClosed: Boolean(exc.is_closed),
        blockedSlotsCount,
      },
      req,
    });

    return {
      exceptionId: Number(exc.exception_id),
      exceptionDate: exc.exception_date,
      scope: exc.scope,
      departmentId: exc.department_id ? Number(exc.department_id) : null,
      isClosed: Boolean(exc.is_closed),
      customStartTime: exc.custom_start_time || null,
      customEndTime: exc.custom_end_time || null,
      reason: exc.reason || null,
      blockedSlotsCount,
      createdAt: exc.created_at,
    };
  });
}

/**
 * POST /api/v1/admin/exam-slots/generate
 * Triggers immediate idempotent materialization of `initial_exam_slots` for `fromDate .. toDate` (§4.2).
 *
 * @param {number} adminUserId
 * @param {import('z').infer<typeof generateExamSlotsSchema>} payload
 * @param {import('express').Request} req
 */
export async function generateExamSlotsForAdmin(adminUserId, payload, req) {
  const settings = await loadExamSchedulingSettings(pool);

  const fromDate = payload.fromDate || settings.todayDate;
  let toDate = payload.toDate;

  if (!toDate) {
    const days = payload.daysAhead ?? settings.bookingWindowDays;
    const { rows } = await pool.query(
      `SELECT ($1::DATE + ($2 || ' days')::INTERVAL)::DATE::TEXT AS end_date`,
      [fromDate, Number(days)]
    );
    toDate = rows[0].end_date;
  }

  if (toDate < fromDate) {
    throw new AppError(422, 'INVALID_DATE_RANGE', 'toDate must be on or after fromDate.');
  }

  return withTransaction(async (client) => {
    const insertedCount = await materializeExamSlotsRange(
      client,
      fromDate,
      toDate,
      settings.hospitalTimezone
    );

    const summaryRes = await client.query(
      `SELECT
         COUNT(*)::INT AS total_slots,
         COUNT(*) FILTER (WHERE status = 'AVAILABLE')::INT AS available_slots,
         COUNT(*) FILTER (WHERE status = 'BOOKED')::INT AS booked_slots
       FROM initial_exam_slots
       WHERE exam_date BETWEEN $1::DATE AND $2::DATE`,
      [fromDate, toDate]
    );

    const summary = summaryRes.rows[0];

    await writeAuditLog(client, {
      actorUserId: adminUserId,
      actorRole: 'ADMIN',
      action: 'EXAM_SLOTS_GENERATED',
      entityType: 'initial_exam_slots',
      entityId: null,
      afterData: {
        fromDate,
        toDate,
        insertedCount,
        totalSlotsInRange: Number(summary.total_slots),
      },
      req,
    });

    return {
      fromDate,
      toDate,
      insertedSlotsCount: insertedCount,
      totalSlotsInRange: Number(summary.total_slots),
      availableSlotsInRange: Number(summary.available_slots),
      bookedSlotsInRange: Number(summary.booked_slots),
    };
  });
}
