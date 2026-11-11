import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import { createNotification, writeAuditLog } from '../../utils/audit.js';
import { generateSignedFileUrl } from '../files/files.service.js';

export const listPendingAccountsQuerySchema = z.object({
  role: z.enum(['DOCTOR', 'SUPERVISOR', 'PATIENT', 'ALL']).optional().default('ALL'),
  status: z
    .enum(['PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED'])
    .optional()
    .default('PENDING_APPROVAL'),
  page: z.coerce.number().int().min(1).optional().default(1),
  pageSize: z.coerce.number().int().min(1).max(100).optional().default(20),
});

export const approveAccountSchema = z.object({
  departmentIds: z.array(z.coerce.number().int().positive()).min(1).optional(),
  primaryDepartmentId: z.coerce.number().int().positive().optional(),
  supervisorCode: z.string().trim().min(1).max(12).optional(),
  isTriageExaminer: z.boolean().optional(),
  maxActiveCases: z.coerce.number().int().min(1).max(30).optional(),
});

export const rejectOrSuspendAccountSchema = z.object({
  reason: z.string().trim().min(3, 'A reason of at least 3 characters is required.').max(1000),
});

/**
 * GET /api/v1/admin/accounts/pending
 * Lists pending (or filtered) DOCTOR and SUPERVISOR accounts with university ID proof
 * signed URLs and requested departments (§4.8).
 *
 * @param {import('z').infer<typeof listPendingAccountsQuerySchema>} queryParams
 */
export async function listAccountsForAdmin(queryParams) {
  const { role, status, page, pageSize } = queryParams;
  const offset = (page - 1) * pageSize;

  const rolesFilter = role === 'ALL' ? ['DOCTOR', 'SUPERVISOR', 'PATIENT'] : [role];

  const countRes = await pool.query(
    `SELECT COUNT(*)::INT AS total
     FROM users u
     WHERE u.role = ANY($1::user_role[])
       AND u.account_status = $2
       AND u.deleted_at IS NULL`,
    [rolesFilter, status]
  );

  const total = countRes.rows[0]?.total || 0;

  const { rows } = await pool.query(
    `SELECT
       u.user_id,
       u.role,
       u.full_name,
       u.phone,
       u.email,
       u.account_status,
       u.rejection_reason,
       u.approved_by,
       u.approved_at,
       u.created_at,
       sdp.doctor_category,
       sdp.university_id_number,
       sdp.university,
       sdp.college,
       sdp.academic_year,
       sdp.supervisor_id,
       sdp.max_active_cases,
       sdp.bio,
       f.file_id AS id_proof_file_id,
       f.storage_key AS id_proof_storage_key,
       sp.supervisor_code,
       sp.department_id AS supervisor_department_id,
       sp.title AS supervisor_title,
       sp.specialty AS supervisor_specialty,
       sp.is_triage_examiner,
       pp.has_critical_condition,
       pp.photo_consent,
       pp.medical_document_status,
       pp.medical_notes,
       COALESCE(
         (
           SELECT jsonb_agg(
             jsonb_build_object(
               'departmentId', d.department_id,
               'code', d.code,
               'nameEn', d.name_en,
               'nameAr', d.name_ar,
               'isPrimary', dd.is_primary,
               'isActive', dd.is_active
             )
             ORDER BY dd.is_primary DESC, d.display_order ASC
           )
           FROM doctor_departments dd
           JOIN departments d ON d.department_id = dd.department_id
           WHERE dd.doctor_id = u.user_id
         ),
         '[]'::jsonb
       ) AS requested_departments
     FROM users u
     LEFT JOIN student_doctor_profiles sdp ON sdp.doctor_id = u.user_id
     LEFT JOIN files f ON f.file_id = sdp.id_proof_file_id
     LEFT JOIN supervisor_profiles sp ON sp.supervisor_id = u.user_id
     LEFT JOIN patient_profiles pp ON pp.patient_id = u.user_id
     WHERE u.role = ANY($1::user_role[])
       AND u.account_status = $2
       AND u.deleted_at IS NULL
     ORDER BY u.created_at ASC
     LIMIT $3 OFFSET $4`,
    [rolesFilter, status, pageSize, offset]
  );

  const accounts = rows.map((row) => ({
    userId: Number(row.user_id),
    role: row.role,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email || null,
    accountStatus: row.account_status,
    rejectionReason: row.rejection_reason || null,
    approvedBy: row.approved_by ? Number(row.approved_by) : null,
    approvedAt: row.approved_at || null,
    createdAt: row.created_at,
    doctorProfile:
      row.role === 'DOCTOR'
        ? {
            doctorCategory: row.doctor_category,
            universityIdNumber: row.university_id_number,
            university: row.university,
            college: row.college,
            academicYear: row.academic_year !== null ? Number(row.academic_year) : null,
            supervisorId: row.supervisor_id ? Number(row.supervisor_id) : null,
            maxActiveCases: Number(row.max_active_cases || 5),
            bio: row.bio || null,
            idProofFileId: row.id_proof_file_id ? Number(row.id_proof_file_id) : null,
            idProofSignedUrl: row.id_proof_storage_key
              ? generateSignedFileUrl(row.id_proof_storage_key)
              : null,
            departments: row.requested_departments || [],
          }
        : null,
    supervisorProfile:
      row.role === 'SUPERVISOR'
        ? {
            supervisorCode: row.supervisor_code,
            departmentId: row.supervisor_department_id
              ? Number(row.supervisor_department_id)
              : null,
            title: row.supervisor_title || null,
            specialty: row.supervisor_specialty || null,
            isTriageExaminer: Boolean(row.is_triage_examiner),
          }
        : null,
    patientProfile:
      row.role === 'PATIENT'
        ? {
            hasCriticalCondition: Boolean(row.has_critical_condition),
            photoConsent: Boolean(row.photo_consent),
            medicalDocumentStatus: row.medical_document_status || 'NOT_REQUIRED',
            medicalNotes: row.medical_notes || null,
          }
        : null,
  }));

  return {
    accounts,
    meta: {
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    },
  };
}

/**
 * POST /api/v1/admin/accounts/:userId/approve
 * Approves a `DOCTOR` or `SUPERVISOR` account (`account_status = 'ACTIVE'`),
 * activates `doctor_departments`, issues/confirms `supervisor_code` for supervisors,
 * writes `audit_logs`, and sends a real-time notification (§4.8).
 *
 * @param {number} targetUserId
 * @param {number} adminUserId
 * @param {import('z').infer<typeof approveAccountSchema>} payload
 * @param {import('express').Request} req
 */
export async function approveUserAccount(targetUserId, adminUserId, payload, req) {
  return withTransaction(async (client, afterCommit) => {
    const userRes = await client.query(
      `SELECT
         user_id,
         role,
         full_name,
         phone,
         email,
         account_status,
         preferred_language,
         deleted_at
       FROM users
       WHERE user_id = $1
       FOR UPDATE`,
      [targetUserId]
    );

    if (userRes.rows.length === 0 || userRes.rows[0].deleted_at !== null) {
      throw new AppError(404, 'USER_NOT_FOUND', `User ${targetUserId} was not found.`);
    }

    const userRow = userRes.rows[0];
    const previousStatus = userRow.account_status;

    await client.query(
      `UPDATE users
       SET account_status = 'ACTIVE',
           rejection_reason = NULL,
           approved_by = $2,
           approved_at = now()
       WHERE user_id = $1`,
      [targetUserId, adminUserId]
    );

    let activeDepartmentIds = [];
    let issuedSupervisorCode = null;

    if (userRow.role === 'DOCTOR') {
      if (Array.isArray(payload.departmentIds) && payload.departmentIds.length > 0) {
        const uniqueDepts = Array.from(new Set(payload.departmentIds.map((d) => Number(d))));

        const deptCheck = await client.query(
          `SELECT department_id FROM departments WHERE department_id = ANY($1::bigint[]) AND is_active = TRUE`,
          [uniqueDepts]
        );
        let validDepts = deptCheck.rows.map((r) => Number(r.department_id));
        if (validDepts.length === 0) {
          const allActive = await client.query(
            `SELECT department_id FROM departments WHERE is_active = TRUE ORDER BY department_id ASC LIMIT 2`
          );
          validDepts = allActive.rows.map((r) => Number(r.department_id));
        }

        const primaryId = payload.primaryDepartmentId && validDepts.includes(Number(payload.primaryDepartmentId))
          ? Number(payload.primaryDepartmentId)
          : validDepts[0];

        await client.query(`DELETE FROM doctor_departments WHERE doctor_id = $1`, [targetUserId]);

        for (const deptId of validDepts) {
          await client.query(
            `INSERT INTO doctor_departments (
               doctor_id,
               department_id,
               is_primary,
               is_active,
               assigned_by,
               assigned_at
             )
             VALUES ($1, $2, $3, TRUE, $4, now())`,
            [targetUserId, deptId, deptId === primaryId, adminUserId]
          );
        }

        activeDepartmentIds = validDepts;
      } else {
        const actRes = await client.query(
          `UPDATE doctor_departments
           SET is_active = TRUE,
               assigned_by = $2,
               assigned_at = now()
           WHERE doctor_id = $1
           RETURNING department_id`,
          [targetUserId, adminUserId]
        );
        activeDepartmentIds = actRes.rows.map((r) => Number(r.department_id));
      }

      if (payload.maxActiveCases !== undefined) {
        await client.query(
          `UPDATE student_doctor_profiles
           SET max_active_cases = $2
           WHERE doctor_id = $1`,
          [targetUserId, Number(payload.maxActiveCases)]
        );
      }
    } else if (userRow.role === 'SUPERVISOR') {
      const desiredCode = payload.supervisorCode
        ? payload.supervisorCode.trim().toUpperCase()
        : `SUP-${String(targetUserId).padStart(4, '0')}`;

      const supUpdate = await client.query(
        `UPDATE supervisor_profiles
         SET supervisor_code = $2,
             is_triage_examiner = COALESCE($3, is_triage_examiner)
         WHERE supervisor_id = $1
         RETURNING supervisor_code`,
        [
          targetUserId,
          desiredCode,
          payload.isTriageExaminer !== undefined ? Boolean(payload.isTriageExaminer) : null,
        ]
      );

      issuedSupervisorCode = supUpdate.rows[0]?.supervisor_code || desiredCode;
    }

    await writeAuditLog(client, {
      actorUserId: adminUserId,
      actorRole: 'ADMIN',
      action: 'ACCOUNT_APPROVED',
      entityType: 'users',
      entityId: targetUserId,
      beforeData: { accountStatus: previousStatus },
      afterData: {
        accountStatus: 'ACTIVE',
        role: userRow.role,
        activeDepartmentIds,
        supervisorCode: issuedSupervisorCode,
      },
      req,
    });

    await createNotification(
      client,
      {
        userId: targetUserId,
        type: 'ACCOUNT_APPROVED',
        title:
          userRow.preferred_language === 'en'
            ? 'Your TeethLink account has been approved'
            : 'تمت الموافقة على حسابك في TeethLink',
        body:
          userRow.preferred_language === 'en'
            ? 'Your account is now ACTIVE. You can sign in and access your clinical dashboard.'
            : 'حسابك نشط الآن. يمكنك تسجيل الدخول والبدء في استخدام المنصة.',
        data: {
          accountStatus: 'ACTIVE',
          activeDepartmentIds,
          supervisorCode: issuedSupervisorCode,
        },
      },
      afterCommit
    );

    return {
      userId: targetUserId,
      role: userRow.role,
      fullName: userRow.full_name,
      phone: userRow.phone,
      accountStatus: 'ACTIVE',
      approvedBy: adminUserId,
      approvedAt: new Date().toISOString(),
      ...(userRow.role === 'DOCTOR' ? { activeDepartmentIds } : {}),
      ...(userRow.role === 'SUPERVISOR' ? { supervisorCode: issuedSupervisorCode } : {}),
    };
  });
}

/**
 * POST /api/v1/admin/accounts/:userId/reject
 * Rejects a pending account, sets `rejection_reason`, increments `token_version`
 * to revoke any tokens, logs an audit entry, and notifies the user (§4.8).
 *
 * @param {number} targetUserId
 * @param {number} adminUserId
 * @param {string} reason
 * @param {import('express').Request} req
 */
export async function rejectUserAccount(targetUserId, adminUserId, reason, req) {
  return withTransaction(async (client, afterCommit) => {
    const userRes = await client.query(
      `SELECT user_id, role, full_name, phone, account_status, preferred_language, deleted_at
       FROM users
       WHERE user_id = $1
       FOR UPDATE`,
      [targetUserId]
    );

    if (userRes.rows.length === 0 || userRes.rows[0].deleted_at !== null) {
      throw new AppError(404, 'USER_NOT_FOUND', `User ${targetUserId} was not found.`);
    }

    const userRow = userRes.rows[0];
    if (userRow.role === 'ADMIN') {
      throw new AppError(422, 'CANNOT_REJECT_ADMIN', 'Admin accounts cannot be rejected.');
    }

    const previousStatus = userRow.account_status;

    const updateRes = await client.query(
      `UPDATE users
       SET account_status = 'REJECTED',
           rejection_reason = $2,
           token_version = token_version + 1
       WHERE user_id = $1
       RETURNING token_version`,
      [targetUserId, reason]
    );

    await client.query(
      `UPDATE refresh_tokens
       SET revoked_at = now()
       WHERE user_id = $1
         AND revoked_at IS NULL`,
      [targetUserId]
    );

    if (userRow.role === 'DOCTOR') {
      await client.query(
        `UPDATE doctor_departments SET is_active = FALSE WHERE doctor_id = $1`,
        [targetUserId]
      );
    }

    await writeAuditLog(client, {
      actorUserId: adminUserId,
      actorRole: 'ADMIN',
      action: 'ACCOUNT_REJECTED',
      entityType: 'users',
      entityId: targetUserId,
      beforeData: { accountStatus: previousStatus },
      afterData: {
        accountStatus: 'REJECTED',
        rejectionReason: reason,
        tokenVersion: Number(updateRes.rows[0].token_version),
      },
      req,
    });

    await createNotification(
      client,
      {
        userId: targetUserId,
        type: 'ACCOUNT_REJECTED',
        title:
          userRow.preferred_language === 'en'
            ? 'Account Registration Update'
            : 'تحديث بخصوص طلب تسجيل الحساب',
        body: reason,
        data: { accountStatus: 'REJECTED', reason },
      },
      afterCommit
    );

    return {
      userId: targetUserId,
      role: userRow.role,
      fullName: userRow.full_name,
      accountStatus: 'REJECTED',
      rejectionReason: reason,
      tokenVersion: Number(updateRes.rows[0].token_version),
    };
  });
}

/**
 * POST /api/v1/admin/accounts/:userId/suspend
 * Suspends an active account, increments `users.token_version` to immediately revoke
 * all active JWTs and Socket.io sessions, revokes refresh tokens, and logs an audit entry (§4.8).
 *
 * @param {number} targetUserId
 * @param {number} adminUserId
 * @param {string} reason
 * @param {import('express').Request} req
 */
export async function suspendUserAccount(targetUserId, adminUserId, reason, req) {
  if (Number(targetUserId) === Number(adminUserId)) {
    throw new AppError(422, 'CANNOT_SUSPEND_SELF', 'An administrator cannot suspend their own account.');
  }

  return withTransaction(async (client, afterCommit) => {
    const userRes = await client.query(
      `SELECT user_id, role, full_name, phone, account_status, preferred_language, deleted_at
       FROM users
       WHERE user_id = $1
       FOR UPDATE`,
      [targetUserId]
    );

    if (userRes.rows.length === 0 || userRes.rows[0].deleted_at !== null) {
      throw new AppError(404, 'USER_NOT_FOUND', `User ${targetUserId} was not found.`);
    }

    const userRow = userRes.rows[0];
    const previousStatus = userRow.account_status;

    const updateRes = await client.query(
      `UPDATE users
       SET account_status = 'SUSPENDED',
           rejection_reason = $2,
           token_version = token_version + 1
       WHERE user_id = $1
       RETURNING token_version`,
      [targetUserId, reason]
    );

    await client.query(
      `UPDATE refresh_tokens
       SET revoked_at = now()
       WHERE user_id = $1
         AND revoked_at IS NULL`,
      [targetUserId]
    );

    await writeAuditLog(client, {
      actorUserId: adminUserId,
      actorRole: 'ADMIN',
      action: 'ACCOUNT_SUSPENDED',
      entityType: 'users',
      entityId: targetUserId,
      beforeData: { accountStatus: previousStatus },
      afterData: {
        accountStatus: 'SUSPENDED',
        reason,
        tokenVersion: Number(updateRes.rows[0].token_version),
      },
      req,
    });

    await createNotification(
      client,
      {
        userId: targetUserId,
        type: 'ACCOUNT_SUSPENDED',
        title:
          userRow.preferred_language === 'en'
            ? 'Your account has been suspended'
            : 'تم إيقاف حسابك مؤقتاً',
        body: reason,
        data: { accountStatus: 'SUSPENDED', reason },
      },
      afterCommit
    );

    return {
      userId: targetUserId,
      role: userRow.role,
      fullName: userRow.full_name,
      accountStatus: 'SUSPENDED',
      reason,
      tokenVersion: Number(updateRes.rows[0].token_version),
    };
  });
}
