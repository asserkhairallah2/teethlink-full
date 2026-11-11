import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import { createNotification, writeAuditLog } from '../../utils/audit.js';
import { emitToRooms } from '../../realtime/socketGateway.js';
import { generateSignedFileUrl } from '../files/files.service.js';
import { loadExamSchedulingSettings } from '../exam-scheduling/exam-scheduling.service.js';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const VALID_FDI_TEETH = new Set([
  11, 12, 13, 14, 15, 16, 17, 18,
  21, 22, 23, 24, 25, 26, 27, 28,
  31, 32, 33, 34, 35, 36, 37, 38,
  41, 42, 43, 44, 45, 46, 47, 48,
  51, 52, 53, 54, 55,
  61, 62, 63, 64, 65,
  71, 72, 73, 74, 75,
  81, 82, 83, 84, 85,
]);

export const triageDailyListQuerySchema = z.object({
  date: z.string().regex(ISO_DATE_REGEX, 'date must be YYYY-MM-DD').optional(),
  status: z
    .enum(['ALL', 'BOOKED', 'CHECKED_IN', 'EXAMINED', 'NO_SHOW', 'CANCELLED'])
    .optional()
    .default('ALL'),
});

export const triageCheckInSchema = z.object({
  physicalDocumentPresented: z.boolean().optional().default(false),
  notes: z.string().trim().max(500).optional(),
});

export const triageRouteItemSchema = z.object({
  departmentId: z.coerce.number().int().positive(),
  serviceId: z.coerce.number().int().positive().nullable().optional(),
  toothNumbers: z
    .array(
      z.coerce
        .number()
        .int()
        .refine((n) => VALID_FDI_TEETH.has(n), {
          message: 'Tooth number must be a valid FDI notation integer (11-48 or 51-85).',
        })
    )
    .optional()
    .default([]),
  toothType: z
    .enum(['INCISOR', 'CANINE', 'PREMOLAR', 'MOLAR', 'MULTIPLE', 'NOT_APPLICABLE'])
    .nullable()
    .optional(),
  procedureDetails: z.string().trim().max(1000).nullable().optional(),
  priority: z.enum(['ROUTINE', 'PRIORITY', 'URGENT']).optional().default('ROUTINE'),
  triageNotes: z.string().trim().max(2000).nullable().optional(),
});

export const triageRouteSchema = z
  .object({
    chiefComplaint: z.string().trim().max(1000).nullable().optional(),
    clinicalFindings: z.string().trim().max(2000).nullable().optional(),
    diagnosisSummary: z.string().trim().min(3).max(2000),
    medicalDocsVerified: z.boolean().optional().default(false),
    outcome: z.enum(['ROUTED', 'NO_TREATMENT_NEEDED', 'REFERRED_OUT']),
    referralNote: z.string().trim().max(1000).nullable().optional(),
    routes: z.array(triageRouteItemSchema).optional().default([]),
  })
  .superRefine((val, ctx) => {
    if (val.outcome === 'ROUTED' && (!Array.isArray(val.routes) || val.routes.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['routes'],
        message: 'At least one department route is required when outcome is ROUTED.',
      });
    }
    if (
      val.outcome === 'REFERRED_OUT' &&
      (!val.referralNote || val.referralNote.trim().length === 0)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['referralNote'],
        message: 'referralNote is required when outcome is REFERRED_OUT.',
      });
    }
  });

/**
 * GET /api/v1/triage/daily-list
 * Returns the daily scheduled Initial Examination patients ordered by 10-minute slot time,
 * including signed medical attachment URLs and rule-based `v_patient_risk_flags` (§4.3).
 *
 * @param {import('z').infer<typeof triageDailyListQuerySchema>} queryParams
 * @param {'ar' | 'en'} [lang='ar']
 */
export async function getTriageDailyList(queryParams, lang = 'ar') {
  const settings = await loadExamSchedulingSettings(pool);
  const examDate = queryParams.date || settings.todayDate;
  const statusFilter = queryParams.status || 'ALL';
  const isAr = lang === 'ar';

  const summaryRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE b.status <> 'CANCELLED')::INT AS total_booked,
       COUNT(*) FILTER (WHERE b.status = 'BOOKED')::INT AS awaiting_checkin,
       COUNT(*) FILTER (WHERE b.status = 'CHECKED_IN')::INT AS checked_in,
       COUNT(*) FILTER (WHERE b.status = 'EXAMINED')::INT AS examined,
       COUNT(*) FILTER (WHERE b.status = 'NO_SHOW')::INT AS no_show,
       COUNT(*) FILTER (WHERE b.status = 'CANCELLED')::INT AS cancelled
     FROM initial_exam_bookings b
     JOIN initial_exam_slots s ON s.slot_id = b.slot_id
     WHERE s.exam_date = $1::DATE`,
    [examDate]
  );

  const summaryRow = summaryRes.rows[0];

  const statusClause =
    statusFilter === 'ALL'
      ? `b.status <> 'CANCELLED'`
      : `b.status = $2::exam_booking_status`;

  const queryArgs = statusFilter === 'ALL' ? [examDate] : [examDate, statusFilter];

  const { rows } = await pool.query(
    `SELECT
       b.booking_id,
       b.booking_ref,
       b.status AS booking_status,
       b.booked_at,
       b.checked_in_at,
       b.examined_at,
       b.no_show_at,
       to_char(s.start_time, 'HH24:MI:SS') AS start_time,
       to_char(s.end_time, 'HH24:MI:SS') AS end_time,
       s.station_no,
       s.starts_at,
       s.ends_at,
       c.case_id,
       c.case_number,
       c.status AS case_status,
       c.department_id,
       d.name_en AS department_name_en,
       d.name_ar AS department_name_ar,
       u.user_id AS patient_id,
       u.full_name,
       u.phone,
       CASE
         WHEN pp.date_of_birth IS NOT NULL
         THEN EXTRACT(YEAR FROM age(CURRENT_DATE, pp.date_of_birth))::INT
         ELSE NULL
       END AS age,
       pp.gender,
       pp.has_critical_condition,
       pp.medical_document_status,
       pp.medical_attachment_url,
       pp.medical_notes,
       ta.triage_id,
       ta.outcome AS triage_outcome,
       ta.diagnosis_summary,
       ta.medical_docs_verified,
       COALESCE(
         (
           SELECT jsonb_agg(
             jsonb_build_object(
               'riskFlagId', rf.risk_flag_id,
               'code', rf.code,
               'nameEn', rf.name_en,
               'nameAr', rf.name_ar,
               'severity', rf.severity
             )
             ORDER BY
               CASE rf.severity WHEN 'HIGH' THEN 1 WHEN 'CAUTION' THEN 2 ELSE 3 END,
               rf.code ASC
           )
           FROM (
             SELECT DISTINCT ON (v.risk_flag_id)
               v.risk_flag_id,
               v.code,
               v.name_en,
               v.name_ar,
               v.severity
             FROM v_patient_risk_flags v
             WHERE v.patient_id = u.user_id
             ORDER BY v.risk_flag_id
           ) rf
         ),
         '[]'::jsonb
       ) AS risk_flags
     FROM initial_exam_bookings b
     JOIN initial_exam_slots s ON s.slot_id = b.slot_id
     JOIN cases c ON c.case_id = b.case_id
     LEFT JOIN departments d ON d.department_id = c.department_id
     JOIN users u ON u.user_id = b.patient_id
     JOIN patient_profiles pp ON pp.patient_id = u.user_id
     LEFT JOIN triage_assessments ta ON ta.booking_id = b.booking_id
     WHERE s.exam_date = $1::DATE
       AND ${statusClause}
     ORDER BY s.start_time ASC, s.station_no ASC`,
    queryArgs
  );

  const items = rows.map((row) => ({
    bookingId: Number(row.booking_id),
    bookingRef: row.booking_ref,
    startTime: row.start_time,
    endTime: row.end_time,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    stationNo: Number(row.station_no),
    bookingStatus: row.booking_status,
    checkedInAt: row.checked_in_at || null,
    examinedAt: row.examined_at || null,
    caseId: Number(row.case_id),
    caseNumber: row.case_number,
    caseStatus: row.case_status,
    routedDepartment: row.department_id
      ? {
          departmentId: Number(row.department_id),
          name: isAr ? row.department_name_ar : row.department_name_en,
          nameEn: row.department_name_en,
          nameAr: row.department_name_ar,
        }
      : null,
    triageAssessment: row.triage_id
      ? {
          triageId: Number(row.triage_id),
          outcome: row.triage_outcome,
          diagnosisSummary: row.diagnosis_summary,
          medicalDocsVerified: Boolean(row.medical_docs_verified),
        }
      : null,
    patient: {
      patientId: Number(row.patient_id),
      fullName: row.full_name,
      phone: row.phone,
      age: row.age !== null ? Number(row.age) : null,
      gender: row.gender || null,
      hasCriticalCondition: Boolean(row.has_critical_condition),
      medicalDocumentStatus: row.medical_document_status,
      medicalAttachmentUrl: row.medical_attachment_url
        ? generateSignedFileUrl(row.medical_attachment_url)
        : null,
      medicalNotes: row.medical_notes || null,
      riskFlags: (row.risk_flags || []).map((rf) => ({
        code: rf.code,
        name: isAr ? rf.nameAr : rf.nameEn,
        nameEn: rf.nameEn,
        nameAr: rf.nameAr,
        severity: rf.severity,
      })),
    },
  }));

  return {
    examDate,
    summary: {
      totalBooked: Number(summaryRow.total_booked),
      awaitingCheckIn: Number(summaryRow.awaiting_checkin),
      checkedIn: Number(summaryRow.checked_in),
      examined: Number(summaryRow.examined),
      noShow: Number(summaryRow.no_show),
      cancelled: Number(summaryRow.cancelled),
    },
    items,
  };
}

/**
 * POST /api/v1/triage/bookings/:bookingId/check-in
 * Marks a scheduled initial examination booking as `CHECKED_IN`, transitions the case
 * to `EXAM_CHECKED_IN`, optionally verifies physical medical documents, and emits
 * `triage.patient_checked_in` via `afterCommit()` (§4.3).
 *
 * @param {number} bookingId
 * @param {{ userId: number, role: string, fullName: string }} actor
 * @param {import('z').infer<typeof triageCheckInSchema>} payload
 * @param {import('express').Request} req
 */
export async function checkInTriageBooking(bookingId, actor, payload, req) {
  return withTransaction(async (client, afterCommit) => {
    const lookupRes = await client.query(
      `SELECT
         b.booking_id,
         b.case_id,
         b.slot_id,
         b.patient_id,
         s.exam_date::TEXT AS exam_date,
         to_char(s.start_time, 'HH24:MI:SS') AS start_time
       FROM initial_exam_bookings b
       JOIN initial_exam_slots s ON s.slot_id = b.slot_id
       WHERE b.booking_id = $1`,
      [bookingId]
    );

    if (lookupRes.rows.length === 0) {
      throw new AppError(404, 'BOOKING_NOT_FOUND', `Exam booking ${bookingId} was not found.`);
    }

    const {
      case_id: caseId,
      patient_id: patientId,
      exam_date: examDate,
      start_time: startTime,
    } = lookupRes.rows[0];

    // Lock in §3.4.0 order: 1) patient_profiles, 2) cases, 3) initial_exam_bookings
    await client.query(
      `SELECT patient_id FROM patient_profiles WHERE patient_id = $1 FOR UPDATE NOWAIT`,
      [patientId]
    );

    const caseRes = await client.query(
      `SELECT case_id, case_number, status
       FROM cases
       WHERE case_id = $1
       FOR UPDATE NOWAIT`,
      [caseId]
    );

    const bookingRes = await client.query(
      `SELECT booking_id, booking_ref, status, checked_in_at
       FROM initial_exam_bookings
       WHERE booking_id = $1
       FOR UPDATE NOWAIT`,
      [bookingId]
    );

    const caseRow = caseRes.rows[0];
    const bookingRow = bookingRes.rows[0];

    // Idempotent return if already checked in
    if (bookingRow.status === 'CHECKED_IN') {
      return {
        bookingId: Number(bookingRow.booking_id),
        bookingRef: bookingRow.booking_ref,
        bookingStatus: 'CHECKED_IN',
        caseId: Number(caseRow.case_id),
        caseNumber: caseRow.case_number,
        caseStatus: caseRow.status,
        checkedInAt: bookingRow.checked_in_at,
      };
    }

    if (bookingRow.status !== 'BOOKED') {
      throw new AppError(
        409,
        'INVALID_BOOKING_STATUS_FOR_CHECKIN',
        `Cannot check in a booking with status '${bookingRow.status}'. Expected 'BOOKED'.`
      );
    }

    const updBooking = await client.query(
      `UPDATE initial_exam_bookings
       SET status = 'CHECKED_IN',
           checked_in_at = now(),
           checked_in_by = $2
       WHERE booking_id = $1
       RETURNING checked_in_at`,
      [bookingId, actor.userId]
    );
    const checkedInAt = updBooking.rows[0].checked_in_at;

    await client.query(
      `UPDATE cases
       SET status = 'EXAM_CHECKED_IN'
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
       VALUES ($1, $2, 'EXAM_CHECKED_IN', $3, $4)`,
      [
        caseId,
        caseRow.status,
        actor.userId,
        payload.notes || 'Patient checked in at Initial Examination Clinic',
      ]
    );

    if (payload.physicalDocumentPresented) {
      await client.query(
        `UPDATE patient_profiles
         SET medical_document_status = 'VERIFIED'
         WHERE patient_id = $1
           AND medical_document_status IN ('WILL_BRING_PHYSICALLY', 'UPLOADED', 'MISSING')`,
        [patientId]
      );

      await client.query(
        `UPDATE patient_conditions
         SET document_status = 'VERIFIED'
         WHERE patient_id = $1
           AND has_condition = TRUE
           AND document_status IN ('WILL_BRING_PHYSICALLY', 'UPLOADED', 'MISSING')`,
        [patientId]
      );

      await client.query(
        `UPDATE patient_medical_documents
         SET verified_by = $2,
             verified_at = now()
         WHERE patient_id = $1
           AND is_current = TRUE
           AND verified_at IS NULL`,
        [patientId, actor.userId]
      );
    }

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'TRIAGE_PATIENT_CHECKED_IN',
      entityType: 'initial_exam_bookings',
      entityId: bookingId,
      beforeData: { bookingStatus: 'BOOKED', caseStatus: caseRow.status },
      afterData: {
        bookingStatus: 'CHECKED_IN',
        caseStatus: 'EXAM_CHECKED_IN',
        physicalDocumentPresented: Boolean(payload.physicalDocumentPresented),
      },
      req,
    });

    afterCommit(() => {
      emitToRooms(
        [`triage:${examDate}`, 'admin:dashboard'],
        'triage.patient_checked_in',
        {
          bookingId: Number(bookingRow.booking_id),
          bookingRef: bookingRow.booking_ref,
          bookingStatus: 'CHECKED_IN',
          caseId: Number(caseRow.case_id),
          caseNumber: caseRow.case_number,
          caseStatus: 'EXAM_CHECKED_IN',
          patientId: Number(patientId),
          examDate,
          startTime,
          checkedInAt,
          checkedInBy: actor.userId,
        }
      );
    });

    return {
      bookingId: Number(bookingRow.booking_id),
      bookingRef: bookingRow.booking_ref,
      bookingStatus: 'CHECKED_IN',
      caseId: Number(caseRow.case_id),
      caseNumber: caseRow.case_number,
      caseStatus: 'EXAM_CHECKED_IN',
      checkedInAt,
    };
  });
}

/**
 * Resolves a valid `supervisor_profiles.supervisor_id` for `triage_assessments` and `cases.routed_by_supervisor_id`.
 *
 * @param {import('pg').PoolClient} client
 * @param {{ userId: number, role: string }} actor
 * @returns {Promise<number>}
 */
async function resolveTriageSupervisorId(client, actor) {
  const { rowCount } = await client.query(
    `SELECT 1 FROM supervisor_profiles WHERE supervisor_id = $1`,
    [actor.userId]
  );

  if (rowCount > 0) {
    return Number(actor.userId);
  }

  const code = `ADM-${String(actor.userId).padStart(4, '0')}`;
  await client.query(
    `INSERT INTO supervisor_profiles (
       supervisor_id,
       supervisor_code,
       title,
       specialty,
       is_triage_examiner
     )
     VALUES ($1, $2, 'Admin Supervisor', 'Hospital Triage Administration', TRUE)
     ON CONFLICT (supervisor_id) DO NOTHING`,
    [actor.userId, code]
  );

  return Number(actor.userId);
}

/**
 * Builds the frozen `medical_snapshot` JSONB and fetches the patient's active `v_patient_risk_flags`
 * at the moment of triage routing (§2.5 & §4.3).
 *
 * @param {import('pg').PoolClient} client
 * @param {number} patientId
 */
async function buildPatientMedicalSnapshotAndRiskFlags(client, patientId) {
  const [profileRes, condsRes, allergiesRes, medsRes, flagsRes] = await Promise.all([
    client.query(
      `SELECT
         pp.patient_id,
         pp.date_of_birth,
         CASE
           WHEN pp.date_of_birth IS NOT NULL
           THEN EXTRACT(YEAR FROM age(CURRENT_DATE, pp.date_of_birth))::INT
           ELSE NULL
         END AS age,
         pp.gender,
         pp.has_critical_condition,
         pp.medical_document_status,
         pp.medical_attachment_url,
         pp.medical_notes
       FROM patient_profiles pp
       WHERE pp.patient_id = $1`,
      [patientId]
    ),
    client.query(
      `SELECT
         mc.code,
         mc.name_en,
         mc.name_ar,
         mc.is_critical,
         pc.has_condition,
         pc.selected_options,
         pc.details,
         pc.document_status
       FROM patient_conditions pc
       JOIN medical_conditions mc ON mc.condition_id = pc.condition_id
       WHERE pc.patient_id = $1
         AND pc.has_condition = TRUE
       ORDER BY mc.is_critical DESC, mc.display_order ASC`,
      [patientId]
    ),
    client.query(
      `SELECT
         a.code,
         a.name_en,
         a.name_ar,
         pa.notes
       FROM patient_allergies pa
       JOIN allergies a ON a.allergy_id = pa.allergy_id
       WHERE pa.patient_id = $1
       ORDER BY a.allergy_id ASC`,
      [patientId]
    ),
    client.query(
      `SELECT
         medication_name,
         dosage,
         frequency,
         is_anticoagulant,
         notes
       FROM patient_medications
       WHERE patient_id = $1
       ORDER BY medication_id ASC`,
      [patientId]
    ),
    client.query(
      `SELECT DISTINCT ON (risk_flag_id)
         risk_flag_id,
         code,
         name_en,
         name_ar,
         severity,
         source,
         source_code
       FROM v_patient_risk_flags
       WHERE patient_id = $1
       ORDER BY risk_flag_id, source ASC`,
      [patientId]
    ),
  ]);

  const patientProfile = profileRes.rows[0];
  const riskFlags = flagsRes.rows.map((rf) => ({
    riskFlagId: Number(rf.risk_flag_id),
    code: rf.code,
    nameEn: rf.name_en,
    nameAr: rf.name_ar,
    severity: rf.severity,
    source: rf.source,
    sourceCode: rf.source_code,
  }));

  const snapshot = {
    snapshottedAt: new Date().toISOString(),
    hasCriticalCondition: Boolean(patientProfile.has_critical_condition),
    medicalDocumentStatus: patientProfile.medical_document_status,
    medicalNotes: patientProfile.medical_notes || null,
    positiveConditions: condsRes.rows.map((c) => ({
      code: c.code,
      nameEn: c.name_en,
      nameAr: c.name_ar,
      isCritical: Boolean(c.is_critical),
      selectedOptions: c.selected_options || [],
      details: c.details || null,
      documentStatus: c.document_status,
    })),
    allergies: allergiesRes.rows.map((a) => ({
      code: a.code,
      nameEn: a.name_en,
      nameAr: a.name_ar,
      notes: a.notes || null,
    })),
    medications: medsRes.rows.map((m) => ({
      medicationName: m.medication_name,
      dosage: m.dosage || null,
      frequency: m.frequency || null,
      isAnticoagulant: Boolean(m.is_anticoagulant),
      notes: m.notes || null,
    })),
    riskFlags: riskFlags.map((rf) => ({
      code: rf.code,
      nameEn: rf.nameEn,
      nameAr: rf.nameAr,
      severity: rf.severity,
    })),
  };

  return {
    patientProfile,
    riskFlags,
    snapshot,
  };
}

/**
 * POST /api/v1/triage/bookings/:bookingId/route
 * Records the Supervisor's physical triage assessment, verifies medical documents if flagged,
 * marks the booking `EXAMINED` and slot `CONSUMED`, and either closes the case (`TRIAGE_CLOSED`)
 * or routes it to one or more specialized departments (`WAITING_FOR_DOCTOR`), broadcasting
 * `dept.case_broadcasted` in real time to ALL doctors in the target department(s) (§4.3 & §5.2.2).
 *
 * @param {number} bookingId
 * @param {{ userId: number, role: string, fullName: string, isTriageExaminer?: boolean }} actor
 * @param {import('z').infer<typeof triageRouteSchema>} payload
 * @param {import('express').Request} req
 */
export async function routeTriageBooking(bookingId, actor, payload, req) {
  const isAr = (req?.lang || 'ar') === 'ar';

  return withTransaction(
    async (client, afterCommit) => {
      const lookupRes = await client.query(
        `SELECT
           b.booking_id,
           b.case_id,
           b.slot_id,
           b.patient_id,
           s.exam_date::TEXT AS exam_date
         FROM initial_exam_bookings b
         JOIN initial_exam_slots s ON s.slot_id = b.slot_id
         WHERE b.booking_id = $1`,
        [bookingId]
      );

      if (lookupRes.rows.length === 0) {
        throw new AppError(404, 'BOOKING_NOT_FOUND', `Exam booking ${bookingId} was not found.`);
      }

      const {
        case_id: primaryCaseId,
        slot_id: slotId,
        patient_id: patientId,
        exam_date: examDate,
      } = lookupRes.rows[0];

      // 1) Lock in strict §3.4.0 order: patient_profiles -> cases -> initial_exam_slots -> initial_exam_bookings
      await client.query(
        `SELECT patient_id FROM patient_profiles WHERE patient_id = $1 FOR UPDATE NOWAIT`,
        [patientId]
      );

      const caseRes = await client.query(
        `SELECT case_id, case_number, status
         FROM cases
         WHERE case_id = $1
         FOR UPDATE NOWAIT`,
        [primaryCaseId]
      );

      await client.query(
        `SELECT slot_id FROM initial_exam_slots WHERE slot_id = $1 FOR UPDATE NOWAIT`,
        [slotId]
      );

      const bookingRes = await client.query(
        `SELECT booking_id, booking_ref, status, checked_in_at
         FROM initial_exam_bookings
         WHERE booking_id = $1
         FOR UPDATE NOWAIT`,
        [bookingId]
      );

      const primaryCase = caseRes.rows[0];
      const bookingRow = bookingRes.rows[0];

      if (bookingRow.status === 'EXAMINED') {
        throw new AppError(
          409,
          'BOOKING_ALREADY_EXAMINED',
          `Booking ${bookingRow.booking_ref} has already been examined and routed.`
        );
      }

      if (!['BOOKED', 'CHECKED_IN'].includes(bookingRow.status)) {
        throw new AppError(
          409,
          'INVALID_BOOKING_STATUS_FOR_TRIAGE',
          `Cannot triage a booking with status '${bookingRow.status}'.`
        );
      }

      // 2) Validate all departmentIds and optional (serviceId, departmentId) pairs when outcome = ROUTED
      const deptMap = new Map();
      const serviceMap = new Map();

      if (payload.outcome === 'ROUTED') {
        for (const route of payload.routes) {
          const deptId = Number(route.departmentId);
          if (!deptMap.has(deptId)) {
            const deptRes = await client.query(
              `SELECT department_id, code, name_en, name_ar
               FROM departments
               WHERE department_id = $1
                 AND is_active = TRUE
               LIMIT 1`,
              [deptId]
            );
            if (deptRes.rows.length === 0) {
              throw new AppError(
                422,
                'INVALID_DEPARTMENT_ID',
                `Department ID ${deptId} does not exist or is inactive.`
              );
            }
            deptMap.set(deptId, deptRes.rows[0]);
          }

          if (route.serviceId !== null && route.serviceId !== undefined) {
            const svcId = Number(route.serviceId);
            const svcRes = await client.query(
              `SELECT service_id, department_id, code, name_en, name_ar, requires_permission
               FROM services
               WHERE service_id = $1
                 AND department_id = $2
                 AND is_active = TRUE
               LIMIT 1`,
              [svcId, deptId]
            );
            if (svcRes.rows.length === 0) {
              throw new AppError(
                422,
                'INVALID_DEPARTMENT_SERVICE_PAIR',
                `Service ID ${svcId} does not belong to Department ID ${deptId} or is inactive.`,
                { departmentId: deptId, serviceId: svcId }
              );
            }
            serviceMap.set(`${deptId}:${svcId}`, svcRes.rows[0]);
          }
        }
      }

      const supervisorId = await resolveTriageSupervisorId(client, actor);

      // 3) If primary case is still EXAM_BOOKED, step through EXAM_CHECKED_IN first
      //    so trg_cases_valid_transition is satisfied
      let currentPrimaryStatus = primaryCase.status;
      if (currentPrimaryStatus === 'EXAM_BOOKED') {
        await client.query(
          `UPDATE cases SET status = 'EXAM_CHECKED_IN' WHERE case_id = $1`,
          [primaryCaseId]
        );
        await client.query(
          `INSERT INTO case_status_history (
             case_id,
             from_status,
             to_status,
             changed_by,
             reason
           )
           VALUES ($1, 'EXAM_BOOKED', 'EXAM_CHECKED_IN', $2, 'Auto-checked in during triage examination')`,
          [primaryCaseId, actor.userId]
        );
        currentPrimaryStatus = 'EXAM_CHECKED_IN';
      }

      // 4) Insert triage_assessments record
      const triageInsert = await client.query(
        `INSERT INTO triage_assessments (
           booking_id,
           patient_id,
           supervisor_id,
           chief_complaint,
           clinical_findings,
           diagnosis_summary,
           outcome,
           referral_note,
           medical_docs_verified,
           examined_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
         RETURNING triage_id, examined_at`,
        [
          bookingId,
          patientId,
          supervisorId,
          payload.chiefComplaint || null,
          payload.clinicalFindings || null,
          payload.diagnosisSummary,
          payload.outcome,
          payload.referralNote || null,
          Boolean(payload.medicalDocsVerified),
        ]
      );

      const triageId = Number(triageInsert.rows[0].triage_id);

      // 5) If medicalDocsVerified = true, mark patient documents & profile as VERIFIED
      if (payload.medicalDocsVerified) {
        await client.query(
          `UPDATE patient_medical_documents
           SET verified_by = $2,
               verified_at = now()
           WHERE patient_id = $1
             AND is_current = TRUE
             AND verified_at IS NULL`,
          [patientId, actor.userId]
        );

        await client.query(
          `UPDATE patient_profiles
           SET medical_document_status = 'VERIFIED'
           WHERE patient_id = $1
             AND medical_document_status IN ('UPLOADED', 'WILL_BRING_PHYSICALLY', 'MISSING')`,
          [patientId]
        );

        await client.query(
          `UPDATE patient_conditions
           SET document_status = 'VERIFIED'
           WHERE patient_id = $1
             AND has_condition = TRUE
             AND document_status IN ('UPLOADED', 'WILL_BRING_PHYSICALLY', 'MISSING')`,
          [patientId]
        );
      }

      // 6) Mark booking EXAMINED and slot CONSUMED
      await client.query(
        `UPDATE initial_exam_bookings
         SET status = 'EXAMINED',
             checked_in_at = COALESCE(checked_in_at, now()),
             checked_in_by = COALESCE(checked_in_by, $2),
             examined_at = now()
         WHERE booking_id = $1`,
        [bookingId, actor.userId]
      );

      await client.query(
        `UPDATE initial_exam_slots
         SET status = 'CONSUMED',
             version = version + 1
         WHERE slot_id = $1`,
        [slotId]
      );

      // 7A) Handle non-routed outcomes: NO_TREATMENT_NEEDED or REFERRED_OUT
      if (payload.outcome === 'NO_TREATMENT_NEEDED' || payload.outcome === 'REFERRED_OUT') {
        const closedReason =
          payload.outcome === 'REFERRED_OUT'
            ? `Referred out: ${payload.referralNote}`
            : `No dental treatment required: ${payload.diagnosisSummary}`;

        await client.query(
          `UPDATE cases
           SET triage_id = $2,
               routed_by_supervisor_id = $3,
               status = 'TRIAGE_CLOSED',
               closed_reason = $4
           WHERE case_id = $1`,
          [primaryCaseId, triageId, supervisorId, closedReason]
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
           VALUES ($1, $2, 'TRIAGE_CLOSED', $3, $4, $5::jsonb)`,
          [
            primaryCaseId,
            currentPrimaryStatus,
            actor.userId,
            closedReason,
            JSON.stringify({ triageId, outcome: payload.outcome }),
          ]
        );

        await createNotification(
          client,
          {
            userId: patientId,
            type: 'TRIAGE_COMPLETED',
            title: isAr
              ? 'تم الانتهاء من الكشف المبدئي'
              : 'Initial Examination Completed',
            body: closedReason,
            data: {
              triageId,
              bookingId,
              caseId: Number(primaryCaseId),
              outcome: payload.outcome,
            },
            caseId: Number(primaryCaseId),
          },
          afterCommit
        );

        await writeAuditLog(client, {
          actorUserId: actor.userId,
          actorRole: actor.role,
          action: 'TRIAGE_CLOSED',
          entityType: 'triage_assessments',
          entityId: triageId,
          afterData: {
            bookingId,
            caseId: Number(primaryCaseId),
            outcome: payload.outcome,
          },
          req,
        });

        return {
          triageId,
          bookingId,
          bookingStatus: 'EXAMINED',
          outcome: payload.outcome,
          routedCases: [],
          closedCase: {
            caseId: Number(primaryCaseId),
            caseNumber: primaryCase.case_number,
            status: 'TRIAGE_CLOSED',
            closedReason,
          },
        };
      }

      // 7B) Handle outcome = 'ROUTED'
      const { patientProfile, riskFlags, snapshot } =
        await buildPatientMedicalSnapshotAndRiskFlags(client, patientId);

      const routedCasesResponse = [];
      const broadcastPayloads = [];

      for (let idx = 0; idx < payload.routes.length; idx += 1) {
        const route = payload.routes[idx];
        const deptId = Number(route.departmentId);
        const svcId =
          route.serviceId !== null && route.serviceId !== undefined
            ? Number(route.serviceId)
            : null;

        const deptRow = deptMap.get(deptId);
        const svcRow = svcId ? serviceMap.get(`${deptId}:${svcId}`) : null;
        const toothNumbers = Array.isArray(route.toothNumbers)
          ? route.toothNumbers.map((t) => Number(t))
          : [];

        let routedCaseRow;

        if (idx === 0) {
          // Route #0 updates the primary case created at exam booking
          const updCase = await client.query(
            `UPDATE cases
             SET triage_id = $2,
                 routed_by_supervisor_id = $3,
                 department_id = $4,
                 service_id = $5,
                 tooth_numbers = $6::smallint[],
                 tooth_type = $7,
                 procedure_details = $8,
                 triage_notes = $9,
                 priority = $10,
                 medical_snapshot = $11::jsonb,
                 status = 'WAITING_FOR_DOCTOR',
                 broadcasted_at = now()
             WHERE case_id = $1
             RETURNING
               case_id,
               case_number,
               status,
               department_id,
               service_id,
               tooth_numbers,
               tooth_type,
               procedure_details,
               triage_notes,
               priority,
               broadcasted_at`,
            [
              primaryCaseId,
              triageId,
              supervisorId,
              deptId,
              svcId,
              toothNumbers,
              route.toothType || null,
              route.procedureDetails || payload.diagnosisSummary,
              route.triageNotes || null,
              route.priority || 'ROUTINE',
              JSON.stringify(snapshot),
            ]
          );

          routedCaseRow = updCase.rows[0];

          await client.query(
            `INSERT INTO case_status_history (
               case_id,
               from_status,
               to_status,
               changed_by,
               reason,
               metadata
             )
             VALUES ($1, $2, 'WAITING_FOR_DOCTOR', $3, 'Routed to department by triage supervisor', $4::jsonb)`,
            [
              primaryCaseId,
              currentPrimaryStatus,
              actor.userId,
              JSON.stringify({
                triageId,
                departmentId: deptId,
                serviceId: svcId,
                priority: route.priority || 'ROUTINE',
              }),
            ]
          );
        } else {
          // Additional routes create sibling cases with parent_case_id = primaryCaseId (§1.3e & §4.3)
          const insCase = await client.query(
            `INSERT INTO cases (
               patient_id,
               parent_case_id,
               triage_id,
               routed_by_supervisor_id,
               department_id,
               service_id,
               tooth_numbers,
               tooth_type,
               procedure_details,
               triage_notes,
               priority,
               medical_snapshot,
               status,
               broadcasted_at
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7::smallint[], $8, $9, $10, $11, $12::jsonb, 'WAITING_FOR_DOCTOR', now())
             RETURNING
               case_id,
               case_number,
               status,
               department_id,
               service_id,
               tooth_numbers,
               tooth_type,
               procedure_details,
               triage_notes,
               priority,
               broadcasted_at`,
            [
              patientId,
              primaryCaseId,
              triageId,
              supervisorId,
              deptId,
              svcId,
              toothNumbers,
              route.toothType || null,
              route.procedureDetails || payload.diagnosisSummary,
              route.triageNotes || null,
              route.priority || 'ROUTINE',
              JSON.stringify(snapshot),
            ]
          );

          routedCaseRow = insCase.rows[0];

          await client.query(
            `INSERT INTO case_status_history (
               case_id,
               from_status,
               to_status,
               changed_by,
               reason,
               metadata
             )
             VALUES ($1, NULL, 'WAITING_FOR_DOCTOR', $2, 'Sibling case created during multi-department triage routing', $3::jsonb)`,
            [
              Number(routedCaseRow.case_id),
              actor.userId,
              JSON.stringify({
                triageId,
                parentCaseId: Number(primaryCaseId),
                departmentId: deptId,
                serviceId: svcId,
              }),
            ]
          );
        }

        const currentCaseId = Number(routedCaseRow.case_id);

        // Snapshot case_risk_flags for this case
        for (const rf of riskFlags) {
          await client.query(
            `INSERT INTO case_risk_flags (case_id, risk_flag_id)
             VALUES ($1, $2)
             ON CONFLICT (case_id, risk_flag_id) DO NOTHING`,
            [currentCaseId, rf.riskFlagId]
          );
        }

        // Notify ALL active doctors in the target department (both AVAILABLE and BUSY per Supervisor rule)
        const deptDoctorsRes = await client.query(
          `SELECT dd.doctor_id, u.preferred_language
           FROM doctor_departments dd
           JOIN users u ON u.user_id = dd.doctor_id
           WHERE dd.department_id = $1
             AND dd.is_active = TRUE
             AND u.account_status = 'ACTIVE'
             AND u.deleted_at IS NULL`,
          [deptId]
        );

        for (const doc of deptDoctorsRes.rows) {
          const docIsAr = doc.preferred_language !== 'en';
          await createNotification(
            client,
            {
              userId: Number(doc.doctor_id),
              type: 'CASE_BROADCASTED',
              title: docIsAr
                ? `حالة جديدة في ${deptRow.name_ar} (${routedCaseRow.case_number})`
                : `New Case in ${deptRow.name_en} (${routedCaseRow.case_number})`,
              body:
                routedCaseRow.procedure_details ||
                (svcRow ? (docIsAr ? svcRow.name_ar : svcRow.name_en) : payload.diagnosisSummary),
              data: {
                caseId: currentCaseId,
                caseNumber: routedCaseRow.case_number,
                departmentId: deptId,
                serviceId: svcId,
                priority: routedCaseRow.priority,
                toothNumbers,
                toothType: routedCaseRow.tooth_type,
              },
              caseId: currentCaseId,
            },
            afterCommit
          );
        }

        const formattedCase = {
          caseId: currentCaseId,
          caseNumber: routedCaseRow.case_number,
          parentCaseId: idx === 0 ? null : Number(primaryCaseId),
          status: routedCaseRow.status,
          departmentId: deptId,
          departmentName: isAr ? deptRow.name_ar : deptRow.name_en,
          departmentNameEn: deptRow.name_en,
          departmentNameAr: deptRow.name_ar,
          serviceId: svcId,
          serviceName: svcRow ? (isAr ? svcRow.name_ar : svcRow.name_en) : null,
          serviceNameEn: svcRow ? svcRow.name_en : null,
          serviceNameAr: svcRow ? svcRow.name_ar : null,
          toothNumbers,
          toothType: routedCaseRow.tooth_type || null,
          procedureDetails: routedCaseRow.procedure_details || null,
          triageNotes: routedCaseRow.triage_notes || null,
          priority: routedCaseRow.priority,
          broadcastedAt: routedCaseRow.broadcasted_at,
        };

        routedCasesResponse.push(formattedCase);

        // Privacy-preserving broadcast payload for dept:{departmentId} (§5.2.2)
        broadcastPayloads.push({
          departmentId: deptId,
          eventData: {
            ...formattedCase,
            patientPreview: {
              age: patientProfile.age !== null ? Number(patientProfile.age) : null,
              gender: patientProfile.gender || null,
              hasCriticalCondition: Boolean(patientProfile.has_critical_condition),
              medicalDocumentStatus: patientProfile.medical_document_status,
            },
            riskFlags: riskFlags.map((rf) => ({
              code: rf.code,
              name: isAr ? rf.nameAr : rf.nameEn,
              nameEn: rf.nameEn,
              nameAr: rf.nameAr,
              severity: rf.severity,
            })),
          },
        });
      }

      // Notify the patient that their case was routed to the specialized department(s)
      const deptNamesList = routedCasesResponse
        .map((c) => (isAr ? c.departmentNameAr : c.departmentNameEn))
        .join('، ');

      await createNotification(
        client,
        {
          userId: patientId,
          type: 'CASE_ROUTED_TO_DEPARTMENT',
          title: isAr
            ? 'تم تحويل حالتك إلى القسم المختص'
            : 'Your Case Has Been Routed to the Specialized Department',
          body: isAr
            ? `تم فحص حالتك وتحويلها إلى (${deptNamesList}). سيتم إشعارك فور قبول أحد الأطباء للحالة.`
            : `Your initial examination is complete and your case has been routed to (${deptNamesList}). You will be notified as soon as a doctor claims your case.`,
          data: {
            triageId,
            bookingId,
            routedCaseIds: routedCasesResponse.map((c) => c.caseId),
          },
          caseId: Number(primaryCaseId),
        },
        afterCommit
      );

      await writeAuditLog(client, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'TRIAGE_ROUTED_TO_DEPARTMENTS',
        entityType: 'triage_assessments',
        entityId: triageId,
        afterData: {
          bookingId,
          patientId: Number(patientId),
          routedCases: routedCasesResponse.map((c) => ({
            caseId: c.caseId,
            caseNumber: c.caseNumber,
            departmentId: c.departmentId,
            serviceId: c.serviceId,
            priority: c.priority,
          })),
        },
        req,
      });

      // Emit real-time InDrive-style department broadcast after COMMIT
      afterCommit(() => {
        for (const item of broadcastPayloads) {
          emitToRooms(
            [`dept:${item.departmentId}`, `triage:${examDate}`, 'admin:dashboard'],
            'dept.case_broadcasted',
            item.eventData
          );
        }
      });

      return {
        triageId,
        bookingId,
        bookingStatus: 'EXAMINED',
        outcome: payload.outcome,
        routedCases: routedCasesResponse,
      };
    },
    { lockContext: 'CASE' }
  );
}
