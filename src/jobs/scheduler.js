import cron from 'node-cron';
import { pool, withTransaction } from '../db/pool.js';
import { createNotification } from '../utils/audit.js';
import { emitToRooms } from '../realtime/socketGateway.js';

/**
 * Unique 64-bit integer advisory lock keys per job so only one Node instance
 * executes a given scheduled job at a time (`pg_try_advisory_xact_lock`).
 */
const JOB_ADVISORY_LOCKS = {
  GENERATE_EXAM_SLOTS: 910001,
  EXPIRE_SLOT_HOLDS: 910002,
  MARK_EXAM_NO_SHOWS: 910003,
  RELEASE_NO_SHOW_BED_RESERVATIONS: 910004,
  ALERT_STALE_OCCUPIED_BEDS: 910005,
  AUTO_FREE_BEDS_EOD: 910006,
  ESCALATE_UNCLAIMED_CASES: 910007,
  SEND_APPOINTMENT_REMINDERS: 910008,
};

/** @type {import('node-cron').ScheduledTask[]} */
const activeCronTasks = [];

/**
 * Loads runtime settings used across the 7 background jobs from `system_settings`.
 *
 * @param {import('pg').Pool | import('pg').PoolClient} db
 */
async function loadJobSettings(db = pool) {
  const { rows } = await db.query(
    `SELECT key, value
     FROM system_settings
     WHERE key IN (
       'hospital_timezone',
       'exam_booking_window_days',
       'exam_no_show_grace_minutes',
       'max_patient_no_shows',
       'bed_reservation_grace_minutes',
       'bed_stale_occupancy_alert_minutes',
       'auto_free_beds_at_end_of_day',
       'unscheduled_claim_timeout_hours'
     )`
  );

  const settings = {
    hospitalTimezone: 'Africa/Cairo',
    examBookingWindowDays: 2,
    examNoShowGraceMinutes: 15,
    maxPatientNoShows: 3,
    bedReservationGraceMinutes: 30,
    bedStaleOccupancyAlertMinutes: 180,
    autoFreeBedsAtEndOfDay: true,
    unscheduledClaimTimeoutHours: 12,
  };

  for (const r of rows) {
    if (r.key === 'hospital_timezone' && typeof r.value === 'string') {
      settings.hospitalTimezone = r.value;
    } else if (r.key === 'exam_booking_window_days') {
      const n = Number(r.value);
      if (Number.isFinite(n) && n >= 1) settings.examBookingWindowDays = n;
    } else if (r.key === 'exam_no_show_grace_minutes') {
      const n = Number(r.value);
      if (Number.isFinite(n) && n >= 0) settings.examNoShowGraceMinutes = n;
    } else if (r.key === 'max_patient_no_shows') {
      const n = Number(r.value);
      if (Number.isFinite(n) && n >= 1) settings.maxPatientNoShows = n;
    } else if (r.key === 'bed_reservation_grace_minutes') {
      const n = Number(r.value);
      if (Number.isFinite(n) && n >= 0) settings.bedReservationGraceMinutes = n;
    } else if (r.key === 'bed_stale_occupancy_alert_minutes') {
      const n = Number(r.value);
      if (Number.isFinite(n) && n >= 15)
        settings.bedStaleOccupancyAlertMinutes = n;
    } else if (r.key === 'auto_free_beds_at_end_of_day') {
      settings.autoFreeBedsAtEndOfDay =
        r.value === true || r.value === 'true';
    } else if (r.key === 'unscheduled_claim_timeout_hours') {
      const n = Number(r.value);
      if (Number.isFinite(n) && n >= 1)
        settings.unscheduledClaimTimeoutHours = n;
    }
  }

  return settings;
}

/**
 * Helper that runs a job inside a transaction guarded by `pg_try_advisory_xact_lock(lockKey)`.
 * If another instance already holds the advisory lock, returns `{ skipped: true }`.
 *
 * @param {string} jobName
 * @param {number} lockKey
 * @param {(client: import('pg').PoolClient, afterCommit: (fn: () => Promise<void> | void) => void) => Promise<any>} fn
 */
async function runWithAdvisoryLock(jobName, lockKey, fn) {
  try {
    return await withTransaction(async (client, afterCommit) => {
      const lockRes = await client.query(
        `SELECT pg_try_advisory_xact_lock($1::BIGINT) AS acquired`,
        [lockKey]
      );
      if (!lockRes.rows[0]?.acquired) {
        return { skipped: true };
      }
      return await fn(client, afterCommit);
    });
  } catch (err) {
    console.error(`[Cron:${jobName}] Error:`, err.message);
    return { error: err.message };
  }
}

// =============================================================================
// Job 1: generate-exam-slots (§5.3)
// =============================================================================

/**
 * Generates 10-minute `initial_exam_slots` for `CURRENT_DATE .. CURRENT_DATE + exam_booking_window_days + 1`
 * from active `exam_schedule_templates`, respecting `calendar_exceptions` (`HOSPITAL` or `EXAM_CLINIC`).
 */
export async function runGenerateExamSlotsJob() {
  return runWithAdvisoryLock(
    'generate-exam-slots',
    JOB_ADVISORY_LOCKS.GENERATE_EXAM_SLOTS,
    async (client) => {
      const settings = await loadJobSettings(client);
      const horizonDays = settings.examBookingWindowDays + 1;

      const insertRes = await client.query(
        `WITH target_dates AS (
           SELECT
             ((now() AT TIME ZONE $1)::DATE + offs)::DATE AS exam_date
           FROM generate_series(0, $2::INT) AS offs
         ),
         open_dates AS (
           SELECT
             td.exam_date,
             EXTRACT(ISODOW FROM td.exam_date)::SMALLINT AS iso_dow,
             ce.custom_start_time,
             ce.custom_end_time
           FROM target_dates td
           LEFT JOIN LATERAL (
             SELECT is_closed, custom_start_time, custom_end_time
             FROM calendar_exceptions
             WHERE exception_date = td.exam_date
               AND scope IN ('HOSPITAL', 'EXAM_CLINIC')
             ORDER BY CASE WHEN is_closed THEN 0 ELSE 1 END
             LIMIT 1
           ) ce ON TRUE
           WHERE COALESCE(ce.is_closed, FALSE) = FALSE
         ),
         slot_series AS (
           SELECT
             od.exam_date,
             t.template_id,
             t.slot_minutes,
             gs.slot_start::TIME AS start_time,
             (gs.slot_start + (t.slot_minutes || ' minutes')::INTERVAL)::TIME AS end_time,
             st.station_no::SMALLINT AS station_no,
             ((od.exam_date + gs.slot_start::TIME) AT TIME ZONE $1) AS starts_at,
             ((od.exam_date + (gs.slot_start + (t.slot_minutes || ' minutes')::INTERVAL)::TIME) AT TIME ZONE $1) AS ends_at
           FROM open_dates od
           JOIN exam_schedule_templates t
             ON t.day_of_week = od.iso_dow
            AND t.is_active = TRUE
            AND t.effective_from <= od.exam_date
            AND (t.effective_to IS NULL OR t.effective_to >= od.exam_date)
           CROSS JOIN LATERAL generate_series(
             od.exam_date + GREATEST(t.start_time, COALESCE(od.custom_start_time, t.start_time)),
             od.exam_date + LEAST(t.end_time, COALESCE(od.custom_end_time, t.end_time)) - (t.slot_minutes || ' minutes')::INTERVAL,
             (t.slot_minutes || ' minutes')::INTERVAL
           ) AS gs(slot_start)
           CROSS JOIN LATERAL generate_series(1, t.stations) AS st(station_no)
         )
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
           exam_date,
           start_time,
           end_time,
           station_no,
           starts_at,
           ends_at,
           'AVAILABLE',
           template_id
         FROM slot_series
         ON CONFLICT (exam_date, start_time, station_no) DO NOTHING
         RETURNING slot_id`,
        [settings.hospitalTimezone, horizonDays]
      );

      return { insertedCount: insertRes.rowCount };
    }
  );
}

// =============================================================================
// Job 2: expire-slot-holds (§5.3)
// =============================================================================

/**
 * Releases expired `HELD` 10-minute exam slots (`hold_expires_at < now()`) back to `AVAILABLE`
 * and broadcasts `exam_slot.available` to `exam_slots:{exam_date}`.
 */
export async function runExpireSlotHoldsJob() {
  return runWithAdvisoryLock(
    'expire-slot-holds',
    JOB_ADVISORY_LOCKS.EXPIRE_SLOT_HOLDS,
    async (client, afterCommit) => {
      const expiredRes = await client.query(
        `WITH expired AS (
           SELECT slot_id
           FROM initial_exam_slots
           WHERE status = 'HELD'
             AND hold_expires_at < now()
           ORDER BY slot_id ASC
           LIMIT 100
           FOR UPDATE SKIP LOCKED
         )
         UPDATE initial_exam_slots s
         SET status = CASE WHEN s.starts_at > now() THEN 'AVAILABLE'::exam_slot_status ELSE 'EXPIRED'::exam_slot_status END,
             held_by_patient_id = NULL,
             hold_expires_at = NULL,
             version = s.version + 1,
             updated_at = now()
         FROM expired e
         WHERE s.slot_id = e.slot_id
         RETURNING
           s.slot_id,
           s.exam_date::TEXT AS exam_date,
           s.start_time::TEXT AS start_time,
           s.end_time::TEXT AS end_time,
           s.status`
      );

      if (expiredRes.rows.length === 0) {
        return { releasedCount: 0 };
      }

      // Compute remaining available stations for each affected (exam_date, start_time)
      const uniqueTimePairs = new Map();
      for (const r of expiredRes.rows) {
        if (r.status === 'AVAILABLE') {
          uniqueTimePairs.set(`${r.exam_date}|${r.start_time}`, r);
        }
      }

      const broadcastPayloads = [];
      for (const [, slotInfo] of uniqueTimePairs) {
        const remRes = await client.query(
          `SELECT COUNT(*)::INT AS remaining_stations
           FROM initial_exam_slots
           WHERE exam_date = $1::DATE
             AND start_time = $2::TIME
             AND status = 'AVAILABLE'`,
          [slotInfo.exam_date, slotInfo.start_time]
        );
        const remainingStations = Number(remRes.rows[0].remaining_stations);
        broadcastPayloads.push({
          examDate: slotInfo.exam_date,
          startTime: slotInfo.start_time,
          endTime: slotInfo.end_time,
          remainingStations,
          isAvailable: remainingStations > 0,
        });
      }

      afterCommit(async () => {
        for (const item of broadcastPayloads) {
          emitToRooms(
            [`exam_slots:${item.examDate}`, 'admin:dashboard'],
            'exam_slot.available',
            item
          );
        }
      });

      return { releasedCount: expiredRes.rowCount };
    }
  );
}

// =============================================================================
// Job 3: mark-exam-no-shows (§5.3)
// =============================================================================

/**
 * Finds `BOOKED` initial exam bookings whose slot ended more than `exam_no_show_grace_minutes` ago,
 * marks them `NO_SHOW`, marks the slot `EXPIRED`, transitions `cases.status -> 'EXAM_NO_SHOW'`,
 * increments `patient_profiles.no_show_count` (blocking for 7 days if `>= max_patient_no_shows`),
 * and emits `triage.exam_no_show`.
 */
export async function runMarkExamNoShowsJob() {
  return runWithAdvisoryLock(
    'mark-exam-no-shows',
    JOB_ADVISORY_LOCKS.MARK_EXAM_NO_SHOWS,
    async (client, afterCommit) => {
      const settings = await loadJobSettings(client);

      const dueRes = await client.query(
        `SELECT
           b.booking_id,
           b.booking_ref,
           b.slot_id,
           b.patient_id,
           b.case_id,
           s.exam_date::TEXT AS exam_date,
           s.start_time::TEXT AS start_time,
           s.end_time::TEXT AS end_time
         FROM initial_exam_bookings b
         JOIN initial_exam_slots s ON s.slot_id = b.slot_id
         WHERE b.status = 'BOOKED'
           AND now() > (s.ends_at + ($1 || ' minutes')::INTERVAL)
         ORDER BY b.booking_id ASC
         LIMIT 50
         FOR UPDATE OF b, s SKIP LOCKED`,
        [String(settings.examNoShowGraceMinutes)]
      );

      if (dueRes.rows.length === 0) {
        return { markedCount: 0 };
      }

      const events = [];

      for (const row of dueRes.rows) {
        const bookingId = Number(row.booking_id);
        const slotId = Number(row.slot_id);
        const patientId = Number(row.patient_id);
        const caseId = Number(row.case_id);

        await client.query(
          `UPDATE initial_exam_bookings
           SET status = 'NO_SHOW',
               no_show_at = now(),
               updated_at = now()
           WHERE booking_id = $1`,
          [bookingId]
        );

        await client.query(
          `UPDATE initial_exam_slots
           SET status = 'EXPIRED',
               version = version + 1,
               updated_at = now()
           WHERE slot_id = $1`,
          [slotId]
        );

        const caseUpdRes = await client.query(
          `UPDATE cases
           SET status = 'EXAM_NO_SHOW',
               version = version + 1,
               updated_at = now()
           WHERE case_id = $1
             AND status = 'EXAM_BOOKED'
           RETURNING case_number`,
          [caseId]
        );

        if (caseUpdRes.rows.length > 0) {
          await client.query(
            `INSERT INTO case_status_history (
               case_id,
               from_status,
               to_status,
               changed_by,
               reason
             )
             VALUES ($1, 'EXAM_BOOKED', 'EXAM_NO_SHOW', NULL, 'Automatic no-show after initial exam slot grace period')`,
            [caseId]
          );
        }

        // Increment patient no_show_count and apply 7-day cooldown if threshold reached
        const patRes = await client.query(
          `UPDATE patient_profiles
           SET no_show_count = no_show_count + 1,
               booking_blocked_until = CASE
                 WHEN (no_show_count + 1) >= $2 THEN now() + INTERVAL '7 days'
                 ELSE booking_blocked_until
               END,
               updated_at = now()
           WHERE patient_id = $1
           RETURNING no_show_count, booking_blocked_until`,
          [patientId, settings.maxPatientNoShows]
        );

        events.push({
          bookingId,
          bookingRef: row.booking_ref,
          slotId,
          examDate: row.exam_date,
          startTime: row.start_time,
          endTime: row.end_time,
          patientId,
          caseId,
          noShowCount: patRes.rows[0]
            ? Number(patRes.rows[0].no_show_count)
            : 1,
        });
      }

      afterCommit(async () => {
        for (const ev of events) {
          emitToRooms(
            [`triage:${ev.examDate}`, 'admin:dashboard', `user:${ev.patientId}`],
            'triage.exam_no_show',
            ev
          );
        }
      });

      return { markedCount: events.length };
    }
  );
}

// =============================================================================
// Job 4: release-no-show-bed-reservations (§5.3)
// =============================================================================

/**
 * Releases `SCHEDULED` bed tickets (`status = 'RESERVED'`) that have not been started within
 * `bed_reservation_grace_minutes` after `planned_start_at`.
 * Transitions `bed_tickets` and `appointments` to `NO_SHOW`, transitions `cases.status` from
 * `'SCHEDULED'` back to `'CLAIMED'` so the doctor retains ownership and can reschedule,
 * and emits `bed.freed` (`liveStatus: 'FREE'`).
 */
export async function runReleaseNoShowBedReservationsJob() {
  return runWithAdvisoryLock(
    'release-no-show-bed-reservations',
    JOB_ADVISORY_LOCKS.RELEASE_NO_SHOW_BED_RESERVATIONS,
    async (client, afterCommit) => {
      const settings = await loadJobSettings(client);

      const dueRes = await client.query(
        `SELECT
           bt.ticket_id,
           bt.ticket_code,
           bt.bed_id,
           bt.department_id,
           bt.appointment_id,
           bt.case_id,
           bt.doctor_id,
           bt.patient_id,
           bt.service_date::TEXT AS service_date,
           bt.period_id,
           bt.planned_start_at,
           cb.label AS bed_label,
           cl.clinic_number,
           c.case_number
         FROM bed_tickets bt
         JOIN clinic_beds cb ON cb.bed_id = bt.bed_id
         JOIN clinics cl ON cl.clinic_id = cb.clinic_id
         JOIN cases c ON c.case_id = bt.case_id
         WHERE bt.ticket_type = 'SCHEDULED'
           AND bt.status = 'RESERVED'
           AND bt.service_date <= CURRENT_DATE
           AND now() > (bt.planned_start_at + ($1 || ' minutes')::INTERVAL)
         ORDER BY bt.ticket_id ASC
         LIMIT 50
         FOR UPDATE OF bt, c SKIP LOCKED`,
        [String(settings.bedReservationGraceMinutes)]
      );

      if (dueRes.rows.length === 0) {
        return { releasedCount: 0 };
      }

      const events = [];

      for (const row of dueRes.rows) {
        const ticketId = Number(row.ticket_id);
        const appointmentId = Number(row.appointment_id);
        const caseId = Number(row.case_id);
        const bedId = Number(row.bed_id);
        const departmentId = Number(row.department_id);
        const doctorId = Number(row.doctor_id);
        const patientId = Number(row.patient_id);

        await client.query(
          `UPDATE bed_tickets
           SET status = 'NO_SHOW',
               cancelled_at = now(),
               cancel_reason = 'Automatic no-show release after grace window',
               version = version + 1,
               updated_at = now()
           WHERE ticket_id = $1`,
          [ticketId]
        );

        await client.query(
          `UPDATE appointments
           SET status = 'NO_SHOW',
               cancel_reason = 'Automatic no-show release after grace window',
               updated_at = now()
           WHERE appointment_id = $1`,
          [appointmentId]
        );

        // Transition case from SCHEDULED back to CLAIMED so doctor can reschedule
        const caseUpdRes = await client.query(
          `UPDATE cases
           SET status = 'CLAIMED',
               version = version + 1,
               updated_at = now()
           WHERE case_id = $1
             AND status = 'SCHEDULED'
           RETURNING case_id`,
          [caseId]
        );

        if (caseUpdRes.rows.length > 0) {
          await client.query(
            `INSERT INTO case_status_history (
               case_id,
               from_status,
               to_status,
               changed_by,
               reason,
               metadata
             )
             VALUES ($1, 'SCHEDULED', 'CLAIMED', NULL, $2, $3::jsonb)`,
            [
              caseId,
              'Scheduled bed reservation released due to no-show after grace period',
              JSON.stringify({ ticketId, appointmentId, bedId }),
            ]
          );
        }

        await createNotification(client, {
          userId: doctorId,
          type: 'APPOINTMENT_CANCELLED',
          title: 'Reserved Bed Ticket Released (No-Show)',
          body: `Reserved Bed ${row.bed_label} for case ${row.case_number} was released after the ${settings.bedReservationGraceMinutes}-minute grace window. You may reschedule the patient.`,
          caseId,
          data: {
            caseId,
            caseNumber: row.case_number,
            ticketId,
            appointmentId,
            bedId,
            bedLabel: row.bed_label,
          },
        });

        await createNotification(client, {
          userId: patientId,
          type: 'APPOINTMENT_CANCELLED',
          title: 'Missed Scheduled Appointment',
          body: `Your scheduled appointment for case ${row.case_number} was marked as a no-show. Please contact your doctor in chat to reschedule.`,
          caseId,
          data: {
            caseId,
            caseNumber: row.case_number,
            ticketId,
            appointmentId,
          },
        });

        events.push({
          ticketId,
          ticketCode: row.ticket_code,
          bedId,
          bedLabel: row.bed_label,
          clinicNumber: row.clinic_number,
          departmentId,
          serviceDate: row.service_date,
          periodId: row.period_id ? Number(row.period_id) : null,
          caseId,
          caseNumber: row.case_number,
          doctorId,
          patientId,
        });
      }

      afterCommit(async () => {
        for (const ev of events) {
          emitToRooms(
            [`dept:${ev.departmentId}:beds`, 'admin:dashboard'],
            'bed.freed',
            {
              ticketId: ev.ticketId,
              ticketCode: ev.ticketCode,
              bedId: ev.bedId,
              bedLabel: ev.bedLabel,
              clinicNumber: ev.clinicNumber,
              departmentId: ev.departmentId,
              liveStatus: 'FREE',
              freedAt: new Date().toISOString(),
              freeReason: 'NO_SHOW_RELEASED',
              caseId: ev.caseId,
              caseNumber: ev.caseNumber,
              caseStatus: 'CLAIMED',
            }
          );

          emitToRooms(
            [`user:${ev.doctorId}`, `user:${ev.patientId}`, `case:${ev.caseId}`],
            'case.appointment_no_show',
            ev
          );
        }
      });

      return { releasedCount: events.length };
    }
  );
}

// =============================================================================
// Job 5: alert-stale-occupied-beds & End-of-Day Auto-Free (§5.3)
// =============================================================================

/**
 * Every 15 minutes: finds beds occupied longer than `bed_stale_occupancy_alert_minutes`
 * and sends a reminder notification (`STALE_BED_OCCUPANCY_REMINDER`) to the doctor.
 */
export async function runAlertStaleOccupiedBedsJob() {
  return runWithAdvisoryLock(
    'alert-stale-occupied-beds',
    JOB_ADVISORY_LOCKS.ALERT_STALE_OCCUPIED_BEDS,
    async (client, afterCommit) => {
      const settings = await loadJobSettings(client);

      const staleRes = await client.query(
        `SELECT
           bt.ticket_id,
           bt.ticket_code,
           bt.bed_id,
           bt.doctor_id,
           bt.case_id,
           bt.department_id,
           bt.occupied_at,
           cb.label AS bed_label,
           cl.clinic_number,
           c.case_number
         FROM bed_tickets bt
         JOIN clinic_beds cb ON cb.bed_id = bt.bed_id
         JOIN clinics cl ON cl.clinic_id = cb.clinic_id
         JOIN cases c ON c.case_id = bt.case_id
         WHERE bt.status = 'OCCUPIED'
           AND now() - bt.occupied_at > ($1 || ' minutes')::INTERVAL
           AND NOT EXISTS (
             SELECT 1
             FROM notifications n
             WHERE n.user_id = bt.doctor_id
               AND n.type = 'STALE_BED_OCCUPANCY_REMINDER'
               AND n.case_id = bt.case_id
               AND n.created_at > now() - INTERVAL '60 minutes'
           )
         ORDER BY bt.occupied_at ASC
         LIMIT 50`,
        [String(settings.bedStaleOccupancyAlertMinutes)]
      );

      for (const row of staleRes.rows) {
        await createNotification(client, {
          userId: Number(row.doctor_id),
          type: 'STALE_BED_OCCUPANCY_REMINDER',
          title: `Still Treating on Bed ${row.bed_label}?`,
          body: `Are you still treating case ${row.case_number} on Clinic ${row.clinic_number} / Bed ${row.bed_label}? Tap to free the bed if your session has finished.`,
          caseId: Number(row.case_id),
          data: {
            ticketId: Number(row.ticket_id),
            bedId: Number(row.bed_id),
            bedLabel: row.bed_label,
            clinicNumber: row.clinic_number,
            caseId: Number(row.case_id),
            caseNumber: row.case_number,
            occupiedAt: row.occupied_at,
          },
        });
      }

      afterCommit(async () => {
        for (const row of staleRes.rows) {
          emitToRooms(
            [`user:${row.doctor_id}`, 'admin:dashboard'],
            'bed.stale_occupancy_reminder',
            {
              ticketId: Number(row.ticket_id),
              bedId: Number(row.bed_id),
              bedLabel: row.bed_label,
              clinicNumber: row.clinic_number,
              doctorId: Number(row.doctor_id),
              caseId: Number(row.case_id),
              caseNumber: row.case_number,
              occupiedAt: row.occupied_at,
            }
          );
        }
      });

      return { alertedCount: staleRes.rows.length };
    }
  );
}

/**
 * End-of-Day at `21:00` (`auto_free_beds_at_end_of_day = true`):
 * Force-frees any forgotten `OCCUPIED` beds (`free_reason = 'AUTO_END_OF_DAY'`),
 * completes their active appointments, moves their cases to `AWAITING_OUTCOME`,
 * and broadcasts `bed.freed` to the department board and Admin dashboard (§5.3).
 */
export async function runEndOfDayAutoFreeBedsJob() {
  return runWithAdvisoryLock(
    'auto-free-beds-eod',
    JOB_ADVISORY_LOCKS.AUTO_FREE_BEDS_EOD,
    async (client, afterCommit) => {
      const settings = await loadJobSettings(client);
      if (!settings.autoFreeBedsAtEndOfDay) {
        return { freedCount: 0, disabled: true };
      }

      const occRes = await client.query(
        `SELECT
           bt.ticket_id,
           bt.ticket_code,
           bt.bed_id,
           bt.department_id,
           bt.appointment_id,
           bt.case_id,
           bt.doctor_id,
           bt.patient_id,
           bt.occupied_at,
           cb.label AS bed_label,
           cl.clinic_number,
           c.case_number,
           c.status AS case_status
         FROM bed_tickets bt
         JOIN clinic_beds cb ON cb.bed_id = bt.bed_id
         JOIN clinics cl ON cl.clinic_id = cb.clinic_id
         JOIN cases c ON c.case_id = bt.case_id
         WHERE bt.status = 'OCCUPIED'
         ORDER BY bt.ticket_id ASC
         FOR UPDATE OF bt, c SKIP LOCKED`
      );

      if (occRes.rows.length === 0) {
        return { freedCount: 0 };
      }

      const freedEvents = [];

      for (const row of occRes.rows) {
        const ticketId = Number(row.ticket_id);
        const appointmentId = Number(row.appointment_id);
        const caseId = Number(row.case_id);
        const doctorId = Number(row.doctor_id);

        const updTicketRes = await client.query(
          `UPDATE bed_tickets
           SET status = 'FREED',
               freed_at = now(),
               free_reason = 'AUTO_END_OF_DAY',
               version = version + 1,
               updated_at = now()
           WHERE ticket_id = $1
           RETURNING freed_at`,
          [ticketId]
        );
        const freedAt = updTicketRes.rows[0].freed_at;

        await client.query(
          `UPDATE appointments
           SET status = 'COMPLETED',
               started_at = COALESCE(started_at, $2),
               ended_at = $3,
               updated_at = now()
           WHERE appointment_id = $1
             AND status = 'IN_PROGRESS'`,
          [appointmentId, row.occupied_at, freedAt]
        );

        if (row.case_status === 'IN_TREATMENT') {
          await client.query(
            `UPDATE cases
             SET status = 'AWAITING_OUTCOME',
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
             VALUES ($1, 'IN_TREATMENT', 'AWAITING_OUTCOME', NULL, 'End-of-day automatic bed release (AUTO_END_OF_DAY)', $2::jsonb)`,
            [
              caseId,
              JSON.stringify({
                ticketId,
                bedId: Number(row.bed_id),
                bedLabel: row.bed_label,
              }),
            ]
          );
        }

        await createNotification(client, {
          userId: doctorId,
          type: 'STALE_BED_OCCUPANCY_REMINDER',
          title: `Bed ${row.bed_label} Automatically Freed at Closing`,
          body: `Bed ${row.bed_label} for case ${row.case_number} was automatically freed at clinic closing. Please submit the session outcome.`,
          caseId,
          data: {
            ticketId,
            bedId: Number(row.bed_id),
            bedLabel: row.bed_label,
            caseId,
            caseNumber: row.case_number,
          },
        });

        freedEvents.push({
          ticketId,
          ticketCode: row.ticket_code,
          bedId: Number(row.bed_id),
          bedLabel: row.bed_label,
          clinicNumber: row.clinic_number,
          departmentId: Number(row.department_id),
          liveStatus: 'FREE',
          freedAt,
          freeReason: 'AUTO_END_OF_DAY',
          caseId,
          caseNumber: row.case_number,
          caseStatus: 'AWAITING_OUTCOME',
          doctorId,
        });
      }

      afterCommit(async () => {
        for (const ev of freedEvents) {
          emitToRooms(
            [
              `dept:${ev.departmentId}:beds`,
              'admin:dashboard',
              `user:${ev.doctorId}`,
            ],
            'bed.freed',
            ev
          );
        }
      });

      return { freedCount: freedEvents.length };
    }
  );
}

// =============================================================================
// Job 6: escalate-unclaimed-cases (§5.3)
// =============================================================================

/**
 * 1) Escalates `WAITING_FOR_DOCTOR` cases unclaimed for > 30 minutes (`escalation_level = 0 -> 1`).
 * 2) Auto-releases `CLAIMED` cases that were never scheduled/occupied within `unscheduled_claim_timeout_hours`.
 */
export async function runEscalateUnclaimedCasesJob() {
  return runWithAdvisoryLock(
    'escalate-unclaimed-cases',
    JOB_ADVISORY_LOCKS.ESCALATE_UNCLAIMED_CASES,
    async (client, afterCommit) => {
      const settings = await loadJobSettings(client);

      // Part A: Escalate WAITING_FOR_DOCTOR cases waiting > 30 minutes
      const unclaimedRes = await client.query(
        `SELECT
           c.case_id,
           c.case_number,
           c.department_id,
           c.priority,
           c.procedure_details,
           c.broadcasted_at,
           d.name_en AS department_name_en
         FROM cases c
         JOIN departments d ON d.department_id = c.department_id
         WHERE c.status = 'WAITING_FOR_DOCTOR'
           AND c.escalation_level = 0
           AND now() - c.broadcasted_at > INTERVAL '30 minutes'
         ORDER BY c.broadcasted_at ASC
         LIMIT 50
         FOR UPDATE OF c SKIP LOCKED`
      );

      const escalatedCases = [];
      for (const row of unclaimedRes.rows) {
        const caseId = Number(row.case_id);
        const departmentId = Number(row.department_id);

        await client.query(
          `UPDATE cases
           SET escalation_level = 1,
               updated_at = now()
           WHERE case_id = $1`,
          [caseId]
        );

        // Notify department supervisors
        const supRes = await client.query(
          `SELECT supervisor_id
           FROM supervisor_profiles
           WHERE department_id = $1`,
          [departmentId]
        );
        for (const s of supRes.rows) {
          await createNotification(client, {
            userId: Number(s.supervisor_id),
            type: 'CASE_BROADCASTED',
            title: `Unclaimed Case Alert (${row.case_number})`,
            body: `Case ${row.case_number} in ${row.department_name_en} has been waiting for a doctor for over 30 minutes.`,
            caseId,
            data: {
              caseId,
              caseNumber: row.case_number,
              departmentId,
              priority: row.priority,
              escalationLevel: 1,
            },
          });
        }

        escalatedCases.push({
          caseId,
          caseNumber: row.case_number,
          departmentId,
          departmentName: row.department_name_en,
          priority: row.priority,
          procedureDetails: row.procedure_details,
          broadcastedAt: row.broadcasted_at,
          escalationLevel: 1,
        });
      }

      // Part B: Auto-release CLAIMED cases never scheduled/occupied after unscheduled_claim_timeout_hours
      const staleClaimedRes = await client.query(
        `SELECT
           c.case_id,
           c.case_number,
           c.department_id,
           c.assigned_doctor_id,
           c.priority,
           c.procedure_details,
           d.name_en AS department_name_en
         FROM cases c
         JOIN departments d ON d.department_id = c.department_id
         WHERE c.status = 'CLAIMED'
           AND now() - c.claimed_at > ($1 || ' hours')::INTERVAL
         ORDER BY c.claimed_at ASC
         LIMIT 50
         FOR UPDATE OF c SKIP LOCKED`,
        [String(settings.unscheduledClaimTimeoutHours)]
      );

      const autoReleasedCases = [];
      for (const row of staleClaimedRes.rows) {
        const caseId = Number(row.case_id);
        const doctorId = Number(row.assigned_doctor_id);
        const departmentId = Number(row.department_id);

        await client.query(
          `UPDATE case_assignments
           SET ended_at = now(),
               end_reason = 'AUTO_RELEASED_UNSCHEDULED',
               notes = 'Automatically released after unscheduled claim timeout'
           WHERE case_id = $1
             AND ended_at IS NULL`,
          [caseId]
        );

        await client.query(
          `UPDATE chat_conversations
           SET status = 'CLOSED',
               closed_at = now()
           WHERE case_id = $1
             AND status IN ('OPEN', 'READ_ONLY')`,
          [caseId]
        );

        await client.query(
          `UPDATE cases
           SET status = 'WAITING_FOR_DOCTOR',
               assigned_doctor_id = NULL,
               claimed_at = NULL,
               broadcasted_at = now(),
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
             reason
           )
           VALUES ($1, 'CLAIMED', 'WAITING_FOR_DOCTOR', NULL, 'Auto-released due to unscheduled claim timeout')`,
          [caseId]
        );

        await createNotification(client, {
          userId: doctorId,
          type: 'APPOINTMENT_CANCELLED',
          title: `Case ${row.case_number} Returned to Department Feed`,
          body: `Case ${row.case_number} was automatically returned to the department waiting list because no bed or appointment was scheduled within ${settings.unscheduledClaimTimeoutHours} hours.`,
          caseId,
          data: {
            caseId,
            caseNumber: row.case_number,
            departmentId,
          },
        });

        autoReleasedCases.push({
          caseId,
          caseNumber: row.case_number,
          departmentId,
          departmentName: row.department_name_en,
          priority: row.priority,
          procedureDetails: row.procedure_details,
          previousDoctorId: doctorId,
        });
      }

      afterCommit(async () => {
        for (const ec of escalatedCases) {
          emitToRooms(
            [
              `dept:${ec.departmentId}`,
              `dept:${ec.departmentId}:feed`,
              'admin:dashboard',
            ],
            'dept.case_escalated',
            ec
          );
        }

        for (const rc of autoReleasedCases) {
          emitToRooms(
            [
              `dept:${rc.departmentId}`,
              `dept:${rc.departmentId}:feed`,
              'admin:dashboard',
            ],
            'dept.case_broadcasted',
            rc
          );
        }
      });

      return {
        escalatedCount: escalatedCases.length,
        autoReleasedCount: autoReleasedCases.length,
      };
    }
  );
}

// =============================================================================
// Job 7: send-appointment-reminders (§5.3)
// =============================================================================

/**
 * Hourly job that sends `APPOINTMENT_REMINDER_24H` and `APPOINTMENT_REMINDER_2H`
 * notifications to patients and doctors for upcoming `initial_exam_bookings` (`BOOKED`)
 * and treatment `appointments` (`SCHEDULED`).
 */
export async function runSendAppointmentRemindersJob() {
  return runWithAdvisoryLock(
    'send-appointment-reminders',
    JOB_ADVISORY_LOCKS.SEND_APPOINTMENT_REMINDERS,
    async (client) => {
      let sentCount = 0;

      // 1) Initial Exam Bookings — 24H window (23h..25h ahead) & 2H window (1h..3h ahead)
      const examRemindersWindows = [
        {
          type: 'APPOINTMENT_REMINDER_24H',
          minHours: 23,
          maxHours: 25,
          label: 'tomorrow',
        },
        {
          type: 'APPOINTMENT_REMINDER_2H',
          minHours: 1,
          maxHours: 3,
          label: 'in ~2 hours',
        },
      ];

      for (const win of examRemindersWindows) {
        const examRes = await client.query(
          `SELECT
             b.booking_id,
             b.booking_ref,
             b.patient_id,
             b.case_id,
             s.exam_date::TEXT AS exam_date,
             s.start_time::TEXT AS start_time,
             s.starts_at
           FROM initial_exam_bookings b
           JOIN initial_exam_slots s ON s.slot_id = b.slot_id
           WHERE b.status = 'BOOKED'
             AND s.starts_at BETWEEN (now() + ($1 || ' hours')::INTERVAL) AND (now() + ($2 || ' hours')::INTERVAL)
             AND NOT EXISTS (
               SELECT 1
               FROM notifications n
               WHERE n.user_id = b.patient_id
                 AND n.type = $3
                 AND n.case_id = b.case_id
             )
           LIMIT 100`,
          [String(win.minHours), String(win.maxHours), win.type]
        );

        for (const r of examRes.rows) {
          await createNotification(client, {
            userId: Number(r.patient_id),
            type: win.type,
            title: 'Upcoming Initial Dental Examination Reminder',
            body: `Reminder: Your initial dental exam (${r.booking_ref}) is scheduled ${win.label} on ${r.exam_date} at ${r.start_time.slice(0, 5)}.`,
            caseId: Number(r.case_id),
            data: {
              bookingId: Number(r.booking_id),
              bookingRef: r.booking_ref,
              examDate: r.exam_date,
              startTime: r.start_time,
              startsAt: r.starts_at,
            },
          });
          sentCount += 1;
        }
      }

      // 2) Scheduled Treatment Appointments — 24H window & 2H window
      for (const win of examRemindersWindows) {
        const apptRes = await client.query(
          `SELECT
             a.appointment_id,
             a.case_id,
             a.doctor_id,
             a.patient_id,
             a.appointment_date::TEXT AS appointment_date,
             a.planned_start_at,
             c.case_number,
             cb.label AS bed_label,
             cl.clinic_number,
             du.full_name AS doctor_name,
             pu.full_name AS patient_name
           FROM appointments a
           JOIN cases c ON c.case_id = a.case_id
           LEFT JOIN bed_tickets bt ON bt.appointment_id = a.appointment_id
           LEFT JOIN clinic_beds cb ON cb.bed_id = bt.bed_id
           LEFT JOIN clinics cl ON cl.clinic_id = cb.clinic_id
           JOIN users du ON du.user_id = a.doctor_id
           JOIN users pu ON pu.user_id = a.patient_id
           WHERE a.status = 'SCHEDULED'
             AND a.planned_start_at BETWEEN (now() + ($1 || ' hours')::INTERVAL) AND (now() + ($2 || ' hours')::INTERVAL)
             AND NOT EXISTS (
               SELECT 1
               FROM notifications n
               WHERE n.user_id = a.patient_id
                 AND n.type = $3
                 AND n.case_id = a.case_id
                 AND (n.data->>'appointmentId')::BIGINT = a.appointment_id
             )
           LIMIT 100`,
          [String(win.minHours), String(win.maxHours), win.type]
        );

        for (const a of apptRes.rows) {
          const appointmentId = Number(a.appointment_id);
          const caseId = Number(a.case_id);
          const locationText = a.bed_label
            ? ` (Clinic ${a.clinic_number}, Bed ${a.bed_label})`
            : '';

          // Patient notification
          await createNotification(client, {
            userId: Number(a.patient_id),
            type: win.type,
            title: 'Upcoming Dental Treatment Session Reminder',
            body: `Reminder: Your treatment session with Dr. ${a.doctor_name} for case ${a.case_number} is scheduled ${win.label} on ${a.appointment_date}${locationText}.`,
            caseId,
            data: {
              appointmentId,
              caseId,
              caseNumber: a.case_number,
              appointmentDate: a.appointment_date,
              plannedStartAt: a.planned_start_at,
              clinicNumber: a.clinic_number,
              bedLabel: a.bed_label,
            },
          });

          // Doctor notification
          await createNotification(client, {
            userId: Number(a.doctor_id),
            type: win.type,
            title: 'Upcoming Patient Session Reminder',
            body: `Reminder: Your scheduled session with patient ${a.patient_name} (${a.case_number}) is ${win.label} on ${a.appointment_date}${locationText}.`,
            caseId,
            data: {
              appointmentId,
              caseId,
              caseNumber: a.case_number,
              appointmentDate: a.appointment_date,
              plannedStartAt: a.planned_start_at,
              clinicNumber: a.clinic_number,
              bedLabel: a.bed_label,
            },
          });

          sentCount += 2;
        }
      }

      return { sentCount };
    }
  );
}

// =============================================================================
// Scheduler Lifecycle (`initScheduler` & `stopScheduler`)
// =============================================================================

/**
 * Registers and starts all 7 background cron jobs from §5.3 of `BACKEND_SYSTEM_PLAN_2.md`.
 */
export function initScheduler() {
  if (activeCronTasks.length > 0) {
    return;
  }

  const timezone = process.env.HOSPITAL_TIMEZONE || 'Africa/Cairo';

  // 1) generate-exam-slots: Daily at 00:05 Africa/Cairo (plus initial boot check)
  activeCronTasks.push(
    cron.schedule(
      '5 0 * * *',
      () => {
        runGenerateExamSlotsJob().catch(() => {});
      },
      { timezone }
    )
  );

  // Trigger an initial slot-generation check 3 seconds after startup so rolling window slots are always ready
  setTimeout(() => {
    runGenerateExamSlotsJob().catch(() => {});
  }, 3000).unref();

  // 2) expire-slot-holds: Every 30 seconds
  activeCronTasks.push(
    cron.schedule(
      '*/30 * * * * *',
      () => {
        runExpireSlotHoldsJob().catch(() => {});
      },
      { timezone }
    )
  );

  // 3) mark-exam-no-shows: Every 5 minutes
  activeCronTasks.push(
    cron.schedule(
      '*/5 * * * *',
      () => {
        runMarkExamNoShowsJob().catch(() => {});
      },
      { timezone }
    )
  );

  // 4) release-no-show-bed-reservations: Every 5 minutes
  activeCronTasks.push(
    cron.schedule(
      '*/5 * * * *',
      () => {
        runReleaseNoShowBedReservationsJob().catch(() => {});
      },
      { timezone }
    )
  );

  // 5a) alert-stale-occupied-beds: Every 15 minutes
  activeCronTasks.push(
    cron.schedule(
      '*/15 * * * *',
      () => {
        runAlertStaleOccupiedBedsJob().catch(() => {});
      },
      { timezone }
    )
  );

  // 5b) alert-stale-occupied-beds (End-of-Day auto-free): Daily at 21:00 Africa/Cairo
  activeCronTasks.push(
    cron.schedule(
      '0 21 * * *',
      () => {
        runEndOfDayAutoFreeBedsJob().catch(() => {});
      },
      { timezone }
    )
  );

  // 6) escalate-unclaimed-cases: Every 15 minutes
  activeCronTasks.push(
    cron.schedule(
      '*/15 * * * *',
      () => {
        runEscalateUnclaimedCasesJob().catch(() => {});
      },
      { timezone }
    )
  );

  // 7) send-appointment-reminders: Hourly at minute 0
  activeCronTasks.push(
    cron.schedule(
      '0 * * * *',
      () => {
        runSendAppointmentRemindersJob().catch(() => {});
      },
      { timezone }
    )
  );

  console.info(
    `[Scheduler] Initialized 7 background cron jobs (timezone: ${timezone})`
  );
}

/**
 * Stops all active `node-cron` tasks during graceful server shutdown.
 */
export function stopScheduler() {
  for (const task of activeCronTasks) {
    try {
      task.stop();
    } catch {
      // Ignore stop errors
    }
  }
  activeCronTasks.length = 0;
}
