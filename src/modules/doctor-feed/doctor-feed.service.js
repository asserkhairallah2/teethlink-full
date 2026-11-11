import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import { createNotification, writeAuditLog } from '../../utils/audit.js';
import { emitToRooms, emitToUser } from '../../realtime/socketGateway.js';
import { generateSignedFileUrl } from '../files/files.service.js';

export const doctorFeedQuerySchema = z.object({
  departmentId: z.coerce.number().int().positive().optional(),
  serviceId: z.coerce.number().int().positive().optional(),
  toothType: z
    .enum(['INCISOR', 'CANINE', 'PREMOLAR', 'MOLAR', 'MULTIPLE', 'NOT_APPLICABLE'])
    .optional(),
  priority: z.enum(['ROUTINE', 'PRIORITY', 'URGENT']).optional(),
  cursor: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const claimCaseBodySchema = z.object({
  serviceId: z.coerce.number().int().positive().nullable().optional(),
});

export const updateCaseServiceSchema = z.object({
  serviceId: z.coerce.number().int().positive(),
});

export const releaseCaseSchema = z.object({
  reason: z.string().trim().min(3, 'A release reason of at least 3 characters is required.').max(500),
});

/**
 * GET /api/v1/doctor/feed
 * Returns the InDrive-style department broadcast feed of `WAITING_FOR_DOCTOR` cases
 * in the doctor's active departments (excluding `doctor_hidden_cases`), enforcing the §0.4
 * privacy rule (patient `age`, `gender`, `hasCriticalCondition`, `medicalDocumentStatus`,
 * and `riskFlags` only — never `fullName` or `phone` before claim) (§4.4).
 *
 * @param {{ userId: number, role: string, departmentIds?: number[] }} actor
 * @param {import('z').infer<typeof doctorFeedQuerySchema>} queryParams
 * @param {'ar' | 'en'} [lang='ar']
 */
export async function getDoctorWaitingFeed(actor, queryParams, lang = 'ar') {
  const isAr = lang === 'ar';
  let targetDepartmentIds = [];

  if (actor.role === 'DOCTOR') {
    const { rows: deptRows } = await pool.query(
      `SELECT department_id
       FROM doctor_departments
       WHERE doctor_id = $1
         AND is_active = TRUE
       ORDER BY department_id ASC`,
      [actor.userId]
    );
    const activeDeptIds = deptRows.map((r) => Number(r.department_id));

    if (queryParams.departmentId) {
      const requestedDept = Number(queryParams.departmentId);
      if (!activeDeptIds.includes(requestedDept)) {
        throw new AppError(
          403,
          'DOCTOR_NOT_IN_DEPARTMENT',
          `You are not an active member of department ${requestedDept}.`
        );
      }
      targetDepartmentIds = [requestedDept];
    } else {
      targetDepartmentIds = activeDeptIds;
    }

    if (targetDepartmentIds.length === 0) {
      return { items: [], nextCursor: null };
    }
  } else {
    // SUPERVISOR or ADMIN
    if (queryParams.departmentId) {
      targetDepartmentIds = [Number(queryParams.departmentId)];
    } else {
      const { rows } = await pool.query(
        `SELECT department_id FROM departments WHERE is_active = TRUE ORDER BY department_id ASC`
      );
      targetDepartmentIds = rows.map((r) => Number(r.department_id));
    }
  }

  const conditions = [
    `c.status = 'WAITING_FOR_DOCTOR'`,
    `c.department_id = ANY($1::bigint[])`,
    `NOT EXISTS (
       SELECT 1
       FROM doctor_hidden_cases dhc
       WHERE dhc.doctor_id = $2
         AND dhc.case_id = c.case_id
     )`,
  ];
  const params = [targetDepartmentIds, Number(actor.userId)];
  let paramIdx = 3;

  if (queryParams.serviceId) {
    conditions.push(`c.service_id = $${paramIdx}`);
    params.push(Number(queryParams.serviceId));
    paramIdx += 1;
  }

  if (queryParams.toothType) {
    conditions.push(`c.tooth_type = $${paramIdx}::tooth_type`);
    params.push(queryParams.toothType);
    paramIdx += 1;
  }

  if (queryParams.priority) {
    conditions.push(`c.priority = $${paramIdx}::case_priority`);
    params.push(queryParams.priority);
    paramIdx += 1;
  }

  if (queryParams.cursor) {
    conditions.push(`c.case_id > $${paramIdx}`);
    params.push(Number(queryParams.cursor));
    paramIdx += 1;
  }

  const limit = Number(queryParams.limit || 20);
  params.push(limit + 1);
  const limitParamIdx = paramIdx;

  const sql = `
    SELECT
      c.case_id,
      c.case_number,
      c.department_id,
      d.code AS department_code,
      d.name_en AS department_name_en,
      d.name_ar AS department_name_ar,
      c.service_id,
      s.code AS service_code,
      s.name_en AS service_name_en,
      s.name_ar AS service_name_ar,
      COALESCE(s.requires_permission, FALSE) AS requires_permission,
      c.tooth_numbers,
      c.tooth_type,
      c.procedure_details,
      c.triage_notes,
      c.priority,
      c.broadcasted_at,
      CASE
        WHEN pp.date_of_birth IS NOT NULL
        THEN EXTRACT(YEAR FROM age(CURRENT_DATE, pp.date_of_birth))::INT
        ELSE NULL
      END AS patient_age,
      pp.gender AS patient_gender,
      pp.has_critical_condition,
      pp.medical_document_status,
      (
        NOT COALESCE(s.requires_permission, FALSE)
        OR EXISTS (
          SELECT 1
          FROM doctor_service_permissions dsp
          WHERE dsp.doctor_id = $2
            AND dsp.service_id = c.service_id
            AND dsp.is_active = TRUE
        )
      ) AS can_current_doctor_claim,
      COALESCE(
        (
          SELECT jsonb_agg(
            jsonb_build_object(
              'code', rf.code,
              'nameEn', rf.name_en,
              'nameAr', rf.name_ar,
              'severity', rf.severity
            )
            ORDER BY
              CASE rf.severity WHEN 'HIGH' THEN 1 WHEN 'CAUTION' THEN 2 ELSE 3 END,
              rf.code ASC
          )
          FROM case_risk_flags crf
          JOIN risk_flags rf ON rf.risk_flag_id = crf.risk_flag_id
          WHERE crf.case_id = c.case_id
        ),
        '[]'::jsonb
      ) AS risk_flags
    FROM cases c
    JOIN departments d ON d.department_id = c.department_id
    LEFT JOIN services s ON s.service_id = c.service_id
    JOIN patient_profiles pp ON pp.patient_id = c.patient_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY
      CASE c.priority WHEN 'URGENT' THEN 3 WHEN 'PRIORITY' THEN 2 ELSE 1 END DESC,
      c.broadcasted_at ASC,
      c.case_id ASC
    LIMIT $${limitParamIdx}
  `;

  const { rows } = await pool.query(sql, params);

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const items = pageRows.map((row) => ({
    caseId: Number(row.case_id),
    caseNumber: row.case_number,
    department: {
      departmentId: Number(row.department_id),
      code: row.department_code,
      name: isAr ? row.department_name_ar : row.department_name_en,
      nameEn: row.department_name_en,
      nameAr: row.department_name_ar,
    },
    service: row.service_id
      ? {
          serviceId: Number(row.service_id),
          code: row.service_code,
          name: isAr ? row.service_name_ar : row.service_name_en,
          nameEn: row.service_name_en,
          nameAr: row.service_name_ar,
          requiresPermission: Boolean(row.requires_permission),
        }
      : null,
    toothNumbers: Array.isArray(row.tooth_numbers)
      ? row.tooth_numbers.map((t) => Number(t))
      : [],
    toothType: row.tooth_type || null,
    procedureDetails: row.procedure_details || null,
    triageNotes: row.triage_notes || null,
    priority: row.priority,
    broadcastedAt: row.broadcasted_at,
    patientPreview: {
      age: row.patient_age !== null ? Number(row.patient_age) : null,
      gender: row.patient_gender || null,
      hasCriticalCondition: Boolean(row.has_critical_condition),
      medicalDocumentStatus: row.medical_document_status,
    },
    riskFlags: (row.risk_flags || []).map((rf) => ({
      code: rf.code,
      name: isAr ? rf.nameAr : rf.nameEn,
      nameEn: rf.nameEn,
      nameAr: rf.nameAr,
      severity: rf.severity,
    })),
    canCurrentDoctorClaim: Boolean(row.can_current_doctor_claim),
  }));

  const nextCursor =
    hasMore && items.length > 0 ? items[items.length - 1].caseId : null;

  return {
    items,
    nextCursor,
  };
}

/**
 * POST /api/v1/cases/:caseId/claim
 * Executes the exact atomic claim transaction in §3.4.2 & §4.4:
 * - Locks `student_doctor_profiles` (`FOR UPDATE`) and checks active case count against `max_active_cases`
 * - Locks `cases` (`FOR UPDATE OF c NOWAIT`) with `LEFT JOIN services s ON s.service_id = c.service_id`
 * - Verifies `status = 'WAITING_FOR_DOCTOR'`, doctor membership in `department_id`, and `doctor_service_permissions`
 *   if `COALESCE(s.requires_permission, FALSE) = TRUE`
 * - Updates `cases` (`status = 'CLAIMED'`, `assigned_doctor_id`, optional `service_id`, `claimed_at = now()`)
 * - Inserts `case_assignments` and `case_status_history`
 * - Upserts `chat_conversations` (`status = 'OPEN'`) and inserts the system welcome message
 * - Inserts `notifications` (`CASE_CLAIMED`) for the patient
 * - Emits `dept.case_removed` to `dept:{departmentId}` and `case.claimed` to `user:{patientId}` via `afterCommit()`
 *
 * @param {number} caseId
 * @param {number} doctorId
 * @param {import('z').infer<typeof claimCaseBodySchema>} payload
 * @param {import('express').Request} req
 */
export async function claimCaseFromFeed(caseId, doctorId, payload, req) {
  const isAr = (req?.lang || 'ar') === 'ar';

  return withTransaction(
    async (client, afterCommit) => {
      // 1) Lock the Doctor's profile row (serializes concurrent claims by the SAME doctor)
      const docRes = await client.query(
        `SELECT
           d.doctor_id,
           d.doctor_category,
           d.academic_year,
           d.university,
           d.college,
           d.max_active_cases,
           u.full_name AS doctor_name,
           u.phone AS doctor_phone,
           u.account_status
         FROM student_doctor_profiles d
         JOIN users u ON u.user_id = d.doctor_id
         WHERE d.doctor_id = $1
         FOR UPDATE`,
        [doctorId]
      );

      if (docRes.rows.length === 0) {
        throw new AppError(404, 'DOCTOR_PROFILE_NOT_FOUND', 'Doctor profile was not found.');
      }

      const doctorProfile = docRes.rows[0];
      if (doctorProfile.account_status !== 'ACTIVE') {
        throw new AppError(403, 'ACCOUNT_NOT_ACTIVE', 'Doctor account is not active.');
      }

      // 2) Check doctor's current active case count against max_active_cases
      const activeCountRes = await client.query(
        `SELECT COUNT(*)::INT AS active_count
         FROM cases
         WHERE assigned_doctor_id = $1
           AND status IN ('CLAIMED', 'SCHEDULED', 'IN_TREATMENT', 'AWAITING_OUTCOME', 'NEEDS_FOLLOW_UP')`,
        [doctorId]
      );

      const activeCount = Number(activeCountRes.rows[0].active_count);
      const maxActiveCases = Number(doctorProfile.max_active_cases || 5);
      if (activeCount >= maxActiveCases) {
        throw new AppError(
          422,
          'DOCTOR_MAX_ACTIVE_CASES_REACHED',
          `You have reached your maximum limit of ${maxActiveCases} active cases (${activeCount}/${maxActiveCases}). Complete or release an existing case before claiming another.`,
          { activeCount, maxActiveCases }
        );
      }

      // 3) Lock the target Case row with NOWAIT (uses LEFT JOIN services per §3.4.2)
      const caseRes = await client.query(
        `SELECT
           c.case_id,
           c.case_number,
           c.patient_id,
           c.department_id,
           c.service_id,
           c.status,
           c.assigned_doctor_id,
           COALESCE(s.requires_permission, FALSE) AS requires_permission,
           d.name_en AS department_name_en,
           d.name_ar AS department_name_ar
         FROM cases c
         LEFT JOIN departments d ON d.department_id = c.department_id
         LEFT JOIN services s ON s.service_id = c.service_id
         WHERE c.case_id = $1
         FOR UPDATE OF c NOWAIT`,
        [caseId]
      );

      if (caseRes.rows.length === 0) {
        throw new AppError(404, 'CASE_NOT_FOUND', `Case ${caseId} was not found.`);
      }

      const caseRow = caseRes.rows[0];

      if (caseRow.status !== 'WAITING_FOR_DOCTOR' || caseRow.assigned_doctor_id !== null) {
        throw new AppError(
          409,
          'CASE_ALREADY_CLAIMED',
          'This case has already been claimed by another doctor or is no longer waiting for a doctor.'
        );
      }

      const caseDepartmentId = Number(caseRow.department_id);
      const patientId = Number(caseRow.patient_id);

      // 4) Verify doctor belongs to the routed department
      const deptMemberRes = await client.query(
        `SELECT 1
         FROM doctor_departments dd
         WHERE dd.doctor_id = $1
           AND dd.department_id = $2
           AND dd.is_active = TRUE
         LIMIT 1`,
        [doctorId, caseDepartmentId]
      );

      if (deptMemberRes.rowCount === 0) {
        throw new AppError(
          403,
          'DOCTOR_NOT_IN_DEPARTMENT',
          'You are not an active member of the department to which this case was routed.'
        );
      }

      // Resolve effective service_id and requires_permission
      let effectiveServiceId =
        caseRow.service_id !== null ? Number(caseRow.service_id) : null;
      let effectiveRequiresPermission = Boolean(caseRow.requires_permission);

      if (effectiveServiceId === null && payload.serviceId) {
        const requestedServiceId = Number(payload.serviceId);
        const svcRes = await client.query(
          `SELECT service_id, requires_permission
           FROM services
           WHERE service_id = $1
             AND department_id = $2
             AND is_active = TRUE
           LIMIT 1`,
          [requestedServiceId, caseDepartmentId]
        );

        if (svcRes.rows.length === 0) {
          throw new AppError(
            422,
            'INVALID_DEPARTMENT_SERVICE_PAIR',
            `Service ID ${requestedServiceId} does not belong to Department ${caseDepartmentId} or is inactive.`
          );
        }

        effectiveServiceId = requestedServiceId;
        effectiveRequiresPermission = Boolean(svcRes.rows[0].requires_permission);
      }

      if (effectiveServiceId !== null && effectiveRequiresPermission) {
        const permRes = await client.query(
          `SELECT 1
           FROM doctor_service_permissions dsp
           WHERE dsp.doctor_id = $1
             AND dsp.service_id = $2
             AND dsp.is_active = TRUE
           LIMIT 1`,
          [doctorId, effectiveServiceId]
        );

        if (permRes.rowCount === 0) {
          throw new AppError(
            403,
            'SERVICE_PERMISSION_REQUIRED',
            'Claiming this specialized sub-service requires an active supervisor/admin service permission.'
          );
        }
      }

      // 5) Atomically assign the case to this doctor
      const updCaseRes = await client.query(
        `UPDATE cases
         SET status             = 'CLAIMED',
             assigned_doctor_id = $1,
             service_id         = COALESCE(service_id, $3),
             claimed_at         = now(),
             version            = version + 1,
             updated_at         = now()
         WHERE case_id = $2
         RETURNING claimed_at, service_id`,
        [doctorId, caseId, effectiveServiceId]
      );
      const claimedAt = updCaseRes.rows[0].claimed_at;

      // 6) Insert active assignment record (protected by uq_case_active_assignment)
      const assignRes = await client.query(
        `INSERT INTO case_assignments (case_id, doctor_id, assigned_at)
         VALUES ($1, $2, now())
         RETURNING assignment_id`,
        [caseId, doctorId]
      );
      const assignmentId = Number(assignRes.rows[0].assignment_id);

      // 7) Record state transition
      await client.query(
        `INSERT INTO case_status_history (
           case_id,
           from_status,
           to_status,
           changed_by,
           reason,
           metadata
         )
         VALUES ($1, 'WAITING_FOR_DOCTOR', 'CLAIMED', $2, 'Claimed from department broadcast feed', $3::jsonb)`,
        [
          caseId,
          doctorId,
          JSON.stringify({ assignmentId, serviceId: effectiveServiceId }),
        ]
      );

      // 8) Open (or reopen) the Doctor–Patient real-time Chat Conversation + system welcome message
      const convRes = await client.query(
        `INSERT INTO chat_conversations (case_id, patient_id, doctor_id, status, opened_at)
         VALUES ($1, $2, $3, 'OPEN', now())
         ON CONFLICT (case_id, doctor_id) DO UPDATE
           SET status = 'OPEN',
               read_only_at = NULL,
               closed_at = NULL
         RETURNING conversation_id`,
        [caseId, patientId, doctorId]
      );
      const conversationId = Number(convRes.rows[0].conversation_id);

      const sysMsgBody = `Dr. ${doctorProfile.doctor_name} has accepted your case (${caseRow.case_number}).`;
      const msgRes = await client.query(
        `INSERT INTO chat_messages (conversation_id, sender_id, message_type, body)
         VALUES ($1, NULL, 'SYSTEM', $2)
         RETURNING message_id, created_at`,
        [conversationId, sysMsgBody]
      );
      const welcomeMsg = msgRes.rows[0];

      await client.query(
        `UPDATE chat_conversations
         SET last_message_id = $2,
             last_message_at = $3
         WHERE conversation_id = $1`,
        [conversationId, Number(welcomeMsg.message_id), welcomeMsg.created_at]
      );

      // 9) Fetch full patient details + risk flags to return to the claiming doctor (§0.4 & §4.4)
      const [patientRes, flagsRes] = await Promise.all([
        client.query(
          `SELECT
             u.user_id AS patient_id,
             u.full_name,
             u.phone,
             u.preferred_language,
             CASE
               WHEN pp.date_of_birth IS NOT NULL
               THEN EXTRACT(YEAR FROM age(CURRENT_DATE, pp.date_of_birth))::INT
               ELSE NULL
             END AS age,
             pp.gender,
             pp.has_critical_condition,
             pp.medical_document_status,
             pp.medical_attachment_url
           FROM users u
           JOIN patient_profiles pp ON pp.patient_id = u.user_id
           WHERE u.user_id = $1`,
          [patientId]
        ),
        client.query(
          `SELECT
             rf.code,
             rf.name_en,
             rf.name_ar,
             rf.severity
           FROM case_risk_flags crf
           JOIN risk_flags rf ON rf.risk_flag_id = crf.risk_flag_id
           WHERE crf.case_id = $1
           ORDER BY
             CASE rf.severity WHEN 'HIGH' THEN 1 WHEN 'CAUTION' THEN 2 ELSE 3 END,
             rf.code ASC`,
          [caseId]
        ),
      ]);

      const patientRow = patientRes.rows[0];
      const patientIsAr = patientRow.preferred_language !== 'en';

      // 10) Create persistent in-app notification for the Patient
      await createNotification(
        client,
        {
          userId: patientId,
          type: 'CASE_CLAIMED',
          title: patientIsAr
            ? 'تم قبول حالتك من قبل الطبيب'
            : 'Doctor Assigned to Your Case',
          body: patientIsAr
            ? `قام د. ${doctorProfile.doctor_name} بقبول حالتك (${caseRow.case_number}). يمكنك الآن التواصل عبر المحادثة أو الاتصال.`
            : `Dr. ${doctorProfile.doctor_name} has accepted your case (${caseRow.case_number}). You can now chat or call.`,
          data: {
            caseId,
            caseNumber: caseRow.case_number,
            doctorId,
            doctorName: doctorProfile.doctor_name,
            doctorPhone: doctorProfile.doctor_phone,
            conversationId,
          },
          caseId,
        },
        afterCommit
      );

      await writeAuditLog(client, {
        actorUserId: doctorId,
        actorRole: 'DOCTOR',
        action: 'CASE_CLAIMED',
        entityType: 'cases',
        entityId: caseId,
        beforeData: { status: 'WAITING_FOR_DOCTOR', assignedDoctorId: null },
        afterData: {
          status: 'CLAIMED',
          assignedDoctorId: doctorId,
          assignmentId,
          conversationId,
          serviceId: effectiveServiceId,
        },
        req,
      });

      const doctorSummaryForPatient = {
        doctorId,
        fullName: doctorProfile.doctor_name,
        phone: doctorProfile.doctor_phone,
        doctorCategory: doctorProfile.doctor_category,
        academicYear:
          doctorProfile.academic_year !== null
            ? Number(doctorProfile.academic_year)
            : null,
        university: doctorProfile.university || null,
        college: doctorProfile.college || null,
        departmentId: caseDepartmentId,
        departmentName: isAr
          ? caseRow.department_name_ar
          : caseRow.department_name_en,
        departmentNameEn: caseRow.department_name_en,
        departmentNameAr: caseRow.department_name_ar,
      };

      // 11) Post-Commit Hook: remove case from all department doctors' feeds + notify patient
      afterCommit(() => {
        emitToRooms(
          [`dept:${caseDepartmentId}`, 'admin:dashboard'],
          'dept.case_removed',
          {
            caseId,
            caseNumber: caseRow.case_number,
            departmentId: caseDepartmentId,
            reason: 'CLAIMED',
            claimedByDoctorId: doctorId,
          }
        );

        emitToUser(patientId, 'case.claimed', {
          caseId,
          caseNumber: caseRow.case_number,
          status: 'CLAIMED',
          claimedAt,
          conversationId,
          doctor: doctorSummaryForPatient,
        });
      });

      return {
        caseId,
        caseNumber: caseRow.case_number,
        status: 'CLAIMED',
        claimedAt,
        serviceId: effectiveServiceId,
        conversationId,
        patient: {
          patientId,
          fullName: patientRow.full_name,
          phone: patientRow.phone,
          age: patientRow.age !== null ? Number(patientRow.age) : null,
          gender: patientRow.gender || null,
          hasCriticalCondition: Boolean(patientRow.has_critical_condition),
          medicalDocumentStatus: patientRow.medical_document_status,
          medicalAttachmentUrl: patientRow.medical_attachment_url
            ? generateSignedFileUrl(patientRow.medical_attachment_url)
            : null,
          riskFlags: flagsRes.rows.map((rf) => ({
            code: rf.code,
            name: isAr ? rf.name_ar : rf.name_en,
            nameEn: rf.name_en,
            nameAr: rf.name_ar,
            severity: rf.severity,
          })),
        },
      };
    },
    { lockContext: 'CASE' }
  );
}

/**
 * PATCH /api/v1/cases/:caseId/service
 * Allows the assigned doctor (or supervisor/admin) to set or update `cases.service_id`
 * when `service_id` was left `NULL` at triage or refined after examining the patient (§4.4).
 *
 * @param {number} caseId
 * @param {{ userId: number, role: string }} actor
 * @param {import('z').infer<typeof updateCaseServiceSchema>} payload
 * @param {import('express').Request} req
 */
export async function updateCaseSubService(caseId, actor, payload, req) {
  const isAr = (req?.lang || 'ar') === 'ar';

  return withTransaction(async (client) => {
    const caseRes = await client.query(
      `SELECT
         case_id,
         case_number,
         department_id,
         service_id,
         assigned_doctor_id,
         status
       FROM cases
       WHERE case_id = $1
       FOR UPDATE`,
      [caseId]
    );

    if (caseRes.rows.length === 0) {
      throw new AppError(404, 'CASE_NOT_FOUND', `Case ${caseId} was not found.`);
    }

    const caseRow = caseRes.rows[0];

    if (
      actor.role === 'DOCTOR' &&
      Number(caseRow.assigned_doctor_id) !== Number(actor.userId)
    ) {
      throw new AppError(
        403,
        'NOT_ASSIGNED_DOCTOR',
        'Only the doctor assigned to this case (or a supervisor/admin) can update its sub-service.'
      );
    }

    if (!caseRow.department_id) {
      throw new AppError(
        422,
        'CASE_NOT_ROUTED_TO_DEPARTMENT',
        'Cannot assign a sub-service before the case has been routed to a department.'
      );
    }

    const serviceId = Number(payload.serviceId);
    const departmentId = Number(caseRow.department_id);

    const svcRes = await client.query(
      `SELECT
         service_id,
         department_id,
         code,
         name_en,
         name_ar,
         requires_permission
       FROM services
       WHERE service_id = $1
         AND department_id = $2
         AND is_active = TRUE
       LIMIT 1`,
      [serviceId, departmentId]
    );

    if (svcRes.rows.length === 0) {
      throw new AppError(
        422,
        'INVALID_DEPARTMENT_SERVICE_PAIR',
        `Service ID ${serviceId} does not belong to Department ${departmentId} or is inactive.`
      );
    }

    const svcRow = svcRes.rows[0];

    if (actor.role === 'DOCTOR' && svcRow.requires_permission) {
      const permRes = await client.query(
        `SELECT 1
         FROM doctor_service_permissions
         WHERE doctor_id = $1
           AND service_id = $2
           AND is_active = TRUE
         LIMIT 1`,
        [actor.userId, serviceId]
      );
      if (permRes.rowCount === 0) {
        throw new AppError(
          403,
          'SERVICE_PERMISSION_REQUIRED',
          'Selecting this specialized sub-service requires an active service permission.'
        );
      }
    }

    await client.query(
      `UPDATE cases
       SET service_id = $2,
           version = version + 1
       WHERE case_id = $1`,
      [caseId, serviceId]
    );

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: 'CASE_SERVICE_UPDATED',
      entityType: 'cases',
      entityId: caseId,
      beforeData: { serviceId: caseRow.service_id ? Number(caseRow.service_id) : null },
      afterData: { serviceId },
      req,
    });

    return {
      caseId,
      caseNumber: caseRow.case_number,
      departmentId,
      service: {
        serviceId,
        code: svcRow.code,
        name: isAr ? svcRow.name_ar : svcRow.name_en,
        nameEn: svcRow.name_en,
        nameAr: svcRow.name_ar,
        requiresPermission: Boolean(svcRow.requires_permission),
      },
    };
  });
}

/**
 * POST /api/v1/cases/:caseId/hide
 * Hides a `WAITING_FOR_DOCTOR` case from the current doctor's feed only (`doctor_hidden_cases`) (§4.4).
 *
 * @param {number} caseId
 * @param {number} doctorId
 */
export async function hideCaseFromDoctorFeed(caseId, doctorId) {
  const { rowCount } = await pool.query(
    `SELECT 1 FROM cases WHERE case_id = $1 LIMIT 1`,
    [caseId]
  );

  if (rowCount === 0) {
    throw new AppError(404, 'CASE_NOT_FOUND', `Case ${caseId} was not found.`);
  }

  await pool.query(
    `INSERT INTO doctor_hidden_cases (doctor_id, case_id, hidden_at)
     VALUES ($1, $2, now())
     ON CONFLICT (doctor_id, case_id) DO NOTHING`,
    [doctorId, caseId]
  );

  return {
    caseId,
    doctorId,
    hidden: true,
  };
}

/**
 * POST /api/v1/cases/:caseId/release
 * Releases a `CLAIMED` or `SCHEDULED` case back to the department's `WAITING_FOR_DOCTOR` pool:
 * - Cancels any open `appointments` (`SCHEDULED`) and `bed_tickets` (`RESERVED`)
 * - Closes active `case_assignments` (`end_reason = 'DOCTOR_RELEASED'`)
 * - Closes `chat_conversations` (`status = 'CLOSED'`)
 * - Resets `cases` (`status = 'WAITING_FOR_DOCTOR'`, `assigned_doctor_id = NULL`, `broadcasted_at = now()`)
 * - Re-emits `dept.case_broadcasted` via `afterCommit()` (§4.4)
 *
 * @param {number} caseId
 * @param {{ userId: number, role: string }} actor
 * @param {import('z').infer<typeof releaseCaseSchema>} payload
 * @param {import('express').Request} req
 */
export async function releaseClaimedCase(caseId, actor, payload, req) {
  const isAr = (req?.lang || 'ar') === 'ar';

  return withTransaction(
    async (client, afterCommit) => {
      const caseRes = await client.query(
        `SELECT
           c.case_id,
           c.case_number,
           c.patient_id,
           c.department_id,
           c.service_id,
           c.tooth_numbers,
           c.tooth_type,
           c.procedure_details,
           c.triage_notes,
           c.priority,
           c.status,
           c.assigned_doctor_id,
           d.name_en AS department_name_en,
           d.name_ar AS department_name_ar,
           s.name_en AS service_name_en,
           s.name_ar AS service_name_ar
         FROM cases c
         LEFT JOIN departments d ON d.department_id = c.department_id
         LEFT JOIN services s ON s.service_id = c.service_id
         WHERE c.case_id = $1
         FOR UPDATE OF c NOWAIT`,
        [caseId]
      );

      if (caseRes.rows.length === 0) {
        throw new AppError(404, 'CASE_NOT_FOUND', `Case ${caseId} was not found.`);
      }

      const caseRow = caseRes.rows[0];

      if (
        actor.role === 'DOCTOR' &&
        Number(caseRow.assigned_doctor_id) !== Number(actor.userId)
      ) {
        throw new AppError(
          403,
          'NOT_ASSIGNED_DOCTOR',
          'Only the doctor currently assigned to this case (or an admin) can release it.'
        );
      }

      if (!['CLAIMED', 'SCHEDULED'].includes(caseRow.status)) {
        throw new AppError(
          409,
          'CANNOT_RELEASE_CASE_IN_CURRENT_STATUS',
          `Cannot release a case in status '${caseRow.status}'. Only CLAIMED or SCHEDULED cases can be released back to the department pool.`
        );
      }

      const previousStatus = caseRow.status;
      const previousDoctorId = Number(caseRow.assigned_doctor_id);
      const departmentId = Number(caseRow.department_id);
      const patientId = Number(caseRow.patient_id);

      // 1) Cancel any open SCHEDULED appointments and RESERVED bed_tickets
      await client.query(
        `UPDATE appointments
         SET status = 'CANCELLED'
         WHERE case_id = $1
           AND status = 'SCHEDULED'`,
        [caseId]
      );

      const cancelledTicketsRes = await client.query(
        `UPDATE bed_tickets
         SET status = 'CANCELLED',
             cancelled_at = now(),
             cancel_reason = $2
         WHERE case_id = $1
           AND status = 'RESERVED'
         RETURNING ticket_id, bed_id, service_date::TEXT AS service_date, period_id`,
        [caseId, `Case released by doctor: ${payload.reason}`]
      );

      // 2) Close active case_assignments
      const endReason =
        actor.role === 'ADMIN' ? 'ADMIN_REASSIGNED' : 'DOCTOR_RELEASED';

      await client.query(
        `UPDATE case_assignments
         SET ended_at = now(),
             end_reason = $2::assignment_end_reason,
             ended_by = $3,
             notes = $4
         WHERE case_id = $1
           AND ended_at IS NULL`,
        [caseId, endReason, actor.userId, payload.reason]
      );

      // 3) Close chat_conversations between this doctor and patient for this case
      await client.query(
        `UPDATE chat_conversations
         SET status = 'CLOSED',
             closed_at = now()
         WHERE case_id = $1
           AND status IN ('OPEN', 'READ_ONLY')`,
        [caseId]
      );

      // 4) Reset case to WAITING_FOR_DOCTOR
      const updCaseRes = await client.query(
        `UPDATE cases
         SET status = 'WAITING_FOR_DOCTOR',
             assigned_doctor_id = NULL,
             claimed_at = NULL,
             broadcasted_at = now(),
             version = version + 1
         WHERE case_id = $1
         RETURNING broadcasted_at`,
        [caseId]
      );
      const broadcastedAt = updCaseRes.rows[0].broadcasted_at;

      await client.query(
        `INSERT INTO case_status_history (
           case_id,
           from_status,
           to_status,
           changed_by,
           reason,
           metadata
         )
         VALUES ($1, $2, 'WAITING_FOR_DOCTOR', $3, $4, $5::jsonb)`,
        [
          caseId,
          previousStatus,
          actor.userId,
          payload.reason,
          JSON.stringify({ releasedDoctorId: previousDoctorId, endReason }),
        ]
      );

      // Hide the case from the releasing doctor's own feed so they don't immediately re-see it unless desired
      if (actor.role === 'DOCTOR') {
        await client.query(
          `INSERT INTO doctor_hidden_cases (doctor_id, case_id, hidden_at)
           VALUES ($1, $2, now())
           ON CONFLICT (doctor_id, case_id) DO NOTHING`,
          [actor.userId, caseId]
        );
      }

      // Fetch patient preview + risk flags for re-broadcast
      const [ppRes, flagsRes] = await Promise.all([
        client.query(
          `SELECT
             CASE
               WHEN date_of_birth IS NOT NULL
               THEN EXTRACT(YEAR FROM age(CURRENT_DATE, date_of_birth))::INT
               ELSE NULL
             END AS age,
             gender,
             has_critical_condition,
             medical_document_status
           FROM patient_profiles
           WHERE patient_id = $1`,
          [patientId]
        ),
        client.query(
          `SELECT rf.code, rf.name_en, rf.name_ar, rf.severity
           FROM case_risk_flags crf
           JOIN risk_flags rf ON rf.risk_flag_id = crf.risk_flag_id
           WHERE crf.case_id = $1`,
          [caseId]
        ),
      ]);

      const pp = ppRes.rows[0];

      await createNotification(
        client,
        {
          userId: patientId,
          type: 'CASE_REQUEUED',
          title: isAr
            ? 'جاري تعيين طبيب آخر لحالتك'
            : 'Reassigning Your Case to Another Doctor',
          body: isAr
            ? `تم إعادة حالتك (${caseRow.case_number}) إلى قائمة الانتظار في القسم المختص ليتم قبولها من طبيب آخر.`
            : `Your case (${caseRow.case_number}) has been returned to the department priority queue so another available doctor can claim it.`,
          data: { caseId, caseNumber: caseRow.case_number, departmentId },
          caseId,
        },
        afterCommit
      );

      await writeAuditLog(client, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'CASE_RELEASED',
        entityType: 'cases',
        entityId: caseId,
        beforeData: { status: previousStatus, assignedDoctorId: previousDoctorId },
        afterData: {
          status: 'WAITING_FOR_DOCTOR',
          reason: payload.reason,
          cancelledTicketsCount: cancelledTicketsRes.rowCount || 0,
        },
        req,
      });

      const broadcastPayload = {
        caseId,
        caseNumber: caseRow.case_number,
        status: 'WAITING_FOR_DOCTOR',
        departmentId,
        departmentName: isAr
          ? caseRow.department_name_ar
          : caseRow.department_name_en,
        serviceId: caseRow.service_id ? Number(caseRow.service_id) : null,
        serviceName: caseRow.service_id
          ? isAr
            ? caseRow.service_name_ar
            : caseRow.service_name_en
          : null,
        toothNumbers: Array.isArray(caseRow.tooth_numbers)
          ? caseRow.tooth_numbers.map((t) => Number(t))
          : [],
        toothType: caseRow.tooth_type || null,
        procedureDetails: caseRow.procedure_details || null,
        triageNotes: caseRow.triage_notes || null,
        priority: caseRow.priority,
        broadcastedAt,
        patientPreview: {
          age: pp.age !== null ? Number(pp.age) : null,
          gender: pp.gender || null,
          hasCriticalCondition: Boolean(pp.has_critical_condition),
          medicalDocumentStatus: pp.medical_document_status,
        },
        riskFlags: flagsRes.rows.map((rf) => ({
          code: rf.code,
          name: isAr ? rf.name_ar : rf.name_en,
          nameEn: rf.name_en,
          nameAr: rf.name_ar,
          severity: rf.severity,
        })),
      };

      afterCommit(() => {
        emitToRooms(
          [`dept:${departmentId}`, 'admin:dashboard'],
          'dept.case_broadcasted',
          broadcastPayload
        );

        for (const tk of cancelledTicketsRes.rows) {
          emitToRooms(
            [`dept:${departmentId}:beds`, 'admin:dashboard'],
            'beds.calendar_updated',
            {
              departmentId,
              bedId: Number(tk.bed_id),
              serviceDate: tk.service_date,
              periodId: Number(tk.period_id),
              reason: 'RESERVATION_CANCELLED_ON_CASE_RELEASE',
            }
          );
        }
      });

      return {
        caseId,
        caseNumber: caseRow.case_number,
        status: 'WAITING_FOR_DOCTOR',
        departmentId,
        broadcastedAt,
      };
    },
    { lockContext: 'CASE' }
  );
}
