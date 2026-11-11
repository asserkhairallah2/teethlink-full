import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import { writeAuditLog } from '../../utils/audit.js';
import {
  deleteStoredFileQuietly,
  generateSignedFileUrl,
  insertFileRecord,
  validateAndStoreUploadedFile,
} from '../files/files.service.js';
import {
  allergyAnswerSchema,
  conditionAnswerSchema,
  medicationAnswerSchema,
} from '../auth/auth.validators.js';

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
const E164_PHONE_REGEX = /^\+[1-9][0-9]{7,14}$/;

export const updateMedicalProfileSchema = z.object({
  dateOfBirth: z
    .string()
    .regex(ISO_DATE_REGEX, 'dateOfBirth must be YYYY-MM-DD')
    .nullable()
    .optional(),
  gender: z.enum(['MALE', 'FEMALE']).nullable().optional(),
  addressArea: z.string().trim().max(120).nullable().optional(),
  emergencyContactPhone: z
    .string()
    .trim()
    .regex(E164_PHONE_REGEX, 'emergencyContactPhone must be in E.164 format.')
    .nullable()
    .optional(),
  photoConsent: z.boolean().optional(),
  medicalNotes: z.string().trim().max(2000).nullable().optional(),
  documentDelivery: z
    .enum(['NOT_REQUIRED', 'UPLOADED', 'WILL_BRING_PHYSICALLY'])
    .optional(),
  documentType: z
    .enum(['PRESCRIPTION', 'DIAGNOSIS_REPORT', 'LAB_RESULT', 'OTHER'])
    .optional()
    .default('PRESCRIPTION'),
  diagnosisDate: z
    .string()
    .regex(ISO_DATE_REGEX, 'diagnosisDate must be YYYY-MM-DD')
    .nullable()
    .optional(),
  preUploadedFileId: z.coerce.number().int().positive().optional(),
  conditions: z.array(conditionAnswerSchema).min(1),
  allergies: z.array(allergyAnswerSchema).optional().default([]),
  medications: z.array(medicationAnswerSchema).optional().default([]),
});

export const uploadMedicalDocumentMetaSchema = z.object({
  conditionId: z.coerce.number().int().positive().nullable().optional(),
  conditionCode: z.string().trim().max(40).nullable().optional(),
  documentType: z
    .enum(['PRESCRIPTION', 'DIAGNOSIS_REPORT', 'LAB_RESULT', 'OTHER'])
    .optional()
    .default('PRESCRIPTION'),
  diagnosisDate: z
    .string()
    .regex(ISO_DATE_REGEX, 'diagnosisDate must be YYYY-MM-DD')
    .nullable()
    .optional(),
  notes: z.string().trim().max(1000).nullable().optional(),
});

/**
 * Enforces the §0.4 Privacy Matrix for viewing a patient's full medical profile & documents:
 * - `PATIENT`: self only (`viewer.userId === targetPatientId`)
 * - `SUPERVISOR` / `ADMIN`: any patient
 * - `DOCTOR`: only if `cases.assigned_doctor_id = viewer.userId` for at least one case of `targetPatientId`
 *
 * @param {{ userId: number, role: string }} viewer
 * @param {number} targetPatientId
 */
export async function assertCanAccessPatientMedicalProfile(viewer, targetPatientId) {
  const viewerId = Number(viewer.userId);
  const patientId = Number(targetPatientId);

  if (viewer.role === 'ADMIN' || viewer.role === 'SUPERVISOR') {
    return;
  }

  if (viewer.role === 'PATIENT') {
    if (viewerId === patientId) {
      return;
    }
    throw new AppError(
      403,
      'MEDICAL_PROFILE_ACCESS_DENIED',
      'Patients can only view their own medical profile.'
    );
  }

  if (viewer.role === 'DOCTOR') {
    const { rowCount } = await pool.query(
      `SELECT 1
       FROM cases c
       WHERE c.patient_id = $1
         AND c.assigned_doctor_id = $2
       LIMIT 1`,
      [patientId, viewerId]
    );

    if (rowCount > 0) {
      return;
    }

    throw new AppError(
      403,
      'MEDICAL_PROFILE_ACCESS_DENIED',
      'Doctors may only view the full medical profile and prescriptions of patients whose case they have claimed.'
    );
  }

  throw new AppError(403, 'MEDICAL_PROFILE_ACCESS_DENIED', 'Access to patient medical profile denied.');
}

/**
 * GET /api/v1/patients/:patientId/medical-profile
 * Retrieves the complete patient medical profile, conditions, allergies, medications,
 * derived risk flags (`v_patient_risk_flags`), and 15-min signed URLs for medical documents (§4.1).
 *
 * @param {number} targetPatientId
 * @param {{ userId: number, role: string }} viewer
 * @param {'ar' | 'en'} [lang='ar']
 */
export async function getPatientMedicalProfile(targetPatientId, viewer, lang = 'ar') {
  const patientId = Number(targetPatientId);
  await assertCanAccessPatientMedicalProfile(viewer, patientId);

  const isAr = lang === 'ar';

  const profileRes = await pool.query(
    `SELECT
       u.user_id AS patient_id,
       u.full_name,
       u.phone,
       u.email,
       pp.date_of_birth,
       CASE
         WHEN pp.date_of_birth IS NOT NULL
         THEN EXTRACT(YEAR FROM age(CURRENT_DATE, pp.date_of_birth))::INT
         ELSE NULL
       END AS age,
       pp.gender,
       pp.address_area,
       pp.emergency_contact_phone,
       pp.questionnaire_completed_at,
       pp.has_critical_condition,
       pp.medical_document_status,
       pp.medical_attachment_url,
       pp.latest_medical_document_id,
       pp.medical_notes,
       pp.photo_consent
     FROM users u
     JOIN patient_profiles pp ON pp.patient_id = u.user_id
     WHERE u.user_id = $1
       AND u.role = 'PATIENT'
       AND u.deleted_at IS NULL
     LIMIT 1`,
    [patientId]
  );

  if (profileRes.rows.length === 0) {
    throw new AppError(404, 'PATIENT_NOT_FOUND', `Patient ${patientId} was not found.`);
  }

  const profile = profileRes.rows[0];

  const [docsRes, flagsRes, condsRes, allergiesRes, medsRes] = await Promise.all([
    pool.query(
      `SELECT
         pmd.document_id,
         pmd.condition_id,
         mc.code AS condition_code,
         pmd.document_type,
         pmd.diagnosis_date,
         pmd.notes,
         pmd.is_current,
         pmd.verified_by,
         pmd.verified_at,
         pmd.uploaded_at,
         f.file_id,
         f.storage_key,
         f.original_name,
         f.mime_type,
         f.size_bytes
       FROM patient_medical_documents pmd
       JOIN files f ON f.file_id = pmd.file_id
       LEFT JOIN medical_conditions mc ON mc.condition_id = pmd.condition_id
       WHERE pmd.patient_id = $1
       ORDER BY pmd.uploaded_at DESC, pmd.document_id DESC`,
      [patientId]
    ),
    pool.query(
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
    pool.query(
      `SELECT
         pc.condition_id,
         mc.code,
         mc.name_en,
         mc.name_ar,
         mc.is_critical,
         pc.has_condition,
         pc.selected_options,
         pc.details,
         pc.document_status,
         pc.answered_at
       FROM patient_conditions pc
       JOIN medical_conditions mc ON mc.condition_id = pc.condition_id
       WHERE pc.patient_id = $1
       ORDER BY mc.is_critical DESC, mc.display_order ASC`,
      [patientId]
    ),
    pool.query(
      `SELECT
         pa.allergy_id,
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
    pool.query(
      `SELECT
         medication_id,
         medication_name,
         dosage,
         frequency,
         is_anticoagulant,
         notes,
         created_at
       FROM patient_medications
       WHERE patient_id = $1
       ORDER BY medication_id ASC`,
      [patientId]
    ),
  ]);

  const documents = docsRes.rows.map((doc) => ({
    documentId: Number(doc.document_id),
    fileId: Number(doc.file_id),
    conditionId: doc.condition_id ? Number(doc.condition_id) : null,
    conditionCode: doc.condition_code || null,
    documentType: doc.document_type,
    diagnosisDate: doc.diagnosis_date
      ? new Date(doc.diagnosis_date).toISOString().slice(0, 10)
      : null,
    notes: doc.notes || null,
    originalName: doc.original_name,
    mimeType: doc.mime_type,
    sizeBytes: Number(doc.size_bytes),
    isCurrent: Boolean(doc.is_current),
    signedUrl: generateSignedFileUrl(doc.storage_key),
    verifiedBySupervisor: Boolean(doc.verified_by && doc.verified_at),
    verifiedByUserId: doc.verified_by ? Number(doc.verified_by) : null,
    verifiedAt: doc.verified_at || null,
    uploadedAt: doc.uploaded_at,
  }));

  const riskFlags = flagsRes.rows.map((rf) => ({
    code: rf.code,
    name: isAr ? rf.name_ar : rf.name_en,
    nameEn: rf.name_en,
    nameAr: rf.name_ar,
    severity: rf.severity,
    source: rf.source,
    sourceCode: rf.source_code,
  }));

  const conditions = condsRes.rows.map((c) => ({
    conditionId: Number(c.condition_id),
    code: c.code,
    name: isAr ? c.name_ar : c.name_en,
    nameEn: c.name_en,
    nameAr: c.name_ar,
    isCritical: Boolean(c.is_critical),
    hasCondition: Boolean(c.has_condition),
    selectedOptions: Array.isArray(c.selected_options) ? c.selected_options : [],
    details: c.details || null,
    documentStatus: c.document_status,
  }));

  const allergies = allergiesRes.rows.map((a) => ({
    allergyId: Number(a.allergy_id),
    code: a.code,
    name: isAr ? a.name_ar : a.name_en,
    nameEn: a.name_en,
    nameAr: a.name_ar,
    notes: a.notes || null,
  }));

  const medications = medsRes.rows.map((m) => ({
    medicationId: Number(m.medication_id),
    medicationName: m.medication_name,
    dosage: m.dosage || null,
    frequency: m.frequency || null,
    isAnticoagulant: Boolean(m.is_anticoagulant),
    notes: m.notes || null,
  }));

  return {
    patient: {
      patientId: Number(profile.patient_id),
      fullName: profile.full_name,
      phone: profile.phone,
      email: profile.email || null,
      dateOfBirth: profile.date_of_birth
        ? new Date(profile.date_of_birth).toISOString().slice(0, 10)
        : null,
      age: profile.age !== null ? Number(profile.age) : null,
      gender: profile.gender || null,
      addressArea: profile.address_area || null,
      emergencyContactPhone: profile.emergency_contact_phone || null,
      photoConsent: Boolean(profile.photo_consent),
    },
    hasCriticalCondition: Boolean(profile.has_critical_condition),
    medicalDocumentStatus: profile.medical_document_status,
    medicalAttachmentUrl: profile.medical_attachment_url
      ? generateSignedFileUrl(profile.medical_attachment_url)
      : null,
    medicalNotes: profile.medical_notes || null,
    questionnaireCompletedAt: profile.questionnaire_completed_at,
    documents,
    riskFlags,
    conditions,
    allergies,
    medications,
  };
}

/**
 * PUT /api/v1/patients/me/medical-profile
 * Updates a patient's medical questionnaire answers, allergies, medications, photo consent,
 * and optional prescription attachment, recomputing `has_critical_condition` and
 * `medical_document_status` and logging an audit entry (§4.1).
 *
 * @param {number} patientId
 * @param {import('z').infer<typeof updateMedicalProfileSchema>} payload
 * @param {Express.Multer.File | undefined} uploadedFile
 * @param {import('express').Request} req
 */
export async function updateMyMedicalProfile(patientId, payload, uploadedFile, req) {
  const { rows: catalogRows } = await pool.query(
    `SELECT condition_id, code, name_en, is_critical, requires_document_if_yes
     FROM medical_conditions
     WHERE is_active = TRUE`
  );

  const catalogById = new Map(catalogRows.map((r) => [Number(r.condition_id), r]));
  const submittedById = new Map();

  for (const cond of payload.conditions) {
    const cid = Number(cond.conditionId);
    if (!catalogById.has(cid)) {
      throw new AppError(422, 'INVALID_CONDITION_ID', `Condition ID ${cid} does not exist.`);
    }
    submittedById.set(cid, cond);
  }

  const missingCritical = catalogRows
    .filter((r) => r.is_critical && !submittedById.has(Number(r.condition_id)))
    .map((r) => ({ conditionId: Number(r.condition_id), code: r.code }));

  if (missingCritical.length > 0) {
    throw new AppError(
      422,
      'CRITICAL_QUESTIONS_INCOMPLETE',
      'All critical medical questionnaire questions must be answered.',
      { missingCriticalQuestions: missingCritical }
    );
  }

  let hasCriticalCondition = false;
  const affirmativeDocRequiredConditions = [];

  for (const [cid, submitted] of submittedById.entries()) {
    const cat = catalogById.get(cid);
    if (submitted.hasCondition && cat.is_critical) {
      hasCriticalCondition = true;
    }
    if (submitted.hasCondition && cat.requires_document_if_yes) {
      affirmativeDocRequiredConditions.push({
        conditionId: cid,
        code: cat.code,
        documentDelivery: submitted.documentDelivery,
      });
    }
  }

  let storedFile = null;
  if (uploadedFile) {
    storedFile = await validateAndStoreUploadedFile(uploadedFile, 'MEDICAL_DOCUMENT');
  }

  try {
    await withTransaction(async (client) => {
      const existingProfileRes = await client.query(
        `SELECT
           has_critical_condition,
           medical_document_status,
           medical_attachment_url,
           latest_medical_document_id,
           photo_consent
         FROM patient_profiles
         WHERE patient_id = $1
         FOR UPDATE`,
        [patientId]
      );

      if (existingProfileRes.rows.length === 0) {
        throw new AppError(404, 'PATIENT_PROFILE_NOT_FOUND', 'Patient profile not found.');
      }

      const existingProfile = existingProfileRes.rows[0];

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
      } else if (payload.preUploadedFileId) {
        const preRes = await client.query(
          `SELECT file_id, owner_user_id, purpose, storage_key
           FROM files
           WHERE file_id = $1
             AND owner_user_id = $2
           LIMIT 1`,
          [Number(payload.preUploadedFileId), patientId]
        );
        if (preRes.rows.length === 0) {
          throw new AppError(422, 'INVALID_FILE_ID', 'preUploadedFileId does not exist or belong to this patient.');
        }
        fileRow = preRes.rows[0];
      }

      const alreadyHasUploadedDoc = Boolean(
        existingProfile.medical_attachment_url &&
          ['UPLOADED', 'VERIFIED'].includes(existingProfile.medical_document_status)
      );

      if (affirmativeDocRequiredConditions.length > 0 && !fileRow && !alreadyHasUploadedDoc) {
        const allPledgedPhysically =
          payload.documentDelivery === 'WILL_BRING_PHYSICALLY' ||
          affirmativeDocRequiredConditions.every(
            (item) => item.documentDelivery === 'WILL_BRING_PHYSICALLY'
          );

        if (!allPledgedPhysically) {
          throw new AppError(
            422,
            'MEDICAL_DOCUMENT_OR_PHYSICAL_PLEDGE_REQUIRED',
            'Answering Yes to a critical condition requires either an uploaded prescription/diagnosis document or selecting WILL_BRING_PHYSICALLY.',
            {
              criticalConditionsRequiringDocument: affirmativeDocRequiredConditions.map(
                (c) => c.code
              ),
            }
          );
        }
      }

      let newDocId = existingProfile.latest_medical_document_id
        ? Number(existingProfile.latest_medical_document_id)
        : null;
      let newAttachmentKey = existingProfile.medical_attachment_url || null;

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
            payload.documentType || 'PRESCRIPTION',
            payload.diagnosisDate || null,
            payload.medicalNotes || null,
          ]
        );

        newDocId = Number(docInsert.rows[0].document_id);
        newAttachmentKey = fileRow.storage_key;
      }

      let newMedicalDocumentStatus = 'NOT_REQUIRED';
      if (fileRow) {
        newMedicalDocumentStatus = 'UPLOADED';
      } else if (alreadyHasUploadedDoc) {
        newMedicalDocumentStatus = existingProfile.medical_document_status;
      } else if (affirmativeDocRequiredConditions.length > 0) {
        newMedicalDocumentStatus = 'WILL_BRING_PHYSICALLY';
      }

      // Upsert patient_conditions
      for (const [cid, submitted] of submittedById.entries()) {
        const cat = catalogById.get(cid);
        let condDocStatus = 'NOT_REQUIRED';

        if (submitted.hasCondition) {
          if ((fileRow || alreadyHasUploadedDoc) && cat.requires_document_if_yes) {
            condDocStatus =
              existingProfile.medical_document_status === 'VERIFIED' && !fileRow
                ? 'VERIFIED'
                : 'UPLOADED';
          } else if (cat.requires_document_if_yes) {
            condDocStatus = 'WILL_BRING_PHYSICALLY';
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
           VALUES ($1, $2, $3, $4::jsonb, $5, $6, now())
           ON CONFLICT (patient_id, condition_id) DO UPDATE
             SET has_condition = EXCLUDED.has_condition,
                 selected_options = EXCLUDED.selected_options,
                 details = EXCLUDED.details,
                 document_status = EXCLUDED.document_status,
                 answered_at = now()`,
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

      // Replace patient_allergies
      await client.query(`DELETE FROM patient_allergies WHERE patient_id = $1`, [patientId]);
      const uniqueAllergies = new Map();
      for (const allergy of payload.allergies || []) {
        uniqueAllergies.set(Number(allergy.allergyId), allergy);
      }
      for (const [allergyId, allergy] of uniqueAllergies.entries()) {
        await client.query(
          `INSERT INTO patient_allergies (patient_id, allergy_id, notes)
           VALUES ($1, $2, $3)`,
          [patientId, allergyId, allergy.notes || null]
        );
      }

      // Replace patient_medications
      await client.query(`DELETE FROM patient_medications WHERE patient_id = $1`, [patientId]);
      for (const med of payload.medications || []) {
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

      // Update patient_profiles
      const nextPhotoConsent =
        payload.photoConsent !== undefined
          ? Boolean(payload.photoConsent)
          : Boolean(existingProfile.photo_consent);

      await client.query(
        `UPDATE patient_profiles
         SET date_of_birth = COALESCE($2, date_of_birth),
             gender = COALESCE($3, gender),
             address_area = COALESCE($4, address_area),
             emergency_contact_phone = COALESCE($5, emergency_contact_phone),
             questionnaire_completed_at = now(),
             has_critical_condition = $6,
             medical_document_status = $7,
             medical_attachment_url = $8,
             latest_medical_document_id = $9,
             medical_notes = COALESCE($10, medical_notes),
             photo_consent = $11,
             photo_consent_updated_at = CASE
               WHEN $11 IS DISTINCT FROM photo_consent THEN now()
               ELSE photo_consent_updated_at
             END
         WHERE patient_id = $1`,
        [
          patientId,
          payload.dateOfBirth !== undefined ? payload.dateOfBirth : null,
          payload.gender !== undefined ? payload.gender : null,
          payload.addressArea !== undefined ? payload.addressArea : null,
          payload.emergencyContactPhone !== undefined ? payload.emergencyContactPhone : null,
          hasCriticalCondition,
          newMedicalDocumentStatus,
          newAttachmentKey,
          newDocId,
          payload.medicalNotes !== undefined ? payload.medicalNotes : null,
          nextPhotoConsent,
        ]
      );

      await writeAuditLog(client, {
        actorUserId: patientId,
        actorRole: 'PATIENT',
        action: 'MEDICAL_PROFILE_UPDATED',
        entityType: 'patient_profiles',
        entityId: patientId,
        beforeData: {
          hasCriticalCondition: existingProfile.has_critical_condition,
          medicalDocumentStatus: existingProfile.medical_document_status,
        },
        afterData: {
          hasCriticalCondition,
          medicalDocumentStatus: newMedicalDocumentStatus,
          uploadedNewDocument: Boolean(fileRow),
        },
        req,
      });
    });

    return getPatientMedicalProfile(
      patientId,
      { userId: patientId, role: 'PATIENT' },
      req?.lang || 'ar'
    );
  } catch (err) {
    if (storedFile) {
      await deleteStoredFileQuietly(storedFile.storageKey);
    }
    throw err;
  }
}

/**
 * POST /api/v1/patients/me/medical-documents
 * Uploads a new prescription/diagnosis report for the authenticated patient,
 * updates `patient_profiles.medical_attachment_url` and `medical_document_status = 'UPLOADED'`,
 * and logs an audit entry (§4.1).
 *
 * @param {number} patientId
 * @param {Express.Multer.File} uploadedFile
 * @param {import('z').infer<typeof uploadMedicalDocumentMetaSchema>} meta
 * @param {import('express').Request} req
 */
export async function uploadMyMedicalDocument(patientId, uploadedFile, meta, req) {
  if (!uploadedFile) {
    throw new AppError(
      400,
      'MEDICAL_DOCUMENT_FILE_REQUIRED',
      'Multipart file field "medicalDocument" (or "file") is required.'
    );
  }

  let resolvedConditionId = meta.conditionId ? Number(meta.conditionId) : null;
  if (!resolvedConditionId && meta.conditionCode) {
    const { rows } = await pool.query(
      `SELECT condition_id FROM medical_conditions WHERE code = $1 LIMIT 1`,
      [meta.conditionCode.trim().toUpperCase()]
    );
    if (rows.length === 0) {
      throw new AppError(
        422,
        'INVALID_CONDITION_CODE',
        `Medical condition code '${meta.conditionCode}' does not exist.`
      );
    }
    resolvedConditionId = Number(rows[0].condition_id);
  }

  const storedFile = await validateAndStoreUploadedFile(uploadedFile, 'MEDICAL_DOCUMENT');

  try {
    return await withTransaction(async (client) => {
      const fileRow = await insertFileRecord(client, {
        ownerUserId: patientId,
        purpose: 'MEDICAL_DOCUMENT',
        storageKey: storedFile.storageKey,
        originalName: storedFile.originalName,
        mimeType: storedFile.mimeType,
        sizeBytes: storedFile.sizeBytes,
        sha256: storedFile.sha256,
        isPrivate: true,
      });

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
         RETURNING
           document_id,
           patient_id,
           file_id,
           condition_id,
           document_type,
           diagnosis_date,
           notes,
           is_current,
           uploaded_at`,
        [
          patientId,
          Number(fileRow.file_id),
          resolvedConditionId,
          meta.documentType || 'PRESCRIPTION',
          meta.diagnosisDate || null,
          meta.notes || null,
        ]
      );

      const docRow = docInsert.rows[0];
      const documentId = Number(docRow.document_id);

      await client.query(
        `UPDATE patient_profiles
         SET medical_document_status = 'UPLOADED',
             medical_attachment_url = $2,
             latest_medical_document_id = $3
         WHERE patient_id = $1`,
        [patientId, fileRow.storage_key, documentId]
      );

      if (resolvedConditionId) {
        await client.query(
          `UPDATE patient_conditions
           SET document_status = 'UPLOADED'
           WHERE patient_id = $1
             AND condition_id = $2
             AND has_condition = TRUE`,
          [patientId, resolvedConditionId]
        );
      } else {
        await client.query(
          `UPDATE patient_conditions
           SET document_status = 'UPLOADED'
           WHERE patient_id = $1
             AND has_condition = TRUE
             AND document_status IN ('WILL_BRING_PHYSICALLY', 'MISSING')`,
          [patientId]
        );
      }

      await writeAuditLog(client, {
        actorUserId: patientId,
        actorRole: 'PATIENT',
        action: 'MEDICAL_DOCUMENT_UPLOADED',
        entityType: 'patient_medical_documents',
        entityId: documentId,
        afterData: {
          fileId: Number(fileRow.file_id),
          conditionId: resolvedConditionId,
          documentType: docRow.document_type,
          medicalDocumentStatus: 'UPLOADED',
        },
        req,
      });

      return {
        documentId,
        fileId: Number(fileRow.file_id),
        conditionId: resolvedConditionId,
        documentType: docRow.document_type,
        diagnosisDate: docRow.diagnosis_date
          ? new Date(docRow.diagnosis_date).toISOString().slice(0, 10)
          : null,
        notes: docRow.notes || null,
        originalName: fileRow.original_name,
        mimeType: fileRow.mime_type,
        sizeBytes: Number(fileRow.size_bytes),
        signedUrl: generateSignedFileUrl(fileRow.storage_key),
        medicalDocumentStatus: 'UPLOADED',
        uploadedAt: docRow.uploaded_at,
      };
    });
  } catch (err) {
    await deleteStoredFileQuietly(storedFile.storageKey);
    throw err;
  }
}
