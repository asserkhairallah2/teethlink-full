import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import { writeAuditLog } from '../../utils/audit.js';
import {
  buildBedDashboardLogLine,
  loadBedSettings,
} from '../beds/beds.service.js';

// =============================================================================
// Zod Validation Schemas (§4.8)
// =============================================================================

const isoDateRegex = /^\d{4}-\d{2}-\d{2}$/;
const timeRegex = /^([01]\d|2[0-3]):([0-5]\d)(:[0-5]\d)?$/;

export const dailyInitialExamsQuerySchema = z.object({
  date: z
    .string()
    .trim()
    .regex(isoDateRegex, 'date must be in YYYY-MM-DD format')
    .optional(),
  status: z
    .enum(['ALL', 'BOOKED', 'CHECKED_IN', 'EXAMINED', 'NO_SHOW', 'CANCELLED'])
    .optional()
    .default('ALL'),
  format: z.enum(['json', 'csv']).optional().default('json'),
});

export const bedOccupancyQuerySchema = z.object({
  date: z
    .string()
    .trim()
    .regex(isoDateRegex, 'date must be in YYYY-MM-DD format')
    .optional(),
  departmentId: z.coerce.number().int().positive().optional(),
  clinicId: z.coerce.number().int().positive().optional(),
  status: z
    .enum(['ALL', 'OCCUPIED', 'RESERVED', 'FREED', 'NO_SHOW', 'CANCELLED'])
    .optional()
    .default('ALL'),
});

export const auditLogsQuerySchema = z.object({
  actorUserId: z.coerce.number().int().positive().optional(),
  entityType: z.string().trim().max(40).optional(),
  entityId: z.coerce.number().int().positive().optional(),
  action: z.string().trim().max(60).optional(),
  fromDate: z
    .string()
    .trim()
    .regex(isoDateRegex, 'fromDate must be YYYY-MM-DD')
    .optional(),
  toDate: z
    .string()
    .trim()
    .regex(isoDateRegex, 'toDate must be YYYY-MM-DD')
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).optional().default(50),
  offset: z.coerce.number().int().min(0).optional().default(0),
});

export const upsertDepartmentSchema = z.object({
  code: z.string().trim().min(2).max(20).toUpperCase(),
  nameEn: z.string().trim().min(2).max(100),
  nameAr: z.string().trim().min(2).max(100),
  description: z.string().trim().max(500).optional().nullable(),
  isActive: z.boolean().optional().default(true),
  displayOrder: z.coerce.number().int().min(0).optional().default(0),
});

export const updateDepartmentSchema = upsertDepartmentSchema.partial();

export const upsertServiceSchema = z.object({
  departmentId: z.coerce.number().int().positive(),
  code: z.string().trim().min(2).max(30).toUpperCase(),
  nameEn: z.string().trim().min(2).max(120),
  nameAr: z.string().trim().min(2).max(120),
  description: z.string().trim().max(500).optional().nullable(),
  requiresPermission: z.boolean().optional().default(false),
  minAcademicYear: z.coerce
    .number()
    .int()
    .min(3)
    .max(5)
    .optional()
    .nullable(),
  typicalSessions: z.coerce.number().int().min(1).max(20).optional().default(1),
  isActive: z.boolean().optional().default(true),
});

export const updateServiceSchema = upsertServiceSchema.partial();

export const upsertClinicSchema = z.object({
  departmentId: z.coerce.number().int().positive(),
  clinicNumber: z.string().trim().min(1).max(10).toUpperCase(),
  name: z.string().trim().max(80).optional().nullable(),
  building: z.string().trim().max(40).optional().nullable(),
  floor: z.string().trim().max(10).optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

export const updateClinicSchema = upsertClinicSchema.partial();

export const upsertBedSchema = z.object({
  clinicId: z.coerce.number().int().positive(),
  bedNumber: z.coerce.number().int().positive(),
  label: z.string().trim().min(2).max(30),
  operationalStatus: z
    .enum(['ACTIVE', 'OUT_OF_SERVICE', 'RETIRED'])
    .optional()
    .default('ACTIVE'),
  outOfServiceReason: z.string().trim().max(200).optional().nullable(),
  isReservable: z.boolean().optional().default(true),
});

export const updateBedSchema = upsertBedSchema.partial();

export const upsertPeriodSchema = z.object({
  code: z.string().trim().min(2).max(20).toUpperCase(),
  nameEn: z.string().trim().min(2).max(40),
  nameAr: z.string().trim().min(2).max(40),
  startTime: z
    .string()
    .trim()
    .regex(timeRegex)
    .transform((v) => (v.length === 5 ? `${v}:00` : v)),
  endTime: z
    .string()
    .trim()
    .regex(timeRegex)
    .transform((v) => (v.length === 5 ? `${v}:00` : v)),
  displayOrder: z.coerce.number().int().min(0).optional().default(0),
  isActive: z.boolean().optional().default(true),
});

export const updatePeriodSchema = upsertPeriodSchema.partial();

export const upsertMedicalConditionSchema = z.object({
  code: z.string().trim().min(2).max(40).toUpperCase(),
  category: z.string().trim().min(2).max(40),
  nameEn: z.string().trim().min(2).max(100),
  nameAr: z.string().trim().min(2).max(100),
  questionTextEn: z.string().trim().min(5).max(500),
  questionTextAr: z.string().trim().min(5).max(500),
  isCritical: z.boolean().optional().default(false),
  requiresDocumentIfYes: z.boolean().optional().default(false),
  checklistOptions: z
    .array(
      z.object({
        code: z.string().trim().min(1),
        en: z.string().trim().min(1),
        ar: z.string().trim().min(1),
      })
    )
    .optional()
    .default([]),
  riskFlagId: z.coerce.number().int().positive().optional().nullable(),
  isSensitive: z.boolean().optional().default(false),
  appliesToGender: z.enum(['MALE', 'FEMALE']).optional().nullable(),
  displayOrder: z.coerce.number().int().min(0).optional().default(0),
  isActive: z.boolean().optional().default(true),
});

export const updateMedicalConditionSchema =
  upsertMedicalConditionSchema.partial();

// =============================================================================
// 1. GET /api/v1/admin/reports/daily-initial-exams (§4.8)
// =============================================================================

/**
 * Escapes a value for RFC 4180 CSV output.
 */
function csvEscape(val) {
  if (val === null || val === undefined) return '';
  const str = String(val);
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

/**
 * Generates the Daily Initial Examination Report in JSON and CSV formats (§4.8).
 *
 * @param {import('z').infer<typeof dailyInitialExamsQuerySchema>} query
 * @param {string} lang
 */
export async function getDailyInitialExamsReport(query, lang = 'ar') {
  const isAr = lang === 'ar';
  const settings = await loadBedSettings(pool);

  // Resolve target date (default today in hospital timezone)
  const dateRes = await pool.query(
    `SELECT COALESCE($1::DATE, (now() AT TIME ZONE $2)::DATE)::TEXT AS report_date`,
    [query.date || null, settings.hospitalTimezone]
  );
  const reportDate = dateRes.rows[0].report_date;

  // 1) Compute slot & booking totals for that date
  const totalsRes = await pool.query(
    `SELECT
       (SELECT COUNT(*)::INT FROM initial_exam_slots WHERE exam_date = $1::DATE) AS configured_slots,
       (SELECT COUNT(*)::INT FROM initial_exam_slots WHERE exam_date = $1::DATE AND status = 'AVAILABLE') AS available_slots,
       (SELECT COUNT(*)::INT
        FROM initial_exam_bookings b
        JOIN initial_exam_slots s ON s.slot_id = b.slot_id
        WHERE s.exam_date = $1::DATE AND b.status IN ('BOOKED', 'CHECKED_IN', 'EXAMINED')) AS booked_count,
       (SELECT COUNT(*)::INT
        FROM initial_exam_bookings b
        JOIN initial_exam_slots s ON s.slot_id = b.slot_id
        WHERE s.exam_date = $1::DATE AND b.status IN ('CHECKED_IN', 'EXAMINED')) AS checked_in_count,
       (SELECT COUNT(*)::INT
        FROM initial_exam_bookings b
        JOIN initial_exam_slots s ON s.slot_id = b.slot_id
        WHERE s.exam_date = $1::DATE AND b.status = 'EXAMINED') AS examined_count,
       (SELECT COUNT(*)::INT
        FROM initial_exam_bookings b
        JOIN initial_exam_slots s ON s.slot_id = b.slot_id
        WHERE s.exam_date = $1::DATE AND b.status = 'NO_SHOW') AS no_show_count,
       (SELECT COUNT(*)::INT
        FROM cases c
        JOIN triage_assessments ta ON ta.triage_id = c.triage_id
        JOIN initial_exam_bookings b ON b.booking_id = ta.booking_id
        JOIN initial_exam_slots s ON s.slot_id = b.slot_id
        WHERE s.exam_date = $1::DATE AND c.department_id IS NOT NULL) AS routed_cases_count`,
    [reportDate]
  );

  const tRow = totalsRes.rows[0];
  const totals = {
    configuredSlots: Number(tRow.configured_slots || 0),
    booked: Number(tRow.booked_count || 0),
    available: Number(tRow.available_slots || 0),
    checkedIn: Number(tRow.checked_in_count || 0),
    examined: Number(tRow.examined_count || 0),
    routedCases: Number(tRow.routed_cases_count || 0),
    noShows: Number(tRow.no_show_count || 0),
  };

  // 2) Query detailed bookings for that date
  const statusFilter = query.status || 'ALL';
  const bookingsRes = await pool.query(
    `SELECT
       b.booking_id,
       b.booking_ref,
       b.status,
       b.booked_at,
       b.checked_in_at,
       b.examined_at,
       s.start_time::TEXT AS start_time,
       s.end_time::TEXT AS end_time,
       s.station_no,
       pu.user_id AS patient_id,
       pu.full_name AS patient_name,
       pu.phone AS patient_phone,
       ta.triage_id,
       ta.outcome AS triage_outcome,
       su.user_id AS supervisor_id,
       su.full_name AS supervisor_name,
       COALESCE(
         ARRAY_AGG(DISTINCT CASE WHEN $3 THEN d.name_ar ELSE d.name_en END)
         FILTER (WHERE d.department_id IS NOT NULL),
         '{}'
       ) AS routed_departments
     FROM initial_exam_bookings b
     JOIN initial_exam_slots s ON s.slot_id = b.slot_id
     JOIN users pu ON pu.user_id = b.patient_id
     LEFT JOIN triage_assessments ta ON ta.booking_id = b.booking_id
     LEFT JOIN users su ON su.user_id = ta.supervisor_id
     LEFT JOIN cases rc ON (rc.case_id = b.case_id OR rc.triage_id = ta.triage_id)
     LEFT JOIN departments d ON d.department_id = rc.department_id
     WHERE s.exam_date = $1::DATE
       AND ($2 = 'ALL' OR b.status::TEXT = $2)
     GROUP BY
       b.booking_id,
       b.booking_ref,
       b.status,
       b.booked_at,
       b.checked_in_at,
       b.examined_at,
       s.start_time,
       s.end_time,
       s.station_no,
       pu.user_id,
       pu.full_name,
       pu.phone,
       ta.triage_id,
       ta.outcome,
       su.user_id,
       su.full_name
     ORDER BY s.start_time ASC, s.station_no ASC`,
    [reportDate, statusFilter, isAr]
  );

  const bookings = bookingsRes.rows.map((r) => ({
    bookingId: Number(r.booking_id),
    bookingRef: r.booking_ref,
    slotTime: `${r.start_time} - ${r.end_time}`,
    stationNo: Number(r.station_no),
    status: r.status,
    bookedAt: r.booked_at,
    checkedInAt: r.checked_in_at,
    examinedAt: r.examined_at,
    patient: {
      patientId: Number(r.patient_id),
      fullName: r.patient_name,
      phone: r.patient_phone,
    },
    triageSupervisor: r.supervisor_id
      ? {
          supervisorId: Number(r.supervisor_id),
          fullName: r.supervisor_name,
        }
      : null,
    triageOutcome: r.triage_outcome || null,
    routedDepartments: r.routed_departments || [],
  }));

  if (query.format === 'csv') {
    const headers = [
      'BookingID',
      'BookingRef',
      'Date',
      'SlotTime',
      'StationNo',
      'Status',
      'PatientID',
      'PatientName',
      'PatientPhone',
      'TriageSupervisor',
      'TriageOutcome',
      'RoutedDepartments',
      'CheckedInAt',
      'ExaminedAt',
    ];

    const lines = [headers.join(',')];
    for (const b of bookings) {
      lines.push(
        [
          csvEscape(b.bookingId),
          csvEscape(b.bookingRef),
          csvEscape(reportDate),
          csvEscape(b.slotTime),
          csvEscape(b.stationNo),
          csvEscape(b.status),
          csvEscape(b.patient.patientId),
          csvEscape(b.patient.fullName),
          csvEscape(b.patient.phone),
          csvEscape(b.triageSupervisor?.fullName || ''),
          csvEscape(b.triageOutcome || ''),
          csvEscape((b.routedDepartments || []).join(' | ')),
          csvEscape(b.checkedInAt ? new Date(b.checkedInAt).toISOString() : ''),
          csvEscape(b.examinedAt ? new Date(b.examinedAt).toISOString() : ''),
        ].join(',')
      );
    }

    return {
      isCsv: true,
      filename: `daily-initial-exams-${reportDate}.csv`,
      csvContent: lines.join('\r\n'),
    };
  }

  return {
    isCsv: false,
    data: {
      date: reportDate,
      totals,
      bookings,
    },
  };
}

// =============================================================================
// 2. GET /api/v1/admin/reports/bed-occupancy (§4.8)
// =============================================================================

/**
 * Generates the Live Bed Board Summary + Historical Bed Booking Log with formatted `logText`:
 * *"Bed C3-B01 booked by Dr. X with Patient Y at 02:10 PM (Cairo)"* (§4.8).
 *
 * @param {import('z').infer<typeof bedOccupancyQuerySchema>} query
 * @param {string} lang
 */
export async function getBedOccupancyReport(query, lang = 'ar') {
  const isAr = lang === 'ar';
  const settings = await loadBedSettings(pool);

  const dateRes = await pool.query(
    `SELECT COALESCE($1::DATE, (now() AT TIME ZONE $2)::DATE)::TEXT AS report_date`,
    [query.date || null, settings.hospitalTimezone]
  );
  const reportDate = dateRes.rows[0].report_date;
  const deptFilter = query.departmentId ? Number(query.departmentId) : null;
  const clinicFilter = query.clinicId ? Number(query.clinicId) : null;
  const statusFilter = query.status || 'ALL';

  // 1) Live Summary from v_bed_live_board
  const liveRes = await pool.query(
    `SELECT
       COUNT(*) FILTER (WHERE operational_status = 'ACTIVE')::INT AS total_active_beds,
       COUNT(*) FILTER (WHERE live_status = 'OCCUPIED')::INT AS occupied_now,
       COUNT(*) FILTER (WHERE live_status = 'RESERVED_WINDOW_ACTIVE')::INT AS reserved_current_period,
       COUNT(*) FILTER (WHERE live_status = 'FREE')::INT AS free_now,
       COUNT(*) FILTER (WHERE live_status = 'OUT_OF_SERVICE')::INT AS out_of_service
     FROM v_bed_live_board
     WHERE ($1::BIGINT IS NULL OR department_id = $1)
       AND ($2::BIGINT IS NULL OR clinic_id = $2)`,
    [deptFilter, clinicFilter]
  );

  const lRow = liveRes.rows[0];
  const liveSummary = {
    totalActiveBeds: Number(lRow.total_active_beds || 0),
    occupiedNow: Number(lRow.occupied_now || 0),
    reservedCurrentPeriod: Number(lRow.reserved_current_period || 0),
    freeNow: Number(lRow.free_now || 0),
    outOfService: Number(lRow.out_of_service || 0),
  };

  // 2) Historical / Daily Bed Booking Log from bed_tickets
  const logRes = await pool.query(
    `SELECT
       bt.ticket_id,
       bt.ticket_code,
       bt.ticket_type,
       bt.status,
       bt.bed_id,
       cb.label AS bed_label,
       cl.clinic_id,
       cl.clinic_number,
       bt.department_id,
       d.name_en AS department_name_en,
       d.name_ar AS department_name_ar,
       bt.doctor_id,
       du.full_name AS doctor_name,
       bt.patient_id,
       pu.full_name AS patient_name,
       bt.case_id,
       c.case_number,
       bt.service_date::TEXT AS service_date,
       bt.planned_start_at,
       bt.reserved_at,
       bt.occupied_at,
       bt.freed_at,
       bt.free_reason,
       bt.swapped_from_bed_id,
       CASE
         WHEN bt.occupied_at IS NOT NULL AND bt.freed_at IS NOT NULL
           THEN GREATEST(1, ROUND(EXTRACT(EPOCH FROM (bt.freed_at - bt.occupied_at)) / 60.0)::INT)
         WHEN bt.occupied_at IS NOT NULL AND bt.status = 'OCCUPIED'
           THEN GREATEST(1, ROUND(EXTRACT(EPOCH FROM (now() - bt.occupied_at)) / 60.0)::INT)
         ELSE NULL
       END AS duration_minutes
     FROM bed_tickets bt
     JOIN clinic_beds cb ON cb.bed_id = bt.bed_id
     JOIN clinics cl ON cl.clinic_id = cb.clinic_id
     JOIN departments d ON d.department_id = bt.department_id
     JOIN users du ON du.user_id = bt.doctor_id
     JOIN users pu ON pu.user_id = bt.patient_id
     JOIN cases c ON c.case_id = bt.case_id
     WHERE bt.service_date = $1::DATE
       AND ($2::BIGINT IS NULL OR bt.department_id = $2)
       AND ($3::BIGINT IS NULL OR cl.clinic_id = $3)
       AND ($4 = 'ALL' OR bt.status::TEXT = $4)
     ORDER BY COALESCE(bt.occupied_at, bt.planned_start_at, bt.created_at) DESC`,
    [reportDate, deptFilter, clinicFilter, statusFilter]
  );

  const bookingLog = logRes.rows.map((r) => {
    const referenceTimestamp = r.occupied_at || r.planned_start_at;
    const logText = buildBedDashboardLogLine({
      bedLabel: r.bed_label,
      doctorName: r.doctor_name,
      patientName: r.patient_name,
      timestamp: referenceTimestamp,
      timezone: settings.hospitalTimezone,
    });

    return {
      ticketId: Number(r.ticket_id),
      ticketCode: r.ticket_code,
      ticketType: r.ticket_type,
      status: r.status,
      clinicId: Number(r.clinic_id),
      clinicNumber: r.clinic_number,
      bedId: Number(r.bed_id),
      bedLabel: r.bed_label,
      departmentId: Number(r.department_id),
      departmentName: isAr ? r.department_name_ar : r.department_name_en,
      doctor: {
        doctorId: Number(r.doctor_id),
        fullName: r.doctor_name,
      },
      patient: {
        patientId: Number(r.patient_id),
        fullName: r.patient_name,
      },
      caseId: Number(r.case_id),
      caseNumber: r.case_number,
      plannedStartAt: r.planned_start_at,
      reservedAt: r.reserved_at,
      occupiedAt: r.occupied_at,
      freedAt: r.freed_at,
      freeReason: r.free_reason,
      swappedFromBedId: r.swapped_from_bed_id
        ? Number(r.swapped_from_bed_id)
        : null,
      durationMinutes:
        r.duration_minutes !== null ? Number(r.duration_minutes) : null,
      logText,
    };
  });

  return {
    date: reportDate,
    liveSummary,
    bookingLog,
  };
}

// =============================================================================
// 3. GET /api/v1/admin/audit-logs (§4.8)
// =============================================================================

/**
 * Queries immutable `audit_logs` with filtering and pagination.
 *
 * @param {import('z').infer<typeof auditLogsQuerySchema>} query
 */
export async function listAuditLogs(query) {
  const {
    actorUserId = null,
    entityType = null,
    entityId = null,
    action = null,
    fromDate = null,
    toDate = null,
    limit = 50,
    offset = 0,
  } = query;

  const countRes = await pool.query(
    `SELECT COUNT(*)::INT AS total_count
     FROM audit_logs al
     WHERE ($1::BIGINT IS NULL OR al.actor_user_id = $1)
       AND ($2::TEXT IS NULL OR al.entity_type = $2)
       AND ($3::BIGINT IS NULL OR al.entity_id = $3)
       AND ($4::TEXT IS NULL OR al.action = $4)
       AND ($5::DATE IS NULL OR al.created_at::DATE >= $5::DATE)
       AND ($6::DATE IS NULL OR al.created_at::DATE <= $6::DATE)`,
    [actorUserId, entityType, entityId, action, fromDate, toDate]
  );

  const { rows } = await pool.query(
    `SELECT
       al.log_id,
       al.actor_user_id,
       u.full_name AS actor_full_name,
       al.actor_role,
       al.action,
       al.entity_type,
       al.entity_id,
       al.before_data,
       al.after_data,
       al.ip_address::TEXT AS ip_address,
       al.user_agent,
       al.request_id,
       al.created_at
     FROM audit_logs al
     LEFT JOIN users u ON u.user_id = al.actor_user_id
     WHERE ($1::BIGINT IS NULL OR al.actor_user_id = $1)
       AND ($2::TEXT IS NULL OR al.entity_type = $2)
       AND ($3::BIGINT IS NULL OR al.entity_id = $3)
       AND ($4::TEXT IS NULL OR al.action = $4)
       AND ($5::DATE IS NULL OR al.created_at::DATE >= $5::DATE)
       AND ($6::DATE IS NULL OR al.created_at::DATE <= $6::DATE)
     ORDER BY al.created_at DESC, al.log_id DESC
     LIMIT $7 OFFSET $8`,
    [actorUserId, entityType, entityId, action, fromDate, toDate, limit, offset]
  );

  return {
    totalCount: Number(countRes.rows[0].total_count),
    limit,
    offset,
    logs: rows.map((r) => ({
      logId: Number(r.log_id),
      actorUserId: r.actor_user_id ? Number(r.actor_user_id) : null,
      actorFullName: r.actor_full_name || null,
      actorRole: r.actor_role,
      action: r.action,
      entityType: r.entity_type,
      entityId: r.entity_id ? Number(r.entity_id) : null,
      beforeData: r.before_data,
      afterData: r.after_data,
      ipAddress: r.ip_address,
      userAgent: r.user_agent,
      requestId: r.request_id,
      createdAt: r.created_at,
    })),
  };
}

// =============================================================================
// 4. Admin Catalog CRUD (Departments, Services, Clinics, Beds, Periods, Conditions)
// =============================================================================

export async function listAllDepartmentsAdmin() {
  const { rows } = await pool.query(
    `SELECT
       d.department_id,
       d.code,
       d.name_en,
       d.name_ar,
       d.description,
       d.is_active,
       d.display_order,
       d.created_at,
       d.updated_at,
       (SELECT COUNT(*)::INT FROM clinics c WHERE c.department_id = d.department_id) AS clinics_count,
       (SELECT COUNT(*)::INT
        FROM clinic_beds cb
        JOIN clinics c ON c.clinic_id = cb.clinic_id
        WHERE c.department_id = d.department_id AND cb.operational_status <> 'RETIRED') AS beds_count
     FROM departments d
     ORDER BY d.display_order ASC, d.department_id ASC`
  );

  return rows.map((r) => ({
    departmentId: Number(r.department_id),
    code: r.code,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    description: r.description,
    isActive: Boolean(r.is_active),
    displayOrder: Number(r.display_order),
    clinicsCount: Number(r.clinics_count),
    bedsCount: Number(r.beds_count),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function createDepartmentAdmin(actor, payload, req) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO departments (code, name_en, name_ar, description, is_active, display_order)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING department_id, code, name_en, name_ar, description, is_active, display_order, created_at`,
      [
        payload.code,
        payload.nameEn,
        payload.nameAr,
        payload.description || null,
        payload.isActive,
        payload.displayOrder,
      ]
    );
    const row = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_DEPARTMENT_CREATED',
      entityType: 'departments',
      entityId: Number(row.department_id),
      afterData: row,
      req,
    });

    return {
      departmentId: Number(row.department_id),
      code: row.code,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      description: row.description,
      isActive: Boolean(row.is_active),
      displayOrder: Number(row.display_order),
      createdAt: row.created_at,
    };
  });
}

export async function updateDepartmentAdmin(departmentId, actor, payload, req) {
  return withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT * FROM departments WHERE department_id = $1 FOR UPDATE`,
      [departmentId]
    );
    if (existingRes.rows.length === 0) {
      throw new AppError(404, 'DEPARTMENT_NOT_FOUND', 'Department not found.');
    }
    const before = existingRes.rows[0];

    const { rows } = await client.query(
      `UPDATE departments
       SET code = COALESCE($2, code),
           name_en = COALESCE($3, name_en),
           name_ar = COALESCE($4, name_ar),
           description = COALESCE($5, description),
           is_active = COALESCE($6, is_active),
           display_order = COALESCE($7, display_order),
           updated_at = now()
       WHERE department_id = $1
       RETURNING department_id, code, name_en, name_ar, description, is_active, display_order, updated_at`,
      [
        departmentId,
        payload.code ?? null,
        payload.nameEn ?? null,
        payload.nameAr ?? null,
        payload.description === undefined ? null : payload.description,
        payload.isActive ?? null,
        payload.displayOrder ?? null,
      ]
    );
    const after = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_DEPARTMENT_UPDATED',
      entityType: 'departments',
      entityId: departmentId,
      beforeData: before,
      afterData: after,
      req,
    });

    return {
      departmentId: Number(after.department_id),
      code: after.code,
      nameEn: after.name_en,
      nameAr: after.name_ar,
      description: after.description,
      isActive: Boolean(after.is_active),
      displayOrder: Number(after.display_order),
      updatedAt: after.updated_at,
    };
  });
}

export async function listAllServicesAdmin(departmentId = null) {
  const { rows } = await pool.query(
    `SELECT
       s.service_id,
       s.department_id,
       d.code AS department_code,
       d.name_en AS department_name_en,
       d.name_ar AS department_name_ar,
       s.code,
       s.name_en,
       s.name_ar,
       s.description,
       s.requires_permission,
       s.min_academic_year,
       s.typical_sessions,
       s.is_active,
       s.created_at,
       s.updated_at
     FROM services s
     JOIN departments d ON d.department_id = s.department_id
     WHERE ($1::BIGINT IS NULL OR s.department_id = $1)
     ORDER BY d.display_order ASC, s.service_id ASC`,
    [departmentId]
  );

  return rows.map((r) => ({
    serviceId: Number(r.service_id),
    departmentId: Number(r.department_id),
    departmentCode: r.department_code,
    departmentNameEn: r.department_name_en,
    departmentNameAr: r.department_name_ar,
    code: r.code,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    description: r.description,
    requiresPermission: Boolean(r.requires_permission),
    minAcademicYear: r.min_academic_year ? Number(r.min_academic_year) : null,
    typicalSessions: Number(r.typical_sessions),
    isActive: Boolean(r.is_active),
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  }));
}

export async function createServiceAdmin(actor, payload, req) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO services (
         department_id, code, name_en, name_ar, description,
         requires_permission, min_academic_year, typical_sessions, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [
        payload.departmentId,
        payload.code,
        payload.nameEn,
        payload.nameAr,
        payload.description || null,
        payload.requiresPermission,
        payload.minAcademicYear || null,
        payload.typicalSessions,
        payload.isActive,
      ]
    );
    const row = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_SERVICE_CREATED',
      entityType: 'services',
      entityId: Number(row.service_id),
      afterData: row,
      req,
    });

    return {
      serviceId: Number(row.service_id),
      departmentId: Number(row.department_id),
      code: row.code,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      description: row.description,
      requiresPermission: Boolean(row.requires_permission),
      minAcademicYear: row.min_academic_year
        ? Number(row.min_academic_year)
        : null,
      typicalSessions: Number(row.typical_sessions),
      isActive: Boolean(row.is_active),
    };
  });
}

export async function updateServiceAdmin(serviceId, actor, payload, req) {
  return withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT * FROM services WHERE service_id = $1 FOR UPDATE`,
      [serviceId]
    );
    if (existingRes.rows.length === 0) {
      throw new AppError(404, 'SERVICE_NOT_FOUND', 'Service not found.');
    }
    const before = existingRes.rows[0];

    const { rows } = await client.query(
      `UPDATE services
       SET department_id = COALESCE($2, department_id),
           code = COALESCE($3, code),
           name_en = COALESCE($4, name_en),
           name_ar = COALESCE($5, name_ar),
           description = COALESCE($6, description),
           requires_permission = COALESCE($7, requires_permission),
           min_academic_year = COALESCE($8, min_academic_year),
           typical_sessions = COALESCE($9, typical_sessions),
           is_active = COALESCE($10, is_active),
           updated_at = now()
       WHERE service_id = $1
       RETURNING *`,
      [
        serviceId,
        payload.departmentId ?? null,
        payload.code ?? null,
        payload.nameEn ?? null,
        payload.nameAr ?? null,
        payload.description === undefined ? null : payload.description,
        payload.requiresPermission ?? null,
        payload.minAcademicYear ?? null,
        payload.typicalSessions ?? null,
        payload.isActive ?? null,
      ]
    );
    const after = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_SERVICE_UPDATED',
      entityType: 'services',
      entityId: serviceId,
      beforeData: before,
      afterData: after,
      req,
    });

    return {
      serviceId: Number(after.service_id),
      departmentId: Number(after.department_id),
      code: after.code,
      nameEn: after.name_en,
      nameAr: after.name_ar,
      description: after.description,
      requiresPermission: Boolean(after.requires_permission),
      minAcademicYear: after.min_academic_year
        ? Number(after.min_academic_year)
        : null,
      typicalSessions: Number(after.typical_sessions),
      isActive: Boolean(after.is_active),
    };
  });
}

export async function listAllClinicsAdmin(departmentId = null) {
  const { rows } = await pool.query(
    `SELECT
       c.clinic_id,
       c.department_id,
       d.name_en AS department_name_en,
       d.name_ar AS department_name_ar,
       c.clinic_number,
       c.name,
       c.building,
       c.floor,
       c.is_active,
       (SELECT COUNT(*)::INT FROM clinic_beds cb WHERE cb.clinic_id = c.clinic_id) AS beds_count
     FROM clinics c
     JOIN departments d ON d.department_id = c.department_id
     WHERE ($1::BIGINT IS NULL OR c.department_id = $1)
     ORDER BY c.clinic_number ASC`,
    [departmentId]
  );

  return rows.map((r) => ({
    clinicId: Number(r.clinic_id),
    departmentId: Number(r.department_id),
    departmentNameEn: r.department_name_en,
    departmentNameAr: r.department_name_ar,
    clinicNumber: r.clinic_number,
    name: r.name,
    building: r.building,
    floor: r.floor,
    isActive: Boolean(r.is_active),
    bedsCount: Number(r.beds_count),
  }));
}

export async function createClinicAdmin(actor, payload, req) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO clinics (department_id, clinic_number, name, building, floor, is_active)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [
        payload.departmentId,
        payload.clinicNumber,
        payload.name || null,
        payload.building || null,
        payload.floor || null,
        payload.isActive,
      ]
    );
    const row = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_CLINIC_CREATED',
      entityType: 'clinics',
      entityId: Number(row.clinic_id),
      afterData: row,
      req,
    });

    return {
      clinicId: Number(row.clinic_id),
      departmentId: Number(row.department_id),
      clinicNumber: row.clinic_number,
      name: row.name,
      building: row.building,
      floor: row.floor,
      isActive: Boolean(row.is_active),
    };
  });
}

export async function updateClinicAdmin(clinicId, actor, payload, req) {
  return withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT * FROM clinics WHERE clinic_id = $1 FOR UPDATE`,
      [clinicId]
    );
    if (existingRes.rows.length === 0) {
      throw new AppError(404, 'CLINIC_NOT_FOUND', 'Clinic not found.');
    }

    const { rows } = await client.query(
      `UPDATE clinics
       SET department_id = COALESCE($2, department_id),
           clinic_number = COALESCE($3, clinic_number),
           name = COALESCE($4, name),
           building = COALESCE($5, building),
           floor = COALESCE($6, floor),
           is_active = COALESCE($7, is_active),
           updated_at = now()
       WHERE clinic_id = $1
       RETURNING *`,
      [
        clinicId,
        payload.departmentId ?? null,
        payload.clinicNumber ?? null,
        payload.name ?? null,
        payload.building ?? null,
        payload.floor ?? null,
        payload.isActive ?? null,
      ]
    );
    const after = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_CLINIC_UPDATED',
      entityType: 'clinics',
      entityId: clinicId,
      beforeData: existingRes.rows[0],
      afterData: after,
      req,
    });

    return {
      clinicId: Number(after.clinic_id),
      departmentId: Number(after.department_id),
      clinicNumber: after.clinic_number,
      name: after.name,
      building: after.building,
      floor: after.floor,
      isActive: Boolean(after.is_active),
    };
  });
}

export async function listAllBedsAdmin({ departmentId = null, clinicId = null }) {
  const { rows } = await pool.query(
    `SELECT
       b.bed_id,
       b.clinic_id,
       c.clinic_number,
       c.department_id,
       d.name_en AS department_name_en,
       b.bed_number,
       b.label,
       b.operational_status,
       b.out_of_service_reason,
       b.is_reservable,
       b.updated_at
     FROM clinic_beds b
     JOIN clinics c ON c.clinic_id = b.clinic_id
     JOIN departments d ON d.department_id = c.department_id
     WHERE ($1::BIGINT IS NULL OR c.department_id = $1)
       AND ($2::BIGINT IS NULL OR b.clinic_id = $2)
     ORDER BY c.clinic_number ASC, b.bed_number ASC`,
    [departmentId, clinicId]
  );

  return rows.map((r) => ({
    bedId: Number(r.bed_id),
    clinicId: Number(r.clinic_id),
    clinicNumber: r.clinic_number,
    departmentId: Number(r.department_id),
    departmentNameEn: r.department_name_en,
    bedNumber: Number(r.bed_number),
    label: r.label,
    operationalStatus: r.operational_status,
    outOfServiceReason: r.out_of_service_reason,
    isReservable: Boolean(r.is_reservable),
    updatedAt: r.updated_at,
  }));
}

export async function createBedAdmin(actor, payload, req) {
  return withTransaction(async (client) => {
    if (
      payload.operationalStatus === 'OUT_OF_SERVICE' &&
      !payload.outOfServiceReason
    ) {
      throw new AppError(
        422,
        'OUT_OF_SERVICE_REASON_REQUIRED',
        'outOfServiceReason is required when operationalStatus is OUT_OF_SERVICE.'
      );
    }

    const { rows } = await client.query(
      `INSERT INTO clinic_beds (
         clinic_id, bed_number, label, operational_status, out_of_service_reason, is_reservable
       )
       VALUES ($1, $2, $3, $4::bed_operational_status, $5, $6)
       RETURNING *`,
      [
        payload.clinicId,
        payload.bedNumber,
        payload.label,
        payload.operationalStatus,
        payload.outOfServiceReason || null,
        payload.isReservable,
      ]
    );
    const row = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_BED_CREATED',
      entityType: 'clinic_beds',
      entityId: Number(row.bed_id),
      afterData: row,
      req,
    });

    return {
      bedId: Number(row.bed_id),
      clinicId: Number(row.clinic_id),
      bedNumber: Number(row.bed_number),
      label: row.label,
      operationalStatus: row.operational_status,
      outOfServiceReason: row.out_of_service_reason,
      isReservable: Boolean(row.is_reservable),
    };
  });
}

export async function updateBedAdmin(bedId, actor, payload, req) {
  return withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT * FROM clinic_beds WHERE bed_id = $1 FOR UPDATE`,
      [bedId]
    );
    if (existingRes.rows.length === 0) {
      throw new AppError(404, 'BED_NOT_FOUND', 'Clinic bed not found.');
    }
    const before = existingRes.rows[0];
    const targetStatus =
      payload.operationalStatus ?? before.operational_status;
    const targetReason =
      payload.outOfServiceReason !== undefined
        ? payload.outOfServiceReason
        : before.out_of_service_reason;

    if (targetStatus === 'OUT_OF_SERVICE' && !targetReason) {
      throw new AppError(
        422,
        'OUT_OF_SERVICE_REASON_REQUIRED',
        'outOfServiceReason is required when operationalStatus is OUT_OF_SERVICE.'
      );
    }

    const { rows } = await client.query(
      `UPDATE clinic_beds
       SET clinic_id = COALESCE($2, clinic_id),
           bed_number = COALESCE($3, bed_number),
           label = COALESCE($4, label),
           operational_status = $5::bed_operational_status,
           out_of_service_reason = $6,
           is_reservable = COALESCE($7, is_reservable),
           version = version + 1,
           updated_at = now()
       WHERE bed_id = $1
       RETURNING *`,
      [
        bedId,
        payload.clinicId ?? null,
        payload.bedNumber ?? null,
        payload.label ?? null,
        targetStatus,
        targetStatus === 'OUT_OF_SERVICE' ? targetReason : null,
        payload.isReservable ?? null,
      ]
    );
    const after = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_BED_UPDATED',
      entityType: 'clinic_beds',
      entityId: bedId,
      beforeData: before,
      afterData: after,
      req,
    });

    return {
      bedId: Number(after.bed_id),
      clinicId: Number(after.clinic_id),
      bedNumber: Number(after.bed_number),
      label: after.label,
      operationalStatus: after.operational_status,
      outOfServiceReason: after.out_of_service_reason,
      isReservable: Boolean(after.is_reservable),
    };
  });
}

export async function listAllPeriodsAdmin() {
  const { rows } = await pool.query(
    `SELECT
       period_id,
       code,
       name_en,
       name_ar,
       start_time::TEXT AS start_time,
       end_time::TEXT AS end_time,
       display_order,
       is_active
     FROM bed_ticket_periods
     ORDER BY display_order ASC, start_time ASC`
  );

  return rows.map((r) => ({
    periodId: Number(r.period_id),
    code: r.code,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    startTime: r.start_time,
    endTime: r.end_time,
    displayOrder: Number(r.display_order),
    isActive: Boolean(r.is_active),
  }));
}

export async function createPeriodAdmin(actor, payload, req) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO bed_ticket_periods (code, name_en, name_ar, start_time, end_time, display_order, is_active)
       VALUES ($1, $2, $3, $4::TIME, $5::TIME, $6, $7)
       RETURNING period_id, code, name_en, name_ar, start_time::TEXT AS start_time, end_time::TEXT AS end_time, display_order, is_active`,
      [
        payload.code,
        payload.nameEn,
        payload.nameAr,
        payload.startTime,
        payload.endTime,
        payload.displayOrder,
        payload.isActive,
      ]
    );
    const row = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_PERIOD_CREATED',
      entityType: 'bed_ticket_periods',
      entityId: Number(row.period_id),
      afterData: row,
      req,
    });

    return {
      periodId: Number(row.period_id),
      code: row.code,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      startTime: row.start_time,
      endTime: row.end_time,
      displayOrder: Number(row.display_order),
      isActive: Boolean(row.is_active),
    };
  });
}

export async function updatePeriodAdmin(periodId, actor, payload, req) {
  return withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT * FROM bed_ticket_periods WHERE period_id = $1 FOR UPDATE`,
      [periodId]
    );
    if (existingRes.rows.length === 0) {
      throw new AppError(404, 'PERIOD_NOT_FOUND', 'Period not found.');
    }

    const { rows } = await client.query(
      `UPDATE bed_ticket_periods
       SET code = COALESCE($2, code),
           name_en = COALESCE($3, name_en),
           name_ar = COALESCE($4, name_ar),
           start_time = COALESCE($5::TIME, start_time),
           end_time = COALESCE($6::TIME, end_time),
           display_order = COALESCE($7, display_order),
           is_active = COALESCE($8, is_active)
       WHERE period_id = $1
       RETURNING period_id, code, name_en, name_ar, start_time::TEXT AS start_time, end_time::TEXT AS end_time, display_order, is_active`,
      [
        periodId,
        payload.code ?? null,
        payload.nameEn ?? null,
        payload.nameAr ?? null,
        payload.startTime ?? null,
        payload.endTime ?? null,
        payload.displayOrder ?? null,
        payload.isActive ?? null,
      ]
    );
    const after = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_PERIOD_UPDATED',
      entityType: 'bed_ticket_periods',
      entityId: periodId,
      beforeData: existingRes.rows[0],
      afterData: after,
      req,
    });

    return {
      periodId: Number(after.period_id),
      code: after.code,
      nameEn: after.name_en,
      nameAr: after.name_ar,
      startTime: after.start_time,
      endTime: after.end_time,
      displayOrder: Number(after.display_order),
      isActive: Boolean(after.is_active),
    };
  });
}

export async function listAllMedicalConditionsAdmin() {
  const { rows } = await pool.query(
    `SELECT
       condition_id,
       code,
       category,
       name_en,
       name_ar,
       question_text_en,
       question_text_ar,
       is_critical,
       requires_document_if_yes,
       checklist_options,
       risk_flag_id,
       is_sensitive,
       applies_to_gender,
       display_order,
       is_active
     FROM medical_conditions
     ORDER BY is_critical DESC, display_order ASC`
  );

  return rows.map((r) => ({
    conditionId: Number(r.condition_id),
    code: r.code,
    category: r.category,
    nameEn: r.name_en,
    nameAr: r.name_ar,
    questionTextEn: r.question_text_en,
    questionTextAr: r.question_text_ar,
    isCritical: Boolean(r.is_critical),
    requiresDocumentIfYes: Boolean(r.requires_document_if_yes),
    checklistOptions: r.checklist_options || [],
    riskFlagId: r.risk_flag_id ? Number(r.risk_flag_id) : null,
    isSensitive: Boolean(r.is_sensitive),
    appliesToGender: r.applies_to_gender,
    displayOrder: Number(r.display_order),
    isActive: Boolean(r.is_active),
  }));
}

export async function createMedicalConditionAdmin(actor, payload, req) {
  return withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO medical_conditions (
         code, category, name_en, name_ar, question_text_en, question_text_ar,
         is_critical, requires_document_if_yes, checklist_options, risk_flag_id,
         is_sensitive, applies_to_gender, display_order, is_active
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12::gender_type, $13, $14)
       RETURNING *`,
      [
        payload.code,
        payload.category,
        payload.nameEn,
        payload.nameAr,
        payload.questionTextEn,
        payload.questionTextAr,
        payload.isCritical,
        payload.requiresDocumentIfYes,
        JSON.stringify(payload.checklistOptions || []),
        payload.riskFlagId || null,
        payload.isSensitive,
        payload.appliesToGender || null,
        payload.displayOrder,
        payload.isActive,
      ]
    );
    const row = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_MEDICAL_CONDITION_CREATED',
      entityType: 'medical_conditions',
      entityId: Number(row.condition_id),
      afterData: row,
      req,
    });

    return {
      conditionId: Number(row.condition_id),
      code: row.code,
      category: row.category,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      questionTextEn: row.question_text_en,
      questionTextAr: row.question_text_ar,
      isCritical: Boolean(row.is_critical),
      requiresDocumentIfYes: Boolean(row.requires_document_if_yes),
      checklistOptions: row.checklist_options || [],
      riskFlagId: row.risk_flag_id ? Number(row.risk_flag_id) : null,
      isSensitive: Boolean(row.is_sensitive),
      appliesToGender: row.applies_to_gender,
      displayOrder: Number(row.display_order),
      isActive: Boolean(row.is_active),
    };
  });
}

export async function updateMedicalConditionAdmin(
  conditionId,
  actor,
  payload,
  req
) {
  return withTransaction(async (client) => {
    const existingRes = await client.query(
      `SELECT * FROM medical_conditions WHERE condition_id = $1 FOR UPDATE`,
      [conditionId]
    );
    if (existingRes.rows.length === 0) {
      throw new AppError(
        404,
        'MEDICAL_CONDITION_NOT_FOUND',
        'Medical condition not found.'
      );
    }

    const { rows } = await client.query(
      `UPDATE medical_conditions
       SET code = COALESCE($2, code),
           category = COALESCE($3, category),
           name_en = COALESCE($4, name_en),
           name_ar = COALESCE($5, name_ar),
           question_text_en = COALESCE($6, question_text_en),
           question_text_ar = COALESCE($7, question_text_ar),
           is_critical = COALESCE($8, is_critical),
           requires_document_if_yes = COALESCE($9, requires_document_if_yes),
           checklist_options = COALESCE($10::jsonb, checklist_options),
           risk_flag_id = COALESCE($11, risk_flag_id),
           is_sensitive = COALESCE($12, is_sensitive),
           applies_to_gender = COALESCE($13::gender_type, applies_to_gender),
           display_order = COALESCE($14, display_order),
           is_active = COALESCE($15, is_active),
           updated_at = now()
       WHERE condition_id = $1
       RETURNING *`,
      [
        conditionId,
        payload.code ?? null,
        payload.category ?? null,
        payload.nameEn ?? null,
        payload.nameAr ?? null,
        payload.questionTextEn ?? null,
        payload.questionTextAr ?? null,
        payload.isCritical ?? null,
        payload.requiresDocumentIfYes ?? null,
        payload.checklistOptions
          ? JSON.stringify(payload.checklistOptions)
          : null,
        payload.riskFlagId ?? null,
        payload.isSensitive ?? null,
        payload.appliesToGender ?? null,
        payload.displayOrder ?? null,
        payload.isActive ?? null,
      ]
    );
    const after = rows[0];

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'ADMIN_MEDICAL_CONDITION_UPDATED',
      entityType: 'medical_conditions',
      entityId: conditionId,
      beforeData: existingRes.rows[0],
      afterData: after,
      req,
    });

    return {
      conditionId: Number(after.condition_id),
      code: after.code,
      category: after.category,
      nameEn: after.name_en,
      nameAr: after.name_ar,
      questionTextEn: after.question_text_en,
      questionTextAr: after.question_text_ar,
      isCritical: Boolean(after.is_critical),
      requiresDocumentIfYes: Boolean(after.requires_document_if_yes),
      checklistOptions: after.checklist_options || [],
      riskFlagId: after.risk_flag_id ? Number(after.risk_flag_id) : null,
      isSensitive: Boolean(after.is_sensitive),
      appliesToGender: after.applies_to_gender,
      displayOrder: Number(after.display_order),
      isActive: Boolean(after.is_active),
    };
  });
}
