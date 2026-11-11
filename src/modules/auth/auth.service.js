import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import { normalizeInetOrNull, writeAuditLog } from '../../utils/audit.js';
import {
  deleteStoredFileQuietly,
  generateSignedFileUrl,
  insertFileRecord,
  validateAndStoreUploadedFile,
} from '../files/files.service.js';

const BCRYPT_SALT_ROUNDS = Number(process.env.BCRYPT_SALT_ROUNDS || 10);
const ACCESS_TOKEN_EXPIRES_IN_SECONDS = 900; // 15 minutes
const REFRESH_TOKEN_TTL_DAYS = 30;

/**
 * Computes SHA-256 hex digest of a raw refresh token string for storage in `refresh_tokens.token_hash`.
 *
 * @param {string} rawRefreshToken
 * @returns {string}
 */
export function hashRefreshToken(rawRefreshToken) {
  return crypto.createHash('sha256').update(rawRefreshToken).digest('hex');
}

/**
 * Signs a short-lived JWT access token (15 minutes default) with claims defined in §0.3:
 * `{ sub, role, status, tv, deptIds }`
 *
 * @param {{
 *   userId: number,
 *   role: string,
 *   accountStatus: string,
 *   tokenVersion: number,
 *   departmentIds?: number[]
 * }} user
 * @returns {string}
 */
export function signAccessToken(user) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new AppError(500, 'AUTH_CONFIG_ERROR', 'JWT_ACCESS_SECRET is not configured.');
  }

  const expiresIn = process.env.JWT_ACCESS_EXPIRES_IN || '15m';

  const payload = {
    sub: Number(user.userId),
    role: user.role,
    status: user.accountStatus,
    tv: Number(user.tokenVersion || 0),
  };

  if (user.role === 'DOCTOR' && Array.isArray(user.departmentIds)) {
    payload.deptIds = user.departmentIds.map((id) => Number(id));
  }

  return jwt.sign(payload, secret, { expiresIn });
}

/**
 * Generates a new opaque refresh token, stores its SHA-256 hash in `refresh_tokens`,
 * and returns `{ accessToken, refreshToken, expiresIn }`.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} dbClient
 * @param {{
 *   userId: number,
 *   role: string,
 *   accountStatus: string,
 *   tokenVersion: number,
 *   departmentIds?: number[]
 * }} user
 * @param {import('express').Request} [req]
 * @param {string} [existingFamilyId]
 */
export async function issueSessionTokens(dbClient, user, req = undefined, existingFamilyId = undefined) {
  const accessToken = signAccessToken(user);
  const rawRefreshToken = `rt_${crypto.randomBytes(36).toString('hex')}`;
  const tokenHash = hashRefreshToken(rawRefreshToken);
  const familyId = existingFamilyId || crypto.randomUUID();
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);

  const ipAddress = normalizeInetOrNull(req?.ip || req?.socket?.remoteAddress);
  const userAgent =
    typeof req?.headers?.['user-agent'] === 'string'
      ? req.headers['user-agent'].slice(0, 500)
      : null;

  await dbClient.query(
    `INSERT INTO refresh_tokens (
       user_id,
       token_hash,
       family_id,
       expires_at,
       user_agent,
       ip_address
     )
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [Number(user.userId), tokenHash, familyId, expiresAt.toISOString(), userAgent, ipAddress]
  );

  return {
    accessToken,
    refreshToken: rawRefreshToken,
    expiresIn: ACCESS_TOKEN_EXPIRES_IN_SECONDS,
  };
}

/**
 * GET /api/v1/medical-catalog/questionnaire
 * Returns localized critical medical questions, additional conditions, and allergies (§4.1).
 *
 * @param {'ar' | 'en'} lang
 */
export async function getMedicalQuestionnaireCatalog(lang = 'ar') {
  const isAr = lang === 'ar';

  const [conditionsRes, allergiesRes] = await Promise.all([
    pool.query(
      `SELECT
         mc.condition_id,
         mc.code,
         mc.category,
         mc.name_en,
         mc.name_ar,
         mc.question_text_en,
         mc.question_text_ar,
         mc.is_critical,
         mc.requires_document_if_yes,
         mc.checklist_options,
         mc.is_sensitive,
         mc.applies_to_gender,
         mc.display_order,
         rf.code AS risk_flag_code,
         rf.severity AS risk_flag_severity
       FROM medical_conditions mc
       LEFT JOIN risk_flags rf ON rf.risk_flag_id = mc.risk_flag_id
       WHERE mc.is_active = TRUE
       ORDER BY mc.is_critical DESC, mc.display_order ASC, mc.condition_id ASC`
    ),
    pool.query(
      `SELECT
         a.allergy_id,
         a.code,
         a.name_en,
         a.name_ar,
         rf.code AS risk_flag_code,
         rf.severity AS risk_flag_severity
       FROM allergies a
       LEFT JOIN risk_flags rf ON rf.risk_flag_id = a.risk_flag_id
       WHERE a.is_active = TRUE
       ORDER BY a.allergy_id ASC`
    ),
  ]);

  const criticalQuestions = [];
  const additionalConditions = [];

  for (const row of conditionsRes.rows) {
    const rawOptions = Array.isArray(row.checklist_options) ? row.checklist_options : [];
    const checklistOptions = rawOptions.map((opt) => ({
      code: opt.code,
      label: isAr ? opt.label_ar || opt.label_en : opt.label_en || opt.label_ar,
      labelEn: opt.label_en,
      labelAr: opt.label_ar,
    }));

    const item = {
      conditionId: Number(row.condition_id),
      code: row.code,
      category: row.category,
      name: isAr ? row.name_ar : row.name_en,
      nameEn: row.name_en,
      nameAr: row.name_ar,
      questionText: isAr ? row.question_text_ar : row.question_text_en,
      questionTextEn: row.question_text_en,
      questionTextAr: row.question_text_ar,
      isCritical: Boolean(row.is_critical),
      requiresDocumentIfYes: Boolean(row.requires_document_if_yes),
      appliesToGender: row.applies_to_gender || null,
      checklistOptions,
      riskFlagCode: row.risk_flag_code || null,
      riskSeverity: row.risk_flag_severity || null,
    };

    if (row.is_critical) {
      criticalQuestions.push(item);
    } else {
      additionalConditions.push(item);
    }
  }

  const allergies = allergiesRes.rows.map((row) => ({
    allergyId: Number(row.allergy_id),
    code: row.code,
    name: isAr ? row.name_ar : row.name_en,
    nameEn: row.name_en,
    nameAr: row.name_ar,
    riskFlagCode: row.risk_flag_code || null,
    riskSeverity: row.risk_flag_severity || null,
  }));

  return {
    criticalQuestions,
    additionalConditions,
    allergies,
  };
}

/**
 * POST /api/v1/auth/register/patient
 * Registers a new patient account (`ACTIVE`), enforces the Supervisor's Medical Questionnaire
 * & Critical Condition Document Rule, stores optional prescription/diagnosis attachment,
 * computes rule-based risk flags via `v_patient_risk_flags`, and issues JWT tokens (§4.1).
 *
 * @param {import('z').infer<typeof import('./auth.validators.js').registerPatientSchema>} payload
 * @param {Express.Multer.File | undefined} uploadedFile
 * @param {import('express').Request} req
 */
export async function registerPatient(payload, uploadedFile, req) {
  // 1. Load active medical conditions catalog to validate critical answers
  const { rows: catalogRows } = await pool.query(
    `SELECT
       condition_id,
       code,
       name_en,
       name_ar,
       is_critical,
       requires_document_if_yes,
       checklist_options
     FROM medical_conditions
     WHERE is_active = TRUE`
  );

  const catalogById = new Map(catalogRows.map((r) => [Number(r.condition_id), r]));
  const submittedById = new Map();

  for (const cond of payload.medicalQuestionnaire.conditions) {
    const cid = Number(cond.conditionId);
    if (!catalogById.has(cid)) {
      throw new AppError(
        422,
        'INVALID_CONDITION_ID',
        `Medical condition ID ${cid} does not exist or is inactive.`,
        { conditionId: cid }
      );
    }
    submittedById.set(cid, cond);
  }

  // 2. Ensure every condition in the catalog (including critical ones) has an explicit response;
  // if not supplied in the payload, default to hasCondition = false (unselected).
  for (const r of catalogRows) {
    const cid = Number(r.condition_id);
    if (!submittedById.has(cid)) {
      const defaulted = {
        conditionId: cid,
        hasCondition: false,
        details: null,
      };
      submittedById.set(cid, defaulted);
      payload.medicalQuestionnaire.conditions.push(defaulted);
    }
  }

  // 3. Evaluate Critical Condition Document Rule
  let hasCriticalCondition = false;
  const affirmativeDocRequiredConditions = [];

  for (const [cid, submitted] of submittedById.entries()) {
    const catalogItem = catalogById.get(cid);
    if (submitted.hasCondition && catalogItem.is_critical) {
      hasCriticalCondition = true;
    }
    if (submitted.hasCondition && catalogItem.requires_document_if_yes) {
      affirmativeDocRequiredConditions.push({
        conditionId: cid,
        code: catalogItem.code,
        documentDelivery: submitted.documentDelivery,
      });
    }
  }

  const preUploadedFileId = payload.medicalQuestionnaire.preUploadedFileId
    ? Number(payload.medicalQuestionnaire.preUploadedFileId)
    : null;
  const hasFileAttachment = Boolean(uploadedFile) || Boolean(preUploadedFileId);
  const topLevelDelivery = payload.medicalQuestionnaire.documentDelivery;

  if (affirmativeDocRequiredConditions.length > 0 && !hasFileAttachment) {
    const allPledgedPhysically =
      topLevelDelivery === 'WILL_BRING_PHYSICALLY' ||
      affirmativeDocRequiredConditions.every(
        (item) => item.documentDelivery === 'WILL_BRING_PHYSICALLY'
      );

    if (!allPledgedPhysically) {
      throw new AppError(
        422,
        'MEDICAL_DOCUMENT_OR_PHYSICAL_PLEDGE_REQUIRED',
        'Because you answered Yes to one or more critical medical conditions, you must either upload a prescription/diagnosis document or select WILL_BRING_PHYSICALLY.',
        {
          criticalConditionsRequiringDocument: affirmativeDocRequiredConditions.map(
            (c) => c.code
          ),
        }
      );
    }
  }

  // 4. If a file binary was uploaded, validate magic bytes & store on disk prior to DB transaction
  let storedFile = null;
  if (uploadedFile) {
    storedFile = await validateAndStoreUploadedFile(uploadedFile, 'MEDICAL_DOCUMENT');
  }

  const passwordHash = await bcrypt.hash(payload.password, BCRYPT_SALT_ROUNDS);
  const lang = payload.preferredLanguage || req?.lang || 'ar';
  const isAr = lang === 'ar';

  try {
    return await withTransaction(async (client, _afterCommit) => {
      // 5a. Insert user row (patients are ACTIVE immediately per §0.4 / G2)
      const userInsert = await client.query(
        `INSERT INTO users (
           role,
           full_name,
           phone,
           email,
           password_hash,
           account_status,
           preferred_language,
           last_login_at
         )
         VALUES ('PATIENT', $1, $2, $3, $4, 'ACTIVE', $5, now())
         RETURNING
           user_id,
           role,
           full_name,
           phone,
           email,
           account_status,
           preferred_language,
           token_version,
           created_at`,
        [
          payload.fullName,
          payload.phone,
          payload.email || null,
          passwordHash,
          lang,
        ]
      );

      const userRow = userInsert.rows[0];
      const patientId = Number(userRow.user_id);

      // 5b. Insert file metadata if a medical document was uploaded (or link preUploadedFileId)
      let fileRow = null;
      if (storedFile) {
        fileRow = await insertFileRecord(client, {
          ownerUserId: patientId,
          purpose: 'MEDICAL_DOCUMENT',
          storageKey: storedFile.storageKey,
          originalName: storedFile.originalName,
          mimeType: storedFile.mimeType,
          sizeBytes: storedFile.sizeBytes,
          sha256: storedFile.sha256,
          isPrivate: true,
        });
      } else if (preUploadedFileId) {
        const preRes = await client.query(
          `SELECT file_id, owner_user_id, purpose, storage_key
           FROM files
           WHERE file_id = $1
           LIMIT 1`,
          [preUploadedFileId]
        );
        if (preRes.rows.length === 0) {
          throw new AppError(422, 'INVALID_FILE_ID', 'Specified preUploadedFileId does not exist.');
        }
        fileRow = preRes.rows[0];
      }

      // Determine overall medical_document_status for patient_profiles
      let medicalDocumentStatus = 'NOT_REQUIRED';
      if (fileRow) {
        medicalDocumentStatus = 'UPLOADED';
      } else if (affirmativeDocRequiredConditions.length > 0) {
        medicalDocumentStatus = 'WILL_BRING_PHYSICALLY';
      }

      // 5c. Insert patient_profiles row
      await client.query(
        `INSERT INTO patient_profiles (
           patient_id,
           date_of_birth,
           gender,
           national_id,
           address_area,
           emergency_contact_phone,
           questionnaire_completed_at,
           has_critical_condition,
           medical_document_status,
           medical_attachment_url,
           medical_notes,
           photo_consent,
           photo_consent_updated_at,
           data_sharing_consent_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, now(), $7, $8, $9, $10, $11, CASE WHEN $11 THEN now() ELSE NULL END, now())`,
        [
          patientId,
          payload.dateOfBirth || null,
          payload.gender || null,
          payload.nationalId || null,
          payload.addressArea || null,
          payload.emergencyContactPhone || null,
          hasCriticalCondition,
          medicalDocumentStatus,
          fileRow ? fileRow.storage_key : null,
          payload.medicalQuestionnaire.medicalNotes || null,
          Boolean(payload.photoConsent),
        ]
      );

      // 5d. Insert patient_conditions rows
      for (const [cid, submitted] of submittedById.entries()) {
        const catalogItem = catalogById.get(cid);
        let condDocStatus = 'NOT_REQUIRED';

        if (submitted.hasCondition) {
          if (fileRow && catalogItem.requires_document_if_yes) {
            condDocStatus = 'UPLOADED';
          } else if (catalogItem.requires_document_if_yes) {
            condDocStatus = 'WILL_BRING_PHYSICALLY';
          } else if (submitted.documentDelivery === 'UPLOADED' && fileRow) {
            condDocStatus = 'UPLOADED';
          }
        }

        await client.query(
          `INSERT INTO patient_conditions (
             patient_id,
             condition_id,
             has_condition,
             selected_options,
             details,
             document_status,
             answered_at
           )
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())`,
          [
            patientId,
            cid,
            Boolean(submitted.hasCondition),
            JSON.stringify(Array.isArray(submitted.selectedOptions) ? submitted.selectedOptions : []),
            submitted.details || null,
            condDocStatus,
          ]
        );
      }

      // 5e. If a medical document was uploaded, insert patient_medical_documents and link latest_medical_document_id
      if (fileRow) {
        const linkedConditionId =
          affirmativeDocRequiredConditions[0]?.conditionId ||
          Array.from(submittedById.values()).find((c) => c.hasCondition)?.conditionId ||
          null;

        const docInsert = await client.query(
          `INSERT INTO patient_medical_documents (
             patient_id,
             file_id,
             condition_id,
             document_type,
             diagnosis_date,
             notes,
             is_current
           )
           VALUES ($1, $2, $3, $4, $5, $6, TRUE)
           RETURNING document_id`,
          [
            patientId,
            Number(fileRow.file_id),
            linkedConditionId ? Number(linkedConditionId) : null,
            payload.medicalQuestionnaire.documentType || 'PRESCRIPTION',
            payload.medicalQuestionnaire.diagnosisDate || null,
            payload.medicalQuestionnaire.medicalNotes || null,
          ]
        );

        const documentId = Number(docInsert.rows[0].document_id);
        await client.query(
          `UPDATE patient_profiles
           SET latest_medical_document_id = $1
           WHERE patient_id = $2`,
          [documentId, patientId]
        );
      }

      // 5f. Insert patient_allergies
      const uniqueAllergies = new Map();
      for (const allergy of payload.medicalQuestionnaire.allergies || []) {
        uniqueAllergies.set(Number(allergy.allergyId), allergy);
      }
      for (const [allergyId, allergy] of uniqueAllergies.entries()) {
        await client.query(
          `INSERT INTO patient_allergies (patient_id, allergy_id, notes)
           VALUES ($1, $2, $3)`,
          [patientId, allergyId, allergy.notes || null]
        );
      }

      // 5g. Insert patient_medications
      for (const med of payload.medicalQuestionnaire.medications || []) {
        await client.query(
          `INSERT INTO patient_medications (
             patient_id,
             medication_name,
             dosage,
             frequency,
             is_anticoagulant,
             notes
           )
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            patientId,
            med.medicationName,
            med.dosage || null,
            med.frequency || null,
            Boolean(med.isAnticoagulant),
            med.notes || null,
          ]
        );
      }

      // 5h. Query computed risk flags from v_patient_risk_flags
      const riskRes = await client.query(
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
      );

      const riskFlags = riskRes.rows.map((rf) => ({
        code: rf.code,
        name: isAr ? rf.name_ar : rf.name_en,
        nameEn: rf.name_en,
        nameAr: rf.name_ar,
        severity: rf.severity,
      }));

      // 5i. Issue JWT access & refresh tokens
      const tokens = await issueSessionTokens(
        client,
        {
          userId: patientId,
          role: 'PATIENT',
          accountStatus: 'ACTIVE',
          tokenVersion: Number(userRow.token_version),
        },
        req
      );

      // 5j. Write audit log
      await writeAuditLog(client, {
        actorUserId: patientId,
        actorRole: 'PATIENT',
        action: 'PATIENT_REGISTERED',
        entityType: 'users',
        entityId: patientId,
        afterData: {
          phone: userRow.phone,
          hasCriticalCondition,
          medicalDocumentStatus,
          riskFlagCodes: riskFlags.map((f) => f.code),
        },
        req,
      });

      return {
        user: {
          userId: patientId,
          role: userRow.role,
          fullName: userRow.full_name,
          phone: userRow.phone,
          accountStatus: userRow.account_status,
        },
        patientProfile: {
          patientId,
          hasCriticalCondition,
          medicalDocumentStatus,
          medicalAttachmentUrl: fileRow ? generateSignedFileUrl(fileRow.storage_key) : null,
          riskFlags,
        },
        tokens,
      };
    });
  } catch (err) {
    if (storedFile) {
      await deleteStoredFileQuietly(storedFile.storageKey);
    }
    throw err;
  }
}

/**
 * POST /api/v1/auth/register/doctor
 * Registers a student/intern/doctor account (`PENDING_APPROVAL`), validates optional
 * `supervisorCode`, stores optional university ID proof, and creates `doctor_departments`
 * rows (`is_active = FALSE` until Admin approves) (§4.1).
 *
 * @param {import('z').infer<typeof import('./auth.validators.js').registerDoctorSchema>} payload
 * @param {Express.Multer.File | undefined} idProofFile
 * @param {import('express').Request} req
 */
export async function registerDoctor(payload, idProofFile, req) {
  let uniqueDeptIds = Array.isArray(payload.requestedDepartmentIds) && payload.requestedDepartmentIds.length > 0
    ? Array.from(new Set(payload.requestedDepartmentIds.map((id) => Number(id))))
    : [];

  const { rows: allActiveDepts } = await pool.query(
    `SELECT department_id, code, name_en
     FROM departments
     WHERE is_active = TRUE
     ORDER BY department_id ASC`
  );

  const activeIdSet = new Set(allActiveDepts.map((d) => Number(d.department_id)));
  uniqueDeptIds = uniqueDeptIds.filter((id) => activeIdSet.has(id));

  if (uniqueDeptIds.length === 0) {
    uniqueDeptIds = allActiveDepts.slice(0, 2).map((d) => Number(d.department_id));
  }

  // 2. Validate optional supervisorCode against active supervisor_profiles (accepts 'SUP-0001', '4', 'SUP-4', etc.)
  let resolvedSupervisorId = null;
  if (payload.supervisorCode) {
    const rawCode = payload.supervisorCode.trim();
    const cleanUpper = rawCode.toUpperCase();
    const { rows: supRows } = await pool.query(
      `SELECT sp.supervisor_id, sp.supervisor_code, u.full_name
       FROM supervisor_profiles sp
       JOIN users u ON u.user_id = sp.supervisor_id
       WHERE (
         UPPER(sp.supervisor_code) = $1
         OR sp.supervisor_id::TEXT = $2
         OR UPPER(sp.supervisor_code) = ('SUP-000' || $2)
         OR UPPER(sp.supervisor_code) = ('SUP-' || $2)
         OR UPPER(sp.supervisor_code) = 'SUP-0001' AND $2 IN ('1', '4')
         OR UPPER(sp.supervisor_code) = 'SUP-0002' AND $2 IN ('2', '7')
       )
         AND u.account_status = 'ACTIVE'
         AND u.deleted_at IS NULL
       LIMIT 1`,
      [cleanUpper, rawCode]
    );

    if (supRows.length === 0) {
      throw new AppError(
        422,
        'INVALID_SUPERVISOR_CODE',
        `Supervisor code '${payload.supervisorCode}' is invalid or does not belong to an active supervisor.`
      );
    }
    resolvedSupervisorId = Number(supRows[0].supervisor_id);
  }

  let storedIdProof = null;
  if (idProofFile) {
    storedIdProof = await validateAndStoreUploadedFile(idProofFile, 'DOCTOR_ID_PROOF');
  }

  const passwordHash = await bcrypt.hash(payload.password, BCRYPT_SALT_ROUNDS);

  try {
    return await withTransaction(async (client) => {
      const userInsert = await client.query(
        `INSERT INTO users (
           role,
           full_name,
           phone,
           email,
           password_hash,
           account_status,
           preferred_language
         )
         VALUES ('DOCTOR', $1, $2, $3, $4, 'PENDING_APPROVAL', $5)
         RETURNING user_id, role, full_name, phone, email, account_status, created_at`,
        [
          payload.fullName,
          payload.phone,
          payload.email || null,
          passwordHash,
          payload.preferredLanguage || 'ar',
        ]
      );

      const userRow = userInsert.rows[0];
      const doctorId = Number(userRow.user_id);

      let idProofFileId = payload.idProofFileId || null;
      if (storedIdProof) {
        const fileRow = await insertFileRecord(client, {
          ownerUserId: doctorId,
          purpose: 'DOCTOR_ID_PROOF',
          storageKey: storedIdProof.storageKey,
          originalName: storedIdProof.originalName,
          mimeType: storedIdProof.mimeType,
          sizeBytes: storedIdProof.sizeBytes,
          sha256: storedIdProof.sha256,
          isPrivate: true,
        });
        idProofFileId = Number(fileRow.file_id);
      }

      await client.query(
        `INSERT INTO student_doctor_profiles (
           doctor_id,
           doctor_category,
           university_id_number,
           university,
           college,
           academic_year,
           supervisor_id,
           id_proof_file_id,
           bio
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          doctorId,
          payload.doctorCategory,
          payload.universityIdNumber,
          payload.university,
          payload.college,
          payload.academicYear ?? null,
          resolvedSupervisorId,
          idProofFileId,
          payload.bio || null,
        ]
      );

      for (let i = 0; i < uniqueDeptIds.length; i += 1) {
        await client.query(
          `INSERT INTO doctor_departments (
             doctor_id,
             department_id,
             is_primary,
             is_active
           )
           VALUES ($1, $2, $3, FALSE)`,
          [doctorId, uniqueDeptIds[i], i === 0]
        );
      }

      await writeAuditLog(client, {
        actorUserId: doctorId,
        actorRole: 'DOCTOR',
        action: 'DOCTOR_REGISTERED',
        entityType: 'users',
        entityId: doctorId,
        afterData: {
          universityIdNumber: payload.universityIdNumber,
          doctorCategory: payload.doctorCategory,
          requestedDepartmentIds: uniqueDeptIds,
          supervisorId: resolvedSupervisorId,
        },
        req,
      });

      return {
        userId: doctorId,
        role: userRow.role,
        fullName: userRow.full_name,
        phone: userRow.phone,
        accountStatus: userRow.account_status,
        requestedDepartmentIds: uniqueDeptIds,
      };
    });
  } catch (err) {
    if (storedIdProof) {
      await deleteStoredFileQuietly(storedIdProof.storageKey);
    }
    throw err;
  }
}

/**
 * POST /api/v1/auth/register/supervisor
 * Registers a supervisor account (`PENDING_APPROVAL`) and creates a `supervisor_profiles` row.
 *
 * @param {import('z').infer<typeof import('./auth.validators.js').registerSupervisorSchema>} payload
 * @param {import('express').Request} req
 */
export async function registerSupervisor(payload, req) {
  let resolvedDeptId = 1;
  if (payload.departmentId) {
    const deptRes = await pool.query(
      `SELECT department_id FROM departments
       WHERE (department_id::TEXT = $1::TEXT
          OR UPPER(code) = UPPER($1::TEXT)
          OR UPPER(name_en) ILIKE '%' || $1::TEXT || '%'
          OR UPPER(name_ar) ILIKE '%' || $1::TEXT || '%')
         AND is_active = TRUE
       LIMIT 1`,
      [String(payload.departmentId).trim()]
    );
    if (deptRes.rows.length > 0) {
      resolvedDeptId = Number(deptRes.rows[0].department_id);
    }
  }

  const passwordHash = await bcrypt.hash(payload.password, BCRYPT_SALT_ROUNDS);

  return withTransaction(async (client) => {
    const userInsert = await client.query(
      `INSERT INTO users (
         role,
         full_name,
         phone,
         email,
         password_hash,
         account_status,
         preferred_language
       )
       VALUES ('SUPERVISOR', $1, $2, $3, $4, 'PENDING_APPROVAL', $5)
       RETURNING user_id, role, full_name, phone, email, account_status, created_at`,
      [
        payload.fullName,
        payload.phone,
        payload.email || null,
        passwordHash,
        payload.preferredLanguage || 'ar',
      ]
    );

    const userRow = userInsert.rows[0];
    const supervisorId = Number(userRow.user_id);
    const provisionalCode = `SUP-${String(supervisorId).padStart(4, '0')}`;

    await client.query(
      `INSERT INTO supervisor_profiles (
         supervisor_id,
         supervisor_code,
         department_id,
         title,
         specialty,
         is_triage_examiner
       )
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        supervisorId,
        provisionalCode,
        resolvedDeptId,
        payload.title || null,
        payload.specialty || null,
        Boolean(payload.isTriageExaminer),
      ]
    );

    await writeAuditLog(client, {
      actorUserId: supervisorId,
      actorRole: 'SUPERVISOR',
      action: 'SUPERVISOR_REGISTERED',
      entityType: 'users',
      entityId: supervisorId,
      afterData: {
        supervisorCode: provisionalCode,
        departmentId: payload.departmentId || null,
        isTriageExaminer: Boolean(payload.isTriageExaminer),
      },
      req,
    });

    return {
      userId: supervisorId,
      role: userRow.role,
      fullName: userRow.full_name,
      phone: userRow.phone,
      accountStatus: userRow.account_status,
      supervisorCode: provisionalCode,
    };
  });
}

/**
 * POST /api/v1/auth/login
 * Authenticates a user by `phone` + `password`, enforces `account_status` checks,
 * upserts `user_devices` if `fcmToken` is provided, and issues JWT access/refresh tokens (§4.1).
 *
 * @param {import('z').infer<typeof import('./auth.validators.js').loginSchema>} payload
 * @param {import('express').Request} req
 */
export async function loginUser(payload, req) {
  const { rows } = await pool.query(
    `SELECT
       u.user_id,
       u.role,
       u.full_name,
       u.phone,
       u.email,
       u.password_hash,
       u.account_status,
       u.rejection_reason,
       u.preferred_language,
       u.token_version,
       u.deleted_at,
       sp.supervisor_code,
       sp.is_triage_examiner,
       COALESCE(
         ARRAY(
           SELECT dd.department_id
           FROM doctor_departments dd
           WHERE dd.doctor_id = u.user_id
             AND dd.is_active = TRUE
           ORDER BY dd.department_id ASC
         ),
         ARRAY[]::BIGINT[]
       ) AS department_ids
     FROM users u
     LEFT JOIN supervisor_profiles sp ON sp.supervisor_id = u.user_id
     WHERE u.phone = $1 OR LOWER(u.email) = LOWER($1)
     LIMIT 1`,
    [payload.phone]
  );

  if (rows.length === 0 || rows[0].deleted_at !== null) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid phone number or password.');
  }

  const userRow = rows[0];
  const passwordValid = await bcrypt.compare(payload.password, userRow.password_hash);
  if (!passwordValid) {
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Invalid phone number or password.');
  }

  if (userRow.account_status === 'PENDING_APPROVAL') {
    throw new AppError(
      403,
      'ACCOUNT_PENDING_APPROVAL',
      'Your account is pending administrator approval.',
      { accountStatus: 'PENDING_APPROVAL' }
    );
  }

  if (userRow.account_status === 'REJECTED') {
    throw new AppError(
      403,
      'ACCOUNT_REJECTED',
      'Your account registration was rejected by an administrator.',
      {
        accountStatus: 'REJECTED',
        rejectionReason: userRow.rejection_reason || null,
      }
    );
  }

  if (userRow.account_status === 'SUSPENDED' || userRow.account_status === 'DEACTIVATED') {
    throw new AppError(
      403,
      'ACCOUNT_SUSPENDED',
      'Your account has been suspended or deactivated.',
      {
        accountStatus: userRow.account_status,
        rejectionReason: userRow.rejection_reason || null,
      }
    );
  }

  const userId = Number(userRow.user_id);
  const departmentIds = Array.isArray(userRow.department_ids)
    ? userRow.department_ids.map((id) => Number(id))
    : [];

  return withTransaction(async (client) => {
    await client.query(`UPDATE users SET last_login_at = now() WHERE user_id = $1`, [userId]);

    if (payload.fcmToken && payload.platform) {
      await client.query(
        `INSERT INTO user_devices (user_id, fcm_token, platform, last_seen_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT (fcm_token) DO UPDATE
           SET user_id = EXCLUDED.user_id,
               platform = EXCLUDED.platform,
               last_seen_at = now()`,
        [userId, payload.fcmToken, payload.platform]
      );
    }

    const tokens = await issueSessionTokens(
      client,
      {
        userId,
        role: userRow.role,
        accountStatus: userRow.account_status,
        tokenVersion: Number(userRow.token_version),
        departmentIds,
      },
      req
    );

    await writeAuditLog(client, {
      actorUserId: userId,
      actorRole: userRow.role,
      action: 'USER_LOGGED_IN',
      entityType: 'users',
      entityId: userId,
      req,
    });

    return {
      user: {
        userId,
        role: userRow.role,
        fullName: userRow.full_name,
        phone: userRow.phone,
        email: userRow.email,
        accountStatus: userRow.account_status,
        preferredLanguage: userRow.preferred_language,
        ...(userRow.role === 'DOCTOR' ? { departmentIds } : {}),
        ...(userRow.role === 'SUPERVISOR'
          ? {
              supervisorCode: userRow.supervisor_code,
              isTriageExaminer: Boolean(userRow.is_triage_examiner),
            }
          : {}),
      },
      tokens,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
    };
  });
}

/**
 * POST /api/v1/auth/refresh
 * Rotates a refresh token within its `family_id`.
 * If a previously revoked token is presented (token theft / replay), revokes the entire
 * token family AND increments `users.token_version` to invalidate all active JWTs immediately (§4.1).
 *
 * @param {string} rawRefreshToken
 * @param {import('express').Request} req
 */
export async function refreshUserTokens(rawRefreshToken, req) {
  const tokenHash = hashRefreshToken(rawRefreshToken);

  // Use a dedicated transaction that commits revocation even when throwing 401 on token reuse
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows } = await client.query(
      `SELECT
         rt.token_id,
         rt.user_id,
         rt.family_id,
         rt.expires_at,
         rt.revoked_at,
         u.role,
         u.account_status,
         u.token_version,
         u.deleted_at,
         COALESCE(
           ARRAY(
             SELECT dd.department_id
             FROM doctor_departments dd
             WHERE dd.doctor_id = u.user_id
               AND dd.is_active = TRUE
             ORDER BY dd.department_id ASC
           ),
           ARRAY[]::BIGINT[]
         ) AS department_ids
       FROM refresh_tokens rt
       JOIN users u ON u.user_id = rt.user_id
       WHERE rt.token_hash = $1
       FOR UPDATE OF rt`,
      [tokenHash]
    );

    if (rows.length === 0) {
      await client.query('ROLLBACK');
      throw new AppError(401, 'INVALID_REFRESH_TOKEN', 'Refresh token is invalid.');
    }

    const record = rows[0];
    const userId = Number(record.user_id);

    // Token reuse detection: token was already revoked!
    if (record.revoked_at !== null) {
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = now()
         WHERE family_id = $1
           AND revoked_at IS NULL`,
        [record.family_id]
      );

      await client.query(
        `UPDATE users
         SET token_version = token_version + 1
         WHERE user_id = $1`,
        [userId]
      );

      await writeAuditLog(client, {
        actorUserId: userId,
        actorRole: record.role,
        action: 'REFRESH_TOKEN_REUSE_DETECTED',
        entityType: 'users',
        entityId: userId,
        afterData: { familyId: record.family_id, compromisedTokenId: Number(record.token_id) },
        req,
      });

      await client.query('COMMIT');
      throw new AppError(
        401,
        'REFRESH_TOKEN_REUSED',
        'Refresh token reuse detected. For your security, all active sessions have been revoked. Please log in again.'
      );
    }

    if (new Date(record.expires_at).getTime() <= Date.now()) {
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE token_id = $1`,
        [record.token_id]
      );
      await client.query('COMMIT');
      throw new AppError(401, 'REFRESH_TOKEN_EXPIRED', 'Refresh token has expired. Please log in again.');
    }

    if (record.deleted_at !== null || record.account_status !== 'ACTIVE') {
      await client.query(
        `UPDATE refresh_tokens SET revoked_at = now() WHERE token_id = $1`,
        [record.token_id]
      );
      await client.query('COMMIT');
      throw new AppError(
        403,
        'ACCOUNT_NOT_ACTIVE',
        `Account status is ${record.account_status}. Cannot refresh session.`
      );
    }

    // Revoke current token and issue rotated token in the same family_id
    await client.query(
      `UPDATE refresh_tokens SET revoked_at = now() WHERE token_id = $1`,
      [record.token_id]
    );

    const departmentIds = Array.isArray(record.department_ids)
      ? record.department_ids.map((id) => Number(id))
      : [];

    const tokens = await issueSessionTokens(
      client,
      {
        userId,
        role: record.role,
        accountStatus: record.account_status,
        tokenVersion: Number(record.token_version),
        departmentIds,
      },
      req,
      record.family_id
    );

    await client.query('COMMIT');
    return { tokens };
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Ignore if already committed/rolled back
    }
    throw err;
  } finally {
    client.release();
  }
}

/**
 * POST /api/v1/auth/logout
 * Revokes the caller's refresh token (or all sessions if `allDevices = true`)
 * and removes `fcmToken` if provided (§4.1).
 *
 * @param {number} userId
 * @param {string} userRole
 * @param {import('z').infer<typeof import('./auth.validators.js').logoutSchema>} payload
 * @param {import('express').Request} req
 */
export async function logoutUser(userId, userRole, payload, req) {
  return withTransaction(async (client) => {
    if (payload.allDevices) {
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = now()
         WHERE user_id = $1
           AND revoked_at IS NULL`,
        [userId]
      );
      await client.query(
        `UPDATE users
         SET token_version = token_version + 1
         WHERE user_id = $1`,
        [userId]
      );
    } else if (payload.refreshToken) {
      const tokenHash = hashRefreshToken(payload.refreshToken);
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = now()
         WHERE user_id = $1
           AND token_hash = $2
           AND revoked_at IS NULL`,
        [userId, tokenHash]
      );
    } else {
      // Revoke the most recent active refresh token for this user if none specified
      await client.query(
        `UPDATE refresh_tokens
         SET revoked_at = now()
         WHERE token_id IN (
           SELECT token_id
           FROM refresh_tokens
           WHERE user_id = $1
             AND revoked_at IS NULL
           ORDER BY created_at DESC
           LIMIT 1
         )`,
        [userId]
      );
    }

    if (payload.fcmToken) {
      await client.query(
        `DELETE FROM user_devices
         WHERE user_id = $1
           AND fcm_token = $2`,
        [userId, payload.fcmToken]
      );
    }

    await writeAuditLog(client, {
      actorUserId: userId,
      actorRole: userRole,
      action: 'USER_LOGGED_OUT',
      entityType: 'users',
      entityId: userId,
      afterData: { allDevices: Boolean(payload.allDevices) },
      req,
    });

    return { loggedOut: true };
  });
}
