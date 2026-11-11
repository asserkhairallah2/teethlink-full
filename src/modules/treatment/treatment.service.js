import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import { createNotification, writeAuditLog } from '../../utils/audit.js';
import { emitToRooms } from '../../realtime/socketGateway.js';
import {
  deleteStoredFileQuietly,
  generateSignedFileUrl,
  insertFileRecord,
  validateAndStoreUploadedFile,
} from '../files/files.service.js';
import {
  completionReportInputSchema,
  loadBedSettings,
  scheduleBedSchema,
  scheduleBedTicketInTx,
  upsertCompletionReportInTx,
} from '../beds/beds.service.js';

// =============================================================================
// Zod Validation Schemas (§4.6)
// =============================================================================

export const nextAppointmentInputSchema = scheduleBedSchema.extend({
  path: z.enum(['SCHEDULED']).optional().default('SCHEDULED'),
});

export const submitCaseOutcomeSchema = z.object({
  outcome: z.enum(['NEEDS_FOLLOW_UP', 'FINISHED']),
  procedurePerformed: z.string().trim().max(4000).optional().nullable(),
  sessionNotes: z.string().trim().max(4000).optional().nullable(),
  nextSteps: z.string().trim().max(2000).optional().nullable(),
  nextAppointment: nextAppointmentInputSchema.optional().nullable(),
  completionReport: completionReportInputSchema.optional().nullable(),
});

export const uploadCasePhotoSchema = z.object({
  photoType: z.enum(['BEFORE', 'AFTER', 'DURING', 'XRAY', 'TRIAGE']),
  appointmentId: z.coerce.number().int().positive().optional().nullable(),
  caption: z.string().trim().max(300).optional().nullable(),
  takenAt: z.string().datetime().optional().nullable(),
  fileId: z.coerce.number().int().positive().optional().nullable(),
});

export const createPortfolioPostSchema = z.object({
  caseId: z.coerce.number().int().positive(),
  description: z.string().trim().min(5).max(3000),
  photoIds: z
    .array(z.coerce.number().int().positive())
    .max(10)
    .optional()
    .default([]),
});

export const submitCaseRatingSchema = z.object({
  score: z.coerce.number().int().min(1).max(5),
  communicationScore: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .nullable(),
  punctualityScore: z.coerce
    .number()
    .int()
    .min(1)
    .max(5)
    .optional()
    .nullable(),
  comment: z.string().trim().max(2000).optional().nullable(),
});

export const caseHistoryQuerySchema = z.object({
  status: z
    .enum(['ALL', 'ACTIVE', 'FINISHED', 'CANCELLED'])
    .optional()
    .default('ALL'),
});

export const reviewCompletionReportSchema = z.object({
  reviewStatus: z.enum(['APPROVED', 'REVISION_REQUESTED']),
  reviewNotes: z.string().trim().max(2000).optional().nullable(),
});

// =============================================================================
// 1. POST /api/v1/cases/:caseId/outcome (§4.6)
// =============================================================================

/**
 * Records a treatment session outcome (`NEEDS_FOLLOW_UP` or `FINISHED`) for a case.
 * - If the case is still `IN_TREATMENT`, automatically frees the active physical bed
 *   (`status = 'FREED'`) and completes the current appointment in the same transaction.
 * - If `outcome = 'NEEDS_FOLLOW_UP'` and `nextAppointment` is provided, immediately
 *   executes Path B reservation (`cases.status -> 'SCHEDULED'`).
 * - If `outcome = 'FINISHED'`, validates and inserts `completion_reports`, sets
 *   `cases.status = 'FINISHED'`, `finished_at = now()`, and sets `chat_conversations`
 *   to `READ_ONLY`.
 *
 * @param {number} caseId
 * @param {number} doctorId
 * @param {import('z').infer<typeof submitCaseOutcomeSchema>} payload
 * @param {import('express').Request} req
 */
export async function submitCaseSessionOutcome(caseId, doctorId, payload, req) {
  return withTransaction(
    async (client, afterCommit) => {
      const settings = await loadBedSettings(client);

      // 1) Lock Doctor row
      const docRes = await client.query(
        `SELECT d.doctor_id, u.full_name AS doctor_name
         FROM student_doctor_profiles d
         JOIN users u ON u.user_id = d.doctor_id
         WHERE d.doctor_id = $1
         FOR UPDATE`,
        [doctorId]
      );

      if (docRes.rows.length === 0) {
        throw new AppError(404, 'DOCTOR_NOT_FOUND', 'Doctor profile not found.');
      }
      const doctorName = docRes.rows[0].doctor_name;

      // 2) Lock Case row with NOWAIT
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
          'Only the doctor assigned to this case can submit its session outcome.'
        );
      }

      if (
        !['IN_TREATMENT', 'AWAITING_OUTCOME', 'NEEDS_FOLLOW_UP'].includes(
          caseRow.status
        )
      ) {
        throw new AppError(
          422,
          'INVALID_CASE_STATE_FOR_OUTCOME',
          `Case outcome can only be submitted when the case is in 'IN_TREATMENT', 'AWAITING_OUTCOME', or 'NEEDS_FOLLOW_UP' status (current status: '${caseRow.status}').`
        );
      }

      const patientId = Number(caseRow.patient_id);
      const departmentId = Number(caseRow.department_id);
      let currentCaseStatus = caseRow.status;

      // 3) Find and update the latest appointment (and free occupied bed if still IN_TREATMENT)
      const apptRes = await client.query(
        `SELECT
           appointment_id,
           session_no,
           status,
           started_at,
           ended_at,
           outcome
         FROM appointments
         WHERE case_id = $1
         ORDER BY session_no DESC, appointment_id DESC
         LIMIT 1
         FOR UPDATE NOWAIT`,
        [caseId]
      );

      let lastAppointment = null;
      let freedTicketPayload = null;

      if (apptRes.rows.length > 0) {
        const apptRow = apptRes.rows[0];
        const appointmentId = Number(apptRow.appointment_id);

        // Check if there is still an OCCUPIED bed ticket for this case
        const occTicketRes = await client.query(
          `SELECT
             bt.ticket_id,
             bt.ticket_code,
             bt.bed_id,
             bt.occupied_at,
             b.label AS bed_label,
             c.clinic_number
           FROM bed_tickets bt
           JOIN clinic_beds b ON b.bed_id = bt.bed_id
           JOIN clinics c ON c.clinic_id = b.clinic_id
           WHERE bt.case_id = $1
             AND bt.status = 'OCCUPIED'
           LIMIT 1
           FOR UPDATE OF bt NOWAIT`,
          [caseId]
        );

        let endedAtTime = apptRow.ended_at;

        if (occTicketRes.rows.length > 0) {
          const occTicket = occTicketRes.rows[0];
          const freeTicketRes = await client.query(
            `UPDATE bed_tickets
             SET status = 'FREED',
                 freed_at = now(),
                 freed_by = $2,
                 free_reason = 'DOCTOR_FINISHED',
                 version = version + 1,
                 updated_at = now()
             WHERE ticket_id = $1
             RETURNING freed_at`,
            [occTicket.ticket_id, doctorId]
          );
          endedAtTime = freeTicketRes.rows[0].freed_at;

          freedTicketPayload = {
            ticketId: Number(occTicket.ticket_id),
            ticketCode: occTicket.ticket_code,
            bedId: Number(occTicket.bed_id),
            bedLabel: occTicket.bed_label,
            clinicNumber: occTicket.clinic_number,
            departmentId,
            liveStatus: 'FREE',
            freedAt: endedAtTime,
            freeReason: 'DOCTOR_FINISHED',
            caseId,
            caseNumber: caseRow.case_number,
          };
        }

        const updApptRes = await client.query(
          `UPDATE appointments
           SET status = 'COMPLETED',
               started_at = COALESCE(started_at, now()),
               ended_at = COALESCE($2, ended_at, now()),
               outcome = $3::session_outcome,
               procedure_performed = COALESCE($4, procedure_performed),
               session_notes = COALESCE($5, session_notes),
               next_steps = COALESCE($6, next_steps),
               updated_at = now()
           WHERE appointment_id = $1
           RETURNING
             appointment_id,
             session_no,
             status,
             outcome,
             procedure_performed,
             session_notes,
             next_steps,
             started_at,
             ended_at`,
          [
            appointmentId,
            endedAtTime,
            payload.outcome,
            payload.procedurePerformed || null,
            payload.sessionNotes || null,
            payload.nextSteps || null,
          ]
        );

        const uAppt = updApptRes.rows[0];
        lastAppointment = {
          appointmentId: Number(uAppt.appointment_id),
          sessionNo: Number(uAppt.session_no),
          status: uAppt.status,
          outcome: uAppt.outcome,
          procedurePerformed: uAppt.procedure_performed,
          sessionNotes: uAppt.session_notes,
          nextSteps: uAppt.next_steps,
          startedAt: uAppt.started_at,
          endedAt: uAppt.ended_at,
        };
      }

      let nextAppointmentResult = null;
      let completionReportResult = null;
      let finalCaseStatus = payload.outcome;

      // 4) Handle NEEDS_FOLLOW_UP vs FINISHED
      if (payload.outcome === 'NEEDS_FOLLOW_UP') {
        if (currentCaseStatus !== 'NEEDS_FOLLOW_UP') {
          await client.query(
            `UPDATE cases
             SET status = 'NEEDS_FOLLOW_UP',
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
             VALUES ($1, $2, 'NEEDS_FOLLOW_UP', $3, $4, $5::jsonb)`,
            [
              caseId,
              currentCaseStatus,
              doctorId,
              'Session completed with outcome = NEEDS_FOLLOW_UP',
              JSON.stringify({
                procedurePerformed: payload.procedurePerformed || null,
                nextSteps: payload.nextSteps || null,
              }),
            ]
          );

          currentCaseStatus = 'NEEDS_FOLLOW_UP';
        }

        // If nextAppointment was supplied in the payload, immediately reserve the Path B bed ticket
        if (payload.nextAppointment) {
          const updatedCaseRow = {
            ...caseRow,
            status: 'NEEDS_FOLLOW_UP',
          };

          const schedRes = await scheduleBedTicketInTx(client, afterCommit, {
            caseRow: updatedCaseRow,
            doctorId,
            doctorName,
            patientName: caseRow.patient_name,
            scheduleInput: payload.nextAppointment,
            settings,
            req,
          });

          nextAppointmentResult = {
            appointment: schedRes.appointment,
            ticket: schedRes.ticket,
          };
          finalCaseStatus = 'SCHEDULED';
        } else {
          await createNotification(client, {
            userId: patientId,
            type: 'FOLLOW_UP_REQUIRED',
            title: 'Follow-Up Visit Required',
            body: `Dr. ${doctorName} completed today's session for case ${caseRow.case_number}. A follow-up session is required.`,
            caseId,
            data: {
              caseId,
              caseNumber: caseRow.case_number,
              nextSteps: payload.nextSteps || null,
            },
          });
        }
      } else {
        // outcome === 'FINISHED'
        const reportInput = payload.completionReport || {
          procedureSummary:
            payload.procedurePerformed ||
            payload.sessionNotes ||
            'Dental treatment completed.',
        };

        completionReportResult = await upsertCompletionReportInTx(client, {
          caseId,
          doctorId,
          totalSessions: Number(caseRow.total_sessions || 1),
          reportInput,
          settings,
        });

        await client.query(
          `UPDATE cases
           SET status = 'FINISHED',
               finished_at = now(),
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
           VALUES ($1, $2, 'FINISHED', $3, $4, $5::jsonb)`,
          [
            caseId,
            currentCaseStatus,
            doctorId,
            'Case completed and completion report submitted',
            JSON.stringify({
              reportId: completionReportResult.reportId,
              totalSessions: completionReportResult.totalSessions,
            }),
          ]
        );

        // Set Doctor-Patient chat conversation to READ_ONLY
        await client.query(
          `UPDATE chat_conversations
           SET status = 'READ_ONLY',
               read_only_at = now()
           WHERE case_id = $1
             AND status = 'OPEN'`,
          [caseId]
        );

        await createNotification(client, {
          userId: patientId,
          type: 'CASE_FINISHED',
          title: 'Treatment Completed!',
          body: `Dr. ${doctorName} has marked your case (${caseRow.case_number}) as finished. You can now view your treatment summary and rate your visit.`,
          caseId,
          data: {
            caseId,
            caseNumber: caseRow.case_number,
            reportId: completionReportResult.reportId,
          },
        });

        finalCaseStatus = 'FINISHED';
      }

      await writeAuditLog(client, {
        actorUserId: doctorId,
        actorRole: 'DOCTOR',
        action: `CASE_OUTCOME_${payload.outcome}`,
        entityType: 'cases',
        entityId: caseId,
        afterData: {
          caseId,
          caseNumber: caseRow.case_number,
          outcome: payload.outcome,
          finalCaseStatus,
          reportId: completionReportResult?.reportId || null,
          nextAppointmentId:
            nextAppointmentResult?.appointment?.appointmentId || null,
        },
        req,
      });

      afterCommit(async () => {
        if (freedTicketPayload) {
          emitToRooms(
            [
              `dept:${departmentId}:beds`,
              'admin:dashboard',
              `user:${patientId}`,
              `case:${caseId}`,
            ],
            'bed.freed',
            {
              ...freedTicketPayload,
              caseStatus: finalCaseStatus,
            }
          );
        }

        emitToRooms(
          [`user:${patientId}`, `case:${caseId}`, 'admin:dashboard'],
          finalCaseStatus === 'FINISHED'
            ? 'case.finished'
            : 'case.outcome_recorded',
          {
            caseId,
            caseNumber: caseRow.case_number,
            status: finalCaseStatus,
            outcome: payload.outcome,
            completionReport: completionReportResult,
            nextAppointment: nextAppointmentResult,
          }
        );
      });

      return {
        case: {
          caseId,
          caseNumber: caseRow.case_number,
          status: finalCaseStatus,
          totalSessions: Math.max(1, Number(caseRow.total_sessions || 1)),
        },
        lastAppointment,
        nextAppointment: nextAppointmentResult,
        completionReport: completionReportResult,
      };
    },
    { resourceHint: 'CASE' }
  );
}

// =============================================================================
// 2. POST /api/v1/cases/:caseId/photos (§4.6)
// =============================================================================

/**
 * Uploads a clinical photo (`BEFORE`, `AFTER`, `DURING`, `XRAY`, `TRIAGE`) for a case.
 *
 * @param {number} caseId
 * @param {{ userId: number, role: string }} actor
 * @param {import('z').infer<typeof uploadCasePhotoSchema>} payload
 * @param {Express.Multer.File | undefined} uploadedFile
 * @param {import('express').Request} req
 */
export async function uploadCasePhoto(
  caseId,
  actor,
  payload,
  uploadedFile,
  req
) {
  let storedFileDiskInfo = null;

  if (uploadedFile) {
    storedFileDiskInfo = await validateAndStoreUploadedFile(
      uploadedFile,
      'CASE_PHOTO'
    );
  } else if (!payload.fileId) {
    throw new AppError(
      400,
      'CASE_PHOTO_FILE_REQUIRED',
      'Please upload a photo file (`file`) or provide a pre-uploaded `fileId`.'
    );
  }

  try {
    return await withTransaction(async (client) => {
      const caseRes = await client.query(
        `SELECT case_id, case_number, assigned_doctor_id, department_id
         FROM cases
         WHERE case_id = $1
         LIMIT 1`,
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
          'NOT_CASE_DOCTOR',
          'Only the assigned doctor, a supervisor, or an admin can upload photos for this case.'
        );
      }

      let fileId = payload.fileId ? Number(payload.fileId) : null;
      let storageKey = null;

      if (storedFileDiskInfo) {
        const fileRec = await insertFileRecord(client, {
          ownerUserId: actor.userId,
          purpose: 'CASE_PHOTO',
          storageKey: storedFileDiskInfo.storageKey,
          originalName: storedFileDiskInfo.originalName,
          mimeType: storedFileDiskInfo.mimeType,
          sizeBytes: storedFileDiskInfo.sizeBytes,
          sha256: storedFileDiskInfo.sha256,
          isPrivate: true,
        });
        fileId = Number(fileRec.file_id);
        storageKey = fileRec.storage_key;
      } else {
        const fRes = await client.query(
          `SELECT file_id, storage_key
           FROM files
           WHERE file_id = $1
           LIMIT 1`,
          [fileId]
        );
        if (fRes.rows.length === 0) {
          throw new AppError(404, 'FILE_NOT_FOUND', `File ${fileId} not found.`);
        }
        storageKey = fRes.rows[0].storage_key;
      }

      // Check if completion_report already exists for this case so we can auto-link report_id
      const repRes = await client.query(
        `SELECT report_id FROM completion_reports WHERE case_id = $1 LIMIT 1`,
        [caseId]
      );
      const reportId =
        repRes.rows.length > 0 ? Number(repRes.rows[0].report_id) : null;

      const photoRes = await client.query(
        `INSERT INTO case_photos (
           case_id,
           appointment_id,
           report_id,
           file_id,
           photo_type,
           caption,
           uploaded_by,
           taken_at
         )
         VALUES ($1, $2, $3, $4, $5::photo_type, $6, $7, COALESCE($8::TIMESTAMPTZ, now()))
         RETURNING
           photo_id,
           case_id,
           appointment_id,
           report_id,
           file_id,
           photo_type,
           caption,
           uploaded_by,
           taken_at,
           created_at`,
        [
          caseId,
          payload.appointmentId || null,
          reportId,
          fileId,
          payload.photoType,
          payload.caption || null,
          actor.userId,
          payload.takenAt || null,
        ]
      );

      const photoRow = photoRes.rows[0];

      await writeAuditLog(client, {
        actorUserId: actor.userId,
        actorRole: actor.role,
        action: 'CASE_PHOTO_UPLOADED',
        entityType: 'case_photos',
        entityId: Number(photoRow.photo_id),
        afterData: {
          photoId: Number(photoRow.photo_id),
          caseId,
          photoType: photoRow.photo_type,
          fileId,
        },
        req,
      });

      return {
        photoId: Number(photoRow.photo_id),
        caseId: Number(photoRow.case_id),
        appointmentId: photoRow.appointment_id
          ? Number(photoRow.appointment_id)
          : null,
        reportId: photoRow.report_id ? Number(photoRow.report_id) : null,
        fileId: Number(photoRow.file_id),
        photoType: photoRow.photo_type,
        caption: photoRow.caption,
        signedUrl: generateSignedFileUrl(storageKey),
        takenAt: photoRow.taken_at,
        createdAt: photoRow.created_at,
      };
    });
  } catch (err) {
    if (storedFileDiskInfo) {
      await deleteStoredFileQuietly(storedFileDiskInfo.storageKey);
    }
    throw err;
  }
}

// =============================================================================
// 3. POST /api/v1/doctor/posts (Publish Portfolio Post & Mention Completed Case)
// =============================================================================

/**
 * Publishes or saves a student/doctor portfolio post mentioning a `FINISHED` case (§4.6).
 * Enforces:
 * 1) `cases.assigned_doctor_id = doctorId` and `cases.status = 'FINISHED'`
 * 2) `patient_profiles.photo_consent`: if `TRUE` (and report review is `NOT_REQUIRED` or `APPROVED`),
 *    `is_published = TRUE, published_at = now()`; if `FALSE`, post remains private (`is_published = FALSE`).
 *
 * @param {number} doctorId
 * @param {import('z').infer<typeof createPortfolioPostSchema>} payload
 * @param {import('express').Request} req
 */
export async function publishDoctorPortfolioPost(doctorId, payload, req) {
  const { caseId, description, photoIds } = payload;

  return withTransaction(async (client) => {
    const caseRes = await client.query(
      `SELECT
         c.case_id,
         c.case_number,
         c.patient_id,
         c.assigned_doctor_id,
         c.status,
         pp.photo_consent,
         cr.report_id,
         cr.review_status
       FROM cases c
       JOIN patient_profiles pp ON pp.patient_id = c.patient_id
       LEFT JOIN completion_reports cr ON cr.case_id = c.case_id
       WHERE c.case_id = $1
       FOR UPDATE OF c`,
      [caseId]
    );

    if (caseRes.rows.length === 0) {
      throw new AppError(404, 'CASE_NOT_FOUND', `Case ${caseId} was not found.`);
    }

    const row = caseRes.rows[0];
    if (Number(row.assigned_doctor_id) !== Number(doctorId)) {
      throw new AppError(
        403,
        'NOT_CASE_DOCTOR',
        'You can only mention and publish portfolio posts for cases you personally treated and finished.'
      );
    }

    if (row.status !== 'FINISHED') {
      throw new AppError(
        422,
        'CASE_NOT_FINISHED',
        `Case ${row.case_number} must be in 'FINISHED' status before creating a portfolio post (current status: '${row.status}').`
      );
    }

    const hasPhotoConsent = Boolean(row.photo_consent);
    const reviewOk =
      !row.review_status ||
      ['NOT_REQUIRED', 'APPROVED'].includes(row.review_status);
    const isPublished = hasPhotoConsent && reviewOk;

    const postRes = await client.query(
      `INSERT INTO student_posts (
         doctor_id,
         case_id,
         description,
         is_published,
         published_at
       )
       VALUES ($1, $2, $3, $4, CASE WHEN $4 THEN now() ELSE NULL END)
       ON CONFLICT (case_id) DO UPDATE
         SET description = EXCLUDED.description,
             is_published = EXCLUDED.is_published,
             published_at = COALESCE(student_posts.published_at, EXCLUDED.published_at),
             updated_at = now()
       RETURNING
         post_id,
         doctor_id,
         case_id,
         description,
         is_published,
         published_at,
         created_at,
         updated_at`,
      [doctorId, caseId, description, isPublished]
    );

    const postRow = postRes.rows[0];
    const postId = Number(postRow.post_id);

    // Replace linked photos in student_post_photos
    await client.query(`DELETE FROM student_post_photos WHERE post_id = $1`, [
      postId,
    ]);

    const linkedPhotos = [];
    if (Array.isArray(photoIds) && photoIds.length > 0) {
      const validPhotosRes = await client.query(
        `SELECT cp.photo_id, cp.photo_type, cp.caption, f.storage_key
         FROM case_photos cp
         JOIN files f ON f.file_id = cp.file_id
         WHERE cp.case_id = $1
           AND cp.photo_id = ANY($2::BIGINT[])
         ORDER BY cp.photo_id ASC`,
        [caseId, photoIds]
      );

      let pos = 0;
      for (const pRow of validPhotosRes.rows) {
        await client.query(
          `INSERT INTO student_post_photos (post_id, photo_id, position)
           VALUES ($1, $2, $3)
           ON CONFLICT (post_id, photo_id) DO UPDATE SET position = EXCLUDED.position`,
          [postId, pRow.photo_id, pos]
        );
        linkedPhotos.push({
          photoId: Number(pRow.photo_id),
          photoType: pRow.photo_type,
          caption: pRow.caption,
          position: pos,
          signedUrl: generateSignedFileUrl(pRow.storage_key),
        });
        pos += 1;
      }
    }

    await writeAuditLog(client, {
      actorUserId: doctorId,
      actorRole: 'DOCTOR',
      action: 'DOCTOR_PORTFOLIO_POST_UPSERTED',
      entityType: 'student_posts',
      entityId: postId,
      afterData: {
        postId,
        caseId,
        caseNumber: row.case_number,
        isPublished,
        patientPhotoConsent: hasPhotoConsent,
        photoCount: linkedPhotos.length,
      },
      req,
    });

    return {
      postId,
      doctorId,
      caseId,
      caseNumber: row.case_number,
      description: postRow.description,
      isPublished: Boolean(postRow.is_published),
      publishedAt: postRow.published_at,
      patientPhotoConsent: hasPhotoConsent,
      visibilityNotice: hasPhotoConsent
        ? reviewOk
          ? 'Published publicly to your clinical portfolio.'
          : 'Saved; awaiting supervisor approval of completion report before public display.'
        : 'Patient declined public photo consent; this post is stored privately in clinical history only.',
      photos: linkedPhotos,
      createdAt: postRow.created_at,
      updatedAt: postRow.updated_at,
    };
  });
}

/**
 * Lists portfolio posts for a doctor (`GET /api/v1/doctor/posts`).
 *
 * @param {number} targetDoctorId
 * @param {{ userId: number, role: string }} viewer
 */
export async function listDoctorPortfolioPosts(targetDoctorId, viewer) {
  const isOwnerOrStaff =
    Number(viewer.userId) === Number(targetDoctorId) ||
    ['SUPERVISOR', 'ADMIN'].includes(viewer.role);

  const { rows } = await pool.query(
    `SELECT
       sp.post_id,
       sp.doctor_id,
       sp.case_id,
       c.case_number,
       d.name_en AS department_name_en,
       d.name_ar AS department_name_ar,
       s.name_en AS service_name_en,
       s.name_ar AS service_name_ar,
       sp.description,
       sp.is_published,
       sp.published_at,
       sp.created_at,
       pp.photo_consent
     FROM student_posts sp
     JOIN cases c ON c.case_id = sp.case_id
     LEFT JOIN departments d ON d.department_id = c.department_id
     LEFT JOIN services s ON s.service_id = c.service_id
     JOIN patient_profiles pp ON pp.patient_id = c.patient_id
     WHERE sp.doctor_id = $1
       AND ($2::BOOLEAN = TRUE OR sp.is_published = TRUE)
     ORDER BY sp.created_at DESC`,
    [targetDoctorId, isOwnerOrStaff]
  );

  const postIds = rows.map((r) => Number(r.post_id));
  const photosByPost = new Map();

  if (postIds.length > 0) {
    const photosRes = await pool.query(
      `SELECT
         spp.post_id,
         spp.position,
         cp.photo_id,
         cp.photo_type,
         cp.caption,
         f.storage_key
       FROM student_post_photos spp
       JOIN case_photos cp ON cp.photo_id = spp.photo_id
       JOIN files f ON f.file_id = cp.file_id
       WHERE spp.post_id = ANY($1::BIGINT[])
       ORDER BY spp.post_id ASC, spp.position ASC`,
      [postIds]
    );

    for (const p of photosRes.rows) {
      const pid = Number(p.post_id);
      if (!photosByPost.has(pid)) photosByPost.set(pid, []);
      photosByPost.get(pid).push({
        photoId: Number(p.photo_id),
        photoType: p.photo_type,
        caption: p.caption,
        position: Number(p.position),
        signedUrl: generateSignedFileUrl(p.storage_key),
      });
    }
  }

  return {
    doctorId: Number(targetDoctorId),
    posts: rows.map((r) => ({
      postId: Number(r.post_id),
      caseId: Number(r.case_id),
      caseNumber: r.case_number,
      departmentNameEn: r.department_name_en,
      departmentNameAr: r.department_name_ar,
      serviceNameEn: r.service_name_en,
      serviceNameAr: r.service_name_ar,
      description: r.description,
      isPublished: Boolean(r.is_published),
      publishedAt: r.published_at,
      patientPhotoConsent: Boolean(r.photo_consent),
      photos: photosByPost.get(Number(r.post_id)) || [],
      createdAt: r.created_at,
    })),
  };
}

// =============================================================================
// 4. POST /api/v1/cases/:caseId/rating (§4.6)
// =============================================================================

/**
 * Allows the patient who owns a `FINISHED` case to rate the treating doctor (`1..5`).
 *
 * @param {number} caseId
 * @param {number} patientId
 * @param {import('z').infer<typeof submitCaseRatingSchema>} payload
 * @param {import('express').Request} req
 */
export async function submitCaseRating(caseId, patientId, payload, req) {
  return withTransaction(async (client) => {
    const caseRes = await client.query(
      `SELECT
         c.case_id,
         c.case_number,
         c.patient_id,
         c.assigned_doctor_id,
         c.status
       FROM cases c
       WHERE c.case_id = $1
       FOR UPDATE`,
      [caseId]
    );

    if (caseRes.rows.length === 0) {
      throw new AppError(404, 'CASE_NOT_FOUND', `Case ${caseId} was not found.`);
    }

    const caseRow = caseRes.rows[0];
    if (Number(caseRow.patient_id) !== Number(patientId)) {
      throw new AppError(
        403,
        'NOT_CASE_PATIENT',
        'Only the patient who owns this case can submit a rating.'
      );
    }

    if (caseRow.status !== 'FINISHED') {
      throw new AppError(
        422,
        'CASE_NOT_FINISHED',
        `You can only rate a case after it is marked 'FINISHED' (current status: '${caseRow.status}').`
      );
    }

    const existingRes = await client.query(
      `SELECT rating_id FROM ratings WHERE case_id = $1 LIMIT 1`,
      [caseId]
    );
    if (existingRes.rows.length > 0) {
      throw new AppError(
        409,
        'CASE_ALREADY_RATED',
        'You have already submitted a rating for this case.'
      );
    }

    const doctorId = Number(caseRow.assigned_doctor_id);

    const ratingRes = await client.query(
      `INSERT INTO ratings (
         case_id,
         patient_id,
         doctor_id,
         score,
         communication_score,
         punctuality_score,
         comment
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING
         rating_id,
         case_id,
         patient_id,
         doctor_id,
         score,
         communication_score,
         punctuality_score,
         comment,
         created_at`,
      [
        caseId,
        patientId,
        doctorId,
        payload.score,
        payload.communicationScore || null,
        payload.punctualityScore || null,
        payload.comment || null,
      ]
    );

    const rRow = ratingRes.rows[0];

    await createNotification(client, {
      userId: doctorId,
      type: 'CASE_RATED',
      title: 'New Patient Rating Received',
      body: `Your completed case (${caseRow.case_number}) received a ${payload.score}/5 star rating.`,
      caseId,
      data: {
        caseId,
        caseNumber: caseRow.case_number,
        ratingId: Number(rRow.rating_id),
        score: Number(rRow.score),
      },
    });

    await writeAuditLog(client, {
      actorUserId: patientId,
      actorRole: 'PATIENT',
      action: 'CASE_RATED',
      entityType: 'ratings',
      entityId: Number(rRow.rating_id),
      afterData: {
        ratingId: Number(rRow.rating_id),
        caseId,
        doctorId,
        score: Number(rRow.score),
      },
      req,
    });

    return {
      ratingId: Number(rRow.rating_id),
      caseId: Number(rRow.case_id),
      caseNumber: caseRow.case_number,
      patientId: Number(rRow.patient_id),
      doctorId: Number(rRow.doctor_id),
      score: Number(rRow.score),
      communicationScore: rRow.communication_score
        ? Number(rRow.communication_score)
        : null,
      punctualityScore: rRow.punctuality_score
        ? Number(rRow.punctuality_score)
        : null,
      comment: rRow.comment,
      createdAt: rRow.created_at,
    };
  });
}

// =============================================================================
// 5. GET /api/v1/patients/me/cases & GET /api/v1/doctor/me/cases (§4.6)
// =============================================================================

/**
 * Shared enrichment helper that loads appointments, bed tickets, completion reports,
 * photos (with signed URLs), ratings, and portfolio posts for a list of cases.
 *
 * @param {any[]} caseRows
 * @param {'PATIENT' | 'DOCTOR'} actorRole
 * @param {string} lang
 */
async function enrichCasesHistoryList(caseRows, actorRole, lang = 'ar') {
  const isAr = lang === 'ar';
  if (caseRows.length === 0) return [];

  const caseIds = caseRows.map((c) => Number(c.case_id));

  // 1) Sessions / Appointments + Bed Tickets
  const apptsRes = await pool.query(
    `SELECT
       a.appointment_id,
       a.case_id,
       a.session_no,
       a.path,
       a.appointment_date::TEXT AS appointment_date,
       a.period_id,
       btp.code AS period_code,
       btp.name_en AS period_name_en,
       btp.name_ar AS period_name_ar,
       a.planned_start_at,
       a.status,
       a.checked_in_at,
       a.started_at,
       a.ended_at,
       a.outcome,
       a.procedure_performed,
       a.session_notes,
       a.next_steps,
       bt.ticket_id,
       bt.ticket_code,
       bt.ticket_type,
       bt.status AS ticket_status,
       bt.bed_id,
       cb.label AS bed_label,
       cl.clinic_number,
       bt.occupied_at,
       bt.freed_at,
       bt.swapped_from_bed_id
     FROM appointments a
     LEFT JOIN bed_ticket_periods btp ON btp.period_id = a.period_id
     LEFT JOIN bed_tickets bt ON bt.appointment_id = a.appointment_id
     LEFT JOIN clinic_beds cb ON cb.bed_id = bt.bed_id
     LEFT JOIN clinics cl ON cl.clinic_id = cb.clinic_id
     WHERE a.case_id = ANY($1::BIGINT[])
     ORDER BY a.case_id ASC, a.session_no ASC, a.appointment_id ASC`,
    [caseIds]
  );

  const sessionsByCase = new Map();
  for (const a of apptsRes.rows) {
    const cid = Number(a.case_id);
    if (!sessionsByCase.has(cid)) sessionsByCase.set(cid, []);
    sessionsByCase.get(cid).push({
      appointmentId: Number(a.appointment_id),
      sessionNo: Number(a.session_no),
      path: a.path,
      appointmentDate: a.appointment_date,
      periodId: a.period_id ? Number(a.period_id) : null,
      periodCode: a.period_code,
      periodName: a.period_code
        ? isAr
          ? a.period_name_ar
          : a.period_name_en
        : null,
      plannedStartAt: a.planned_start_at,
      status: a.status,
      checkedInAt: a.checked_in_at,
      startedAt: a.started_at,
      endedAt: a.ended_at,
      outcome: a.outcome,
      procedurePerformed: a.procedure_performed,
      sessionNotes: a.session_notes,
      nextSteps: a.next_steps,
      ticket: a.ticket_id
        ? {
            ticketId: Number(a.ticket_id),
            ticketCode: a.ticket_code,
            ticketType: a.ticket_type,
            status: a.ticket_status,
            bedId: Number(a.bed_id),
            bedLabel: a.bed_label,
            clinicNumber: a.clinic_number,
            occupiedAt: a.occupied_at,
            freedAt: a.freed_at,
            swappedFromBedId: a.swapped_from_bed_id
              ? Number(a.swapped_from_bed_id)
              : null,
          }
        : null,
    });
  }

  // 2) Completion Reports
  const reportsRes = await pool.query(
    `SELECT
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
       review_notes,
       reviewed_at,
       created_at
     FROM completion_reports
     WHERE case_id = ANY($1::BIGINT[])`,
    [caseIds]
  );
  const reportByCase = new Map();
  for (const r of reportsRes.rows) {
    reportByCase.set(Number(r.case_id), {
      reportId: Number(r.report_id),
      finalDiagnosis: r.final_diagnosis,
      procedureSummary: r.procedure_summary,
      materialsUsed: r.materials_used,
      result: r.result,
      totalSessions: Number(r.total_sessions),
      postCareInstructions: r.post_care_instructions,
      reviewStatus: r.review_status,
      reviewNotes: r.review_notes,
      reviewedAt: r.reviewed_at,
      createdAt: r.created_at,
    });
  }

  // 3) Case Photos (with signed URLs)
  const photosRes = await pool.query(
    `SELECT
       cp.photo_id,
       cp.case_id,
       cp.appointment_id,
       cp.photo_type,
       cp.caption,
       cp.taken_at,
       cp.created_at,
       f.file_id,
       f.storage_key
     FROM case_photos cp
     JOIN files f ON f.file_id = cp.file_id
     WHERE cp.case_id = ANY($1::BIGINT[])
     ORDER BY cp.created_at ASC`,
    [caseIds]
  );
  const photosByCase = new Map();
  for (const p of photosRes.rows) {
    const cid = Number(p.case_id);
    if (!photosByCase.has(cid)) photosByCase.set(cid, []);
    photosByCase.get(cid).push({
      photoId: Number(p.photo_id),
      appointmentId: p.appointment_id ? Number(p.appointment_id) : null,
      fileId: Number(p.file_id),
      photoType: p.photo_type,
      caption: p.caption,
      signedUrl: generateSignedFileUrl(p.storage_key),
      takenAt: p.taken_at,
      createdAt: p.created_at,
    });
  }

  // 4) Ratings
  const ratingsRes = await pool.query(
    `SELECT
       rating_id,
       case_id,
       score,
       communication_score,
       punctuality_score,
       comment,
       created_at
     FROM ratings
     WHERE case_id = ANY($1::BIGINT[])`,
    [caseIds]
  );
  const ratingByCase = new Map();
  for (const rt of ratingsRes.rows) {
    ratingByCase.set(Number(rt.case_id), {
      ratingId: Number(rt.rating_id),
      score: Number(rt.score),
      communicationScore: rt.communication_score
        ? Number(rt.communication_score)
        : null,
      punctualityScore: rt.punctuality_score
        ? Number(rt.punctuality_score)
        : null,
      comment: rt.comment,
      createdAt: rt.created_at,
    });
  }

  return caseRows.map((c) => {
    const cid = Number(c.case_id);
    return {
      caseId: cid,
      caseNumber: c.case_number,
      status: c.status,
      priority: c.priority,
      toothNumbers: c.tooth_numbers || [],
      toothType: c.tooth_type,
      procedureDetails: c.procedure_details,
      triageNotes: c.triage_notes,
      totalSessions: Number(c.total_sessions || 0),
      department: c.department_id
        ? {
            departmentId: Number(c.department_id),
            code: c.department_code,
            name: isAr ? c.department_name_ar : c.department_name_en,
          }
        : null,
      service: c.service_id
        ? {
            serviceId: Number(c.service_id),
            code: c.service_code,
            name: isAr ? c.service_name_ar : c.service_name_en,
          }
        : null,
      doctor: c.assigned_doctor_id
        ? {
            doctorId: Number(c.assigned_doctor_id),
            fullName: c.doctor_full_name,
            phone: c.doctor_phone,
            doctorCategory: c.doctor_category,
            academicYear: c.academic_year ? Number(c.academic_year) : null,
            university: c.university_name,
          }
        : null,
      patient:
        actorRole === 'DOCTOR'
          ? {
              patientId: Number(c.patient_id),
              fullName: c.patient_full_name,
              phone: c.patient_phone,
              gender: c.patient_gender,
              dateOfBirth: c.patient_dob,
              hasCriticalCondition: Boolean(c.has_critical_condition),
              medicalDocumentStatus: c.medical_document_status,
            }
          : undefined,
      conversationId: c.conversation_id ? Number(c.conversation_id) : null,
      broadcastedAt: c.broadcasted_at,
      claimedAt: c.claimed_at,
      finishedAt: c.finished_at,
      createdAt: c.created_at,
      sessions: sessionsByCase.get(cid) || [],
      completionReport: reportByCase.get(cid) || null,
      photos: photosByCase.get(cid) || [],
      rating: ratingByCase.get(cid) || null,
    };
  });
}

/**
 * GET /api/v1/patients/me/cases
 * Returns the authenticated patient's active and historical cases (§4.6).
 *
 * @param {number} patientId
 * @param {{ status?: 'ALL' | 'ACTIVE' | 'FINISHED' | 'CANCELLED' }} query
 * @param {string} lang
 */
export async function getPatientCaseHistory(patientId, query = {}, lang = 'ar') {
  const statusFilter = query.status || 'ALL';

  const { rows } = await pool.query(
    `SELECT
       c.case_id,
       c.case_number,
       c.patient_id,
       c.department_id,
       d.code AS department_code,
       d.name_en AS department_name_en,
       d.name_ar AS department_name_ar,
       c.service_id,
       s.code AS service_code,
       s.name_en AS service_name_en,
       s.name_ar AS service_name_ar,
       c.tooth_numbers,
       c.tooth_type,
       c.procedure_details,
       c.triage_notes,
       c.priority,
       c.status,
       c.total_sessions,
       c.assigned_doctor_id,
       du.full_name AS doctor_full_name,
       du.phone AS doctor_phone,
       sdp.doctor_category,
       sdp.academic_year,
       sdp.university AS university_name,
       cc.conversation_id,
       c.broadcasted_at,
       c.claimed_at,
       c.finished_at,
       c.created_at
     FROM cases c
     LEFT JOIN departments d ON d.department_id = c.department_id
     LEFT JOIN services s ON s.service_id = c.service_id
     LEFT JOIN users du ON du.user_id = c.assigned_doctor_id
     LEFT JOIN student_doctor_profiles sdp ON sdp.doctor_id = c.assigned_doctor_id
     LEFT JOIN LATERAL (
       SELECT conversation_id
       FROM chat_conversations
       WHERE case_id = c.case_id
       ORDER BY opened_at DESC
       LIMIT 1
     ) cc ON TRUE
     WHERE c.patient_id = $1
       AND (
         $2 = 'ALL'
         OR ($2 = 'FINISHED' AND c.status = 'FINISHED')
         OR ($2 = 'CANCELLED' AND c.status IN ('CANCELLED', 'EXAM_NO_SHOW', 'TRIAGE_CLOSED'))
         OR ($2 = 'ACTIVE' AND c.status NOT IN ('FINISHED', 'CANCELLED', 'EXAM_NO_SHOW', 'TRIAGE_CLOSED'))
       )
     ORDER BY c.created_at DESC`,
    [patientId, statusFilter]
  );

  const cases = await enrichCasesHistoryList(rows, 'PATIENT', lang);
  return {
    patientId: Number(patientId),
    filter: statusFilter,
    totalCount: cases.length,
    cases,
  };
}

/**
 * GET /api/v1/doctor/me/cases
 * Returns the authenticated doctor's active and completed cases (§4.6).
 *
 * @param {number} doctorId
 * @param {{ status?: 'ALL' | 'ACTIVE' | 'FINISHED' | 'CANCELLED' }} query
 * @param {string} lang
 */
export async function getDoctorCaseHistory(doctorId, query = {}, lang = 'ar') {
  const statusFilter = query.status || 'ALL';

  const { rows } = await pool.query(
    `SELECT
       c.case_id,
       c.case_number,
       c.patient_id,
       pu.full_name AS patient_full_name,
       pu.phone AS patient_phone,
       pp.gender AS patient_gender,
       pp.date_of_birth::TEXT AS patient_dob,
       pp.has_critical_condition,
       pp.medical_document_status,
       c.department_id,
       d.code AS department_code,
       d.name_en AS department_name_en,
       d.name_ar AS department_name_ar,
       c.service_id,
       s.code AS service_code,
       s.name_en AS service_name_en,
       s.name_ar AS service_name_ar,
       c.tooth_numbers,
       c.tooth_type,
       c.procedure_details,
       c.triage_notes,
       c.priority,
       c.status,
       c.total_sessions,
       c.assigned_doctor_id,
       du.full_name AS doctor_full_name,
       du.phone AS doctor_phone,
       sdp.doctor_category,
       sdp.academic_year,
       sdp.university AS university_name,
       cc.conversation_id,
       c.broadcasted_at,
       c.claimed_at,
       c.finished_at,
       c.created_at
     FROM cases c
     JOIN users pu ON pu.user_id = c.patient_id
     JOIN patient_profiles pp ON pp.patient_id = c.patient_id
     LEFT JOIN departments d ON d.department_id = c.department_id
     LEFT JOIN services s ON s.service_id = c.service_id
     LEFT JOIN users du ON du.user_id = c.assigned_doctor_id
     LEFT JOIN student_doctor_profiles sdp ON sdp.doctor_id = c.assigned_doctor_id
     LEFT JOIN LATERAL (
       SELECT conversation_id
       FROM chat_conversations
       WHERE case_id = c.case_id AND doctor_id = $1
       ORDER BY opened_at DESC
       LIMIT 1
     ) cc ON TRUE
     WHERE c.assigned_doctor_id = $1
       AND (
         $2 = 'ALL'
         OR ($2 = 'FINISHED' AND c.status = 'FINISHED')
         OR ($2 = 'CANCELLED' AND c.status = 'CANCELLED')
         OR ($2 = 'ACTIVE' AND c.status IN ('CLAIMED', 'SCHEDULED', 'IN_TREATMENT', 'AWAITING_OUTCOME', 'NEEDS_FOLLOW_UP'))
       )
     ORDER BY c.claimed_at DESC NULLS LAST, c.created_at DESC`,
    [doctorId, statusFilter]
  );

  const cases = await enrichCasesHistoryList(rows, 'DOCTOR', lang);
  return {
    doctorId: Number(doctorId),
    filter: statusFilter,
    totalCount: cases.length,
    cases,
  };
}

/**
 * Supervisor / Admin review of a completion report (`POST /api/v1/cases/:caseId/report/review`).
 *
 * @param {number} caseId
 * @param {{ userId: number, role: string }} actor
 * @param {import('z').infer<typeof reviewCompletionReportSchema>} payload
 * @param {import('express').Request} req
 */
export async function reviewCaseCompletionReport(
  caseId,
  actor,
  payload,
  req
) {
  return withTransaction(async (client) => {
    const repRes = await client.query(
      `SELECT report_id, case_id, doctor_id, review_status
       FROM completion_reports
       WHERE case_id = $1
       FOR UPDATE`,
      [caseId]
    );

    if (repRes.rows.length === 0) {
      throw new AppError(
        404,
        'COMPLETION_REPORT_NOT_FOUND',
        `No completion report found for case ${caseId}.`
      );
    }

    const rep = repRes.rows[0];
    const supervisorId =
      actor.role === 'SUPERVISOR' ? Number(actor.userId) : null;

    const updRes = await client.query(
      `UPDATE completion_reports
       SET review_status = $2::review_status,
           reviewer_supervisor_id = COALESCE($3, reviewer_supervisor_id),
           review_notes = $4,
           reviewed_at = now(),
           updated_at = now()
       WHERE report_id = $1
       RETURNING
         report_id,
         case_id,
         doctor_id,
         review_status,
         reviewer_supervisor_id,
         review_notes,
         reviewed_at`,
      [
        rep.report_id,
        payload.reviewStatus,
        supervisorId,
        payload.reviewNotes || null,
      ]
    );

    await writeAuditLog(client, {
      actorUserId: actor.userId,
      actorRole: actor.role,
      action: `COMPLETION_REPORT_${payload.reviewStatus}`,
      entityType: 'completion_reports',
      entityId: Number(rep.report_id),
      afterData: updRes.rows[0],
      req,
    });

    return {
      reportId: Number(updRes.rows[0].report_id),
      caseId: Number(updRes.rows[0].case_id),
      doctorId: Number(updRes.rows[0].doctor_id),
      reviewStatus: updRes.rows[0].review_status,
      reviewerSupervisorId: updRes.rows[0].reviewer_supervisor_id
        ? Number(updRes.rows[0].reviewer_supervisor_id)
        : null,
      reviewNotes: updRes.rows[0].review_notes,
      reviewedAt: updRes.rows[0].reviewed_at,
    };
  });
}
