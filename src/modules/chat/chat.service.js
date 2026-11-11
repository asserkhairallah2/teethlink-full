import { z } from 'zod';
import { pool, withTransaction } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';
import {
  createNotification,
  normalizeUuidOrNull,
  writeAuditLog,
} from '../../utils/audit.js';
import {
  emitToRooms,
  isUserPresentInRoom,
} from '../../realtime/socketGateway.js';
import {
  deleteStoredFileQuietly,
  generateSignedFileUrl,
  insertFileRecord,
  validateAndStoreUploadedFile,
} from '../files/files.service.js';

export const listMessagesQuerySchema = z.object({
  beforeMessageId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional().default(30),
});

export const sendChatMessageSchema = z.object({
  clientMessageId: z.string().trim().max(64).optional(),
  messageType: z.enum(['TEXT', 'IMAGE', 'FILE']).optional(),
  body: z.string().trim().max(4000).nullable().optional(),
  attachmentFileId: z.coerce.number().int().positive().nullable().optional(),
});

export const markReadSchema = z.object({
  lastReadMessageId: z.coerce.number().int().positive().optional(),
});

export const initiateCallSchema = z.object({
  callType: z.enum(['PHONE_DIAL', 'VOIP']).optional().default('PHONE_DIAL'),
});

/**
 * Formats a joined conversation row into the standardized §4.7 response shape,
 * exposing counterparty profile and phone number when the conversation is `OPEN` (or `READ_ONLY`).
 *
 * @param {Record<string, any>} row
 * @param {{ userId: number, role: string }} viewer
 * @param {'ar' | 'en'} [lang='ar']
 */
function formatConversationRecord(row, viewer, lang = 'ar') {
  const isAr = lang === 'ar';
  const viewerId = Number(viewer.userId);
  const isViewerPatient = viewerId === Number(row.patient_id);

  const canExposePhone = ['OPEN', 'READ_ONLY'].includes(row.status) || viewer.role === 'ADMIN';
  const canCall = row.status === 'OPEN';

  let counterparty;
  if (isViewerPatient) {
    counterparty = {
      userId: Number(row.doctor_id),
      role: 'DOCTOR',
      fullName: row.doctor_full_name,
      phone: canExposePhone ? row.doctor_phone : null,
      doctorCategory: row.doctor_category,
      academicYear:
        row.doctor_academic_year !== null ? Number(row.doctor_academic_year) : null,
      university: row.doctor_university || null,
      college: row.doctor_college || null,
      departmentId: row.department_id ? Number(row.department_id) : null,
      departmentName: row.department_id
        ? isAr
          ? row.department_name_ar
          : row.department_name_en
        : null,
      canCall,
    };
  } else {
    counterparty = {
      userId: Number(row.patient_id),
      role: 'PATIENT',
      fullName: row.patient_full_name,
      phone: canExposePhone ? row.patient_phone : null,
      age: row.patient_age !== null ? Number(row.patient_age) : null,
      gender: row.patient_gender || null,
      canCall,
    };
  }

  return {
    conversationId: Number(row.conversation_id),
    caseId: Number(row.case_id),
    caseNumber: row.case_number,
    caseStatus: row.case_status,
    status: row.status,
    openedAt: row.opened_at,
    readOnlyAt: row.read_only_at || null,
    closedAt: row.closed_at || null,
    lastMessageAt: row.last_message_at || null,
    lastMessage: row.last_message_id
      ? {
          messageId: Number(row.last_message_id),
          senderId: row.last_msg_sender_id ? Number(row.last_msg_sender_id) : null,
          messageType: row.last_msg_type,
          body: row.last_msg_body || null,
          createdAt: row.last_msg_created_at,
        }
      : null,
    counterparty,
    unreadCount: Number(row.unread_count || 0),
  };
}

/**
 * Shared SQL SELECT fragment for loading conversations with counterparty details and unread count.
 */
const CONVERSATION_DETAILS_SELECT = `
  SELECT
    cc.conversation_id,
    cc.case_id,
    c.case_number,
    c.status AS case_status,
    c.department_id,
    d.name_en AS department_name_en,
    d.name_ar AS department_name_ar,
    cc.patient_id,
    pu.full_name AS patient_full_name,
    pu.phone AS patient_phone,
    CASE
      WHEN pp.date_of_birth IS NOT NULL
      THEN EXTRACT(YEAR FROM age(CURRENT_DATE, pp.date_of_birth))::INT
      ELSE NULL
    END AS patient_age,
    pp.gender AS patient_gender,
    cc.doctor_id,
    du.full_name AS doctor_full_name,
    du.phone AS doctor_phone,
    sdp.doctor_category,
    sdp.academic_year AS doctor_academic_year,
    sdp.university AS doctor_university,
    sdp.college AS doctor_college,
    cc.status,
    cc.opened_at,
    cc.read_only_at,
    cc.closed_at,
    cc.last_message_id,
    cc.last_message_at,
    cc.patient_last_read_message_id,
    cc.doctor_last_read_message_id,
    lm.sender_id AS last_msg_sender_id,
    lm.message_type AS last_msg_type,
    lm.body AS last_msg_body,
    lm.created_at AS last_msg_created_at,
    (
      SELECT COUNT(*)::INT
      FROM chat_messages cm
      WHERE cm.conversation_id = cc.conversation_id
        AND cm.deleted_at IS NULL
        AND cm.message_id > CASE
          WHEN $1 = cc.patient_id THEN cc.patient_last_read_message_id
          WHEN $1 = cc.doctor_id  THEN cc.doctor_last_read_message_id
          ELSE COALESCE(cc.last_message_id, 0)
        END
        AND (cm.sender_id IS NULL OR cm.sender_id <> $1)
    ) AS unread_count
  FROM chat_conversations cc
  JOIN cases c ON c.case_id = cc.case_id
  LEFT JOIN departments d ON d.department_id = c.department_id
  JOIN users pu ON pu.user_id = cc.patient_id
  JOIN patient_profiles pp ON pp.patient_id = cc.patient_id
  JOIN users du ON du.user_id = cc.doctor_id
  JOIN student_doctor_profiles sdp ON sdp.doctor_id = cc.doctor_id
  LEFT JOIN chat_messages lm ON lm.message_id = cc.last_message_id
`;

/**
 * GET /api/v1/conversations
 * Lists all conversations for the authenticated patient or doctor (§4.7).
 *
 * @param {{ userId: number, role: string }} viewer
 * @param {'ar' | 'en'} [lang='ar']
 */
export async function listMyConversations(viewer, lang = 'ar') {
  let whereClause;
  const params = [Number(viewer.userId)];

  if (viewer.role === 'PATIENT') {
    whereClause = `WHERE cc.patient_id = $1`;
  } else if (viewer.role === 'DOCTOR') {
    whereClause = `WHERE cc.doctor_id = $1`;
  } else {
    whereClause = `WHERE TRUE`;
  }

  const { rows } = await pool.query(
    `${CONVERSATION_DETAILS_SELECT}
     ${whereClause}
     ORDER BY COALESCE(cc.last_message_at, cc.opened_at) DESC, cc.conversation_id DESC`,
    params
  );

  return {
    conversations: rows.map((row) => formatConversationRecord(row, viewer, lang)),
  };
}

/**
 * GET /api/v1/cases/:caseId/conversation
 * Retrieves the conversation for a specific case, exposing the counterparty's `phone`
 * and profile while the conversation is `OPEN` (or `READ_ONLY`) (§4.7).
 *
 * @param {number} caseId
 * @param {{ userId: number, role: string }} viewer
 * @param {'ar' | 'en'} [lang='ar']
 */
export async function getConversationByCaseId(caseId, viewer, lang = 'ar') {
  const { rows } = await pool.query(
    `${CONVERSATION_DETAILS_SELECT}
     WHERE cc.case_id = $2
     ORDER BY
       CASE cc.status WHEN 'OPEN' THEN 0 WHEN 'READ_ONLY' THEN 1 ELSE 2 END ASC,
       cc.conversation_id DESC
     LIMIT 1`,
    [Number(viewer.userId), Number(caseId)]
  );

  if (rows.length === 0) {
    throw new AppError(
      404,
      'CONVERSATION_NOT_FOUND',
      `No chat conversation exists for case ${caseId}.`
    );
  }

  const row = rows[0];
  const viewerId = Number(viewer.userId);

  if (
    viewerId !== Number(row.patient_id) &&
    viewerId !== Number(row.doctor_id) &&
    !['ADMIN', 'SUPERVISOR'].includes(viewer.role)
  ) {
    throw new AppError(
      403,
      'NOT_CONVERSATION_PARTICIPANT',
      'You are not a participant in this conversation.'
    );
  }

  return formatConversationRecord(row, viewer, lang);
}

/**
 * GET /api/v1/conversations/:conversationId/messages
 * Returns cursor-paginated chat messages ordered newest-first (§4.7).
 *
 * @param {number} conversationId
 * @param {{ userId: number, role: string }} viewer
 * @param {import('z').infer<typeof listMessagesQuerySchema>} queryParams
 */
export async function listConversationMessages(conversationId, viewer, queryParams) {
  const convRes = await pool.query(
    `SELECT conversation_id, case_id, patient_id, doctor_id, status
     FROM chat_conversations
     WHERE conversation_id = $1
     LIMIT 1`,
    [conversationId]
  );

  if (convRes.rows.length === 0) {
    throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation was not found.');
  }

  const conv = convRes.rows[0];
  const viewerId = Number(viewer.userId);

  if (
    viewerId !== Number(conv.patient_id) &&
    viewerId !== Number(conv.doctor_id) &&
    !['ADMIN', 'SUPERVISOR'].includes(viewer.role)
  ) {
    throw new AppError(
      403,
      'NOT_CONVERSATION_PARTICIPANT',
      'You are not a participant in this conversation.'
    );
  }

  const limit = Number(queryParams.limit || 30);
  const params = [conversationId];
  let beforeClause = '';

  if (queryParams.beforeMessageId) {
    params.push(Number(queryParams.beforeMessageId));
    beforeClause = `AND cm.message_id < $2`;
  }

  params.push(limit + 1);
  const limitParamIdx = params.length;

  const { rows } = await pool.query(
    `SELECT
       cm.message_id,
       cm.conversation_id,
       cm.sender_id,
       u.full_name AS sender_name,
       u.role AS sender_role,
       cm.message_type,
       cm.body,
       cm.attachment_file_id,
       f.storage_key AS attachment_storage_key,
       f.original_name AS attachment_original_name,
       f.mime_type AS attachment_mime_type,
       f.size_bytes AS attachment_size_bytes,
       cm.client_message_id,
       cm.metadata,
       cm.created_at
     FROM chat_messages cm
     LEFT JOIN users u ON u.user_id = cm.sender_id
     LEFT JOIN files f ON f.file_id = cm.attachment_file_id
     WHERE cm.conversation_id = $1
       AND cm.deleted_at IS NULL
       ${beforeClause}
     ORDER BY cm.message_id DESC
     LIMIT $${limitParamIdx}`,
    params
  );

  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;

  const messages = pageRows.map((m) => ({
    messageId: Number(m.message_id),
    conversationId: Number(m.conversation_id),
    senderId: m.sender_id ? Number(m.sender_id) : null,
    senderName: m.sender_name || 'System',
    senderRole: m.sender_role || 'SYSTEM',
    messageType: m.message_type,
    body: m.body || null,
    attachmentFileId: m.attachment_file_id ? Number(m.attachment_file_id) : null,
    attachmentUrl: m.attachment_storage_key
      ? generateSignedFileUrl(m.attachment_storage_key)
      : null,
    attachmentMeta: m.attachment_file_id
      ? {
          fileId: Number(m.attachment_file_id),
          originalName: m.attachment_original_name,
          mimeType: m.attachment_mime_type,
          sizeBytes: Number(m.attachment_size_bytes),
        }
      : null,
    clientMessageId: m.client_message_id || null,
    metadata: m.metadata || {},
    createdAt: m.created_at,
  }));

  const nextBeforeMessageId =
    hasMore && messages.length > 0 ? messages[messages.length - 1].messageId : null;

  return {
    conversationId: Number(conv.conversation_id),
    caseId: Number(conv.case_id),
    status: conv.status,
    messages,
    nextBeforeMessageId,
  };
}

/**
 * POST /api/v1/conversations/:conversationId/messages
 * Sends a text or image/file message in an `OPEN` conversation, enforces idempotent deduplication
 * on `(conversation_id, sender_id, client_message_id)`, updates `last_message_id`/`last_message_at`,
 * and emits `chat.message_created` via `afterCommit()` to `conv:{conversationId}` and `user:{recipientId}` (§4.7).
 *
 * @param {number} conversationId
 * @param {{ userId: number, role: string, fullName: string }} sender
 * @param {import('z').infer<typeof sendChatMessageSchema>} payload
 * @param {Express.Multer.File | undefined} uploadedFile
 * @param {import('express').Request} req
 */
export async function sendConversationMessage(
  conversationId,
  sender,
  payload,
  uploadedFile,
  req
) {
  let storedFile = null;
  if (uploadedFile) {
    storedFile = await validateAndStoreUploadedFile(uploadedFile, 'CHAT_ATTACHMENT');
  }

  const clientMessageUuid = normalizeUuidOrNull(payload.clientMessageId);

  try {
    return await withTransaction(async (client, afterCommit) => {
      const convRes = await client.query(
        `SELECT
           cc.conversation_id,
           cc.case_id,
           c.case_number,
           cc.patient_id,
           cc.doctor_id,
           cc.status
         FROM chat_conversations cc
         JOIN cases c ON c.case_id = cc.case_id
         WHERE cc.conversation_id = $1
         FOR UPDATE OF cc`,
        [conversationId]
      );

      if (convRes.rows.length === 0) {
        throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation was not found.');
      }

      const conv = convRes.rows[0];
      const senderId = Number(sender.userId);
      const patientId = Number(conv.patient_id);
      const doctorId = Number(conv.doctor_id);

      if (senderId !== patientId && senderId !== doctorId) {
        throw new AppError(
          403,
          'NOT_CONVERSATION_PARTICIPANT',
          'Only the patient and assigned doctor of this conversation can send messages.'
        );
      }

      if (conv.status !== 'OPEN') {
        throw new AppError(
          422,
          'CONVERSATION_NOT_OPEN',
          `Cannot send messages in a conversation with status '${conv.status}'.`
        );
      }

      // Check idempotent retry on (conversation_id, sender_id, client_message_id)
      if (clientMessageUuid) {
        const existingRes = await client.query(
          `SELECT
             cm.message_id,
             cm.conversation_id,
             cm.sender_id,
             cm.message_type,
             cm.body,
             cm.attachment_file_id,
             f.storage_key AS attachment_storage_key,
             cm.client_message_id,
             cm.created_at
           FROM chat_messages cm
           LEFT JOIN files f ON f.file_id = cm.attachment_file_id
           WHERE cm.conversation_id = $1
             AND cm.sender_id = $2
             AND cm.client_message_id = $3
           LIMIT 1`,
          [conversationId, senderId, clientMessageUuid]
        );

        if (existingRes.rows.length > 0) {
          const ex = existingRes.rows[0];
          return {
            messageId: Number(ex.message_id),
            conversationId: Number(ex.conversation_id),
            senderId: Number(ex.sender_id),
            senderName: sender.fullName,
            senderRole: sender.role,
            messageType: ex.message_type,
            body: ex.body || null,
            attachmentFileId: ex.attachment_file_id ? Number(ex.attachment_file_id) : null,
            attachmentUrl: ex.attachment_storage_key
              ? generateSignedFileUrl(ex.attachment_storage_key)
              : null,
            clientMessageId: ex.client_message_id,
            createdAt: ex.created_at,
          };
        }
      }

      let attachmentFileRow = null;
      if (storedFile) {
        attachmentFileRow = await insertFileRecord(client, {
          ownerUserId: senderId,
          purpose: 'CHAT_ATTACHMENT',
          storageKey: storedFile.storageKey,
          originalName: storedFile.originalName,
          mimeType: storedFile.mimeType,
          sizeBytes: storedFile.sizeBytes,
          sha256: storedFile.sha256,
          isPrivate: true,
        });
      } else if (payload.attachmentFileId) {
        const fileLookup = await client.query(
          `SELECT file_id, owner_user_id, mime_type, storage_key, original_name, size_bytes
           FROM files
           WHERE file_id = $1
             AND owner_user_id = $2
           LIMIT 1`,
          [Number(payload.attachmentFileId), senderId]
        );
        if (fileLookup.rows.length === 0) {
          throw new AppError(422, 'INVALID_ATTACHMENT_FILE_ID', 'Specified attachmentFileId does not exist.');
        }
        attachmentFileRow = fileLookup.rows[0];
      }

      let messageType = payload.messageType;
      if (!messageType) {
        if (attachmentFileRow) {
          messageType = String(attachmentFileRow.mime_type).startsWith('image/')
            ? 'IMAGE'
            : 'FILE';
        } else {
          messageType = 'TEXT';
        }
      }

      if (messageType === 'TEXT' && (!payload.body || payload.body.trim().length === 0)) {
        throw new AppError(
          400,
          'MESSAGE_BODY_REQUIRED',
          'Message body is required when messageType is TEXT.'
        );
      }

      if (['IMAGE', 'FILE'].includes(messageType) && !attachmentFileRow) {
        throw new AppError(
          400,
          'ATTACHMENT_REQUIRED',
          `An uploaded file or attachmentFileId is required when messageType is ${messageType}.`
        );
      }

      const msgInsert = await client.query(
        `INSERT INTO chat_messages (
           conversation_id,
           sender_id,
           message_type,
           body,
           attachment_file_id,
           client_message_id
         )
         VALUES ($1, $2, $3::message_type, $4, $5, $6)
         RETURNING
           message_id,
           conversation_id,
           sender_id,
           message_type,
           body,
           attachment_file_id,
           client_message_id,
           created_at`,
        [
          conversationId,
          senderId,
          messageType,
          payload.body || null,
          attachmentFileRow ? Number(attachmentFileRow.file_id) : null,
          clientMessageUuid,
        ]
      );

      const msgRow = msgInsert.rows[0];
      const messageId = Number(msgRow.message_id);

      const isSenderPatient = senderId === patientId;
      await client.query(
        `UPDATE chat_conversations
         SET last_message_id = $2,
             last_message_at = $3,
             patient_last_read_message_id = CASE
               WHEN $4 THEN GREATEST(patient_last_read_message_id, $2)
               ELSE patient_last_read_message_id
             END,
             doctor_last_read_message_id = CASE
               WHEN NOT $4 THEN GREATEST(doctor_last_read_message_id, $2)
               ELSE doctor_last_read_message_id
             END
         WHERE conversation_id = $1`,
        [conversationId, messageId, msgRow.created_at, isSenderPatient]
      );

      const recipientId = isSenderPatient ? doctorId : patientId;
      const signedAttachmentUrl = attachmentFileRow
        ? generateSignedFileUrl(attachmentFileRow.storage_key)
        : null;

      const messagePayload = {
        messageId,
        conversationId,
        caseId: Number(conv.case_id),
        caseNumber: conv.case_number,
        senderId,
        senderName: sender.fullName,
        senderRole: sender.role,
        messageType: msgRow.message_type,
        body: msgRow.body || null,
        attachmentFileId: attachmentFileRow ? Number(attachmentFileRow.file_id) : null,
        attachmentUrl: signedAttachmentUrl,
        clientMessageId: msgRow.client_message_id || null,
        createdAt: msgRow.created_at,
      };

      // Create in-app notification if recipient is not actively connected to conv:{conversationId}
      if (!isUserPresentInRoom(recipientId, `conv:${conversationId}`)) {
        await createNotification(
          client,
          {
            userId: recipientId,
            type: 'NEW_CHAT_MESSAGE',
            title: sender.fullName,
            body:
              msgRow.body ||
              (msgRow.message_type === 'IMAGE'
                ? 'Sent an image attachment'
                : 'Sent a file attachment'),
            data: {
              conversationId,
              messageId,
              caseId: Number(conv.case_id),
              caseNumber: conv.case_number,
              senderId,
            },
            caseId: Number(conv.case_id),
          },
          afterCommit
        );
      }

      afterCommit(() => {
        emitToRooms(
          [`conv:${conversationId}`, `user:${recipientId}`],
          'chat.message_created',
          messagePayload
        );
      });

      return messagePayload;
    });
  } catch (err) {
    if (storedFile) {
      await deleteStoredFileQuietly(storedFile.storageKey);
    }
    throw err;
  }
}

/**
 * POST /api/v1/conversations/:conversationId/read
 * Updates `patient_last_read_message_id` or `doctor_last_read_message_id` (`GREATEST(current, $1)`)
 * and emits `chat.messages_read` to `conv:{conversationId}` (§4.7).
 *
 * @param {number} conversationId
 * @param {{ userId: number, role: string }} reader
 * @param {import('z').infer<typeof markReadSchema>} payload
 */
export async function markConversationMessagesRead(conversationId, reader, payload) {
  return withTransaction(async (client, afterCommit) => {
    const convRes = await client.query(
      `SELECT
         conversation_id,
         case_id,
         patient_id,
         doctor_id,
         last_message_id,
         patient_last_read_message_id,
         doctor_last_read_message_id
       FROM chat_conversations
       WHERE conversation_id = $1
       FOR UPDATE`,
      [conversationId]
    );

    if (convRes.rows.length === 0) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation was not found.');
    }

    const conv = convRes.rows[0];
    const readerId = Number(reader.userId);
    const patientId = Number(conv.patient_id);
    const doctorId = Number(conv.doctor_id);

    if (readerId !== patientId && readerId !== doctorId) {
      throw new AppError(
        403,
        'NOT_CONVERSATION_PARTICIPANT',
        'You are not a participant in this conversation.'
      );
    }

    const targetMessageId = Number(
      payload.lastReadMessageId || conv.last_message_id || 0
    );

    const isPatient = readerId === patientId;
    const updRes = await client.query(
      `UPDATE chat_conversations
       SET patient_last_read_message_id = CASE
             WHEN $2 THEN GREATEST(patient_last_read_message_id, $3)
             ELSE patient_last_read_message_id
           END,
           doctor_last_read_message_id = CASE
             WHEN NOT $2 THEN GREATEST(doctor_last_read_message_id, $3)
             ELSE doctor_last_read_message_id
           END
       WHERE conversation_id = $1
       RETURNING patient_last_read_message_id, doctor_last_read_message_id`,
      [conversationId, isPatient, targetMessageId]
    );

    // Also mark any unread NEW_CHAT_MESSAGE notifications for this case as read
    await client.query(
      `UPDATE notifications
       SET is_read = TRUE,
           read_at = now()
       WHERE user_id = $1
         AND case_id = $2
         AND type = 'NEW_CHAT_MESSAGE'
         AND is_read = FALSE`,
      [readerId, Number(conv.case_id)]
    );

    const updated = updRes.rows[0];
    const lastReadMessageId = isPatient
      ? Number(updated.patient_last_read_message_id)
      : Number(updated.doctor_last_read_message_id);
    const peerId = isPatient ? doctorId : patientId;

    afterCommit(() => {
      emitToRooms(
        [`conv:${conversationId}`, `user:${peerId}`],
        'chat.messages_read',
        {
          conversationId,
          readerId,
          readerRole: reader.role,
          lastReadMessageId,
          readAt: new Date().toISOString(),
        }
      );
    });

    return {
      conversationId,
      lastReadMessageId,
    };
  });
}

/**
 * POST /api/v1/conversations/:conversationId/calls
 * Logs a phone dial or VoIP call attempt in `call_logs`, records a `CALL_EVENT` in `chat_messages`,
 * emits `call.initiated`, and returns the counterparty's `calleePhone` (§4.7).
 *
 * @param {number} conversationId
 * @param {{ userId: number, role: string, fullName: string }} initiator
 * @param {import('z').infer<typeof initiateCallSchema>} payload
 * @param {import('express').Request} req
 */
export async function initiateConversationCall(conversationId, initiator, payload, req) {
  return withTransaction(async (client, afterCommit) => {
    const convRes = await client.query(
      `SELECT
         cc.conversation_id,
         cc.case_id,
         c.case_number,
         cc.patient_id,
         pu.full_name AS patient_name,
         pu.phone AS patient_phone,
         cc.doctor_id,
         du.full_name AS doctor_name,
         du.phone AS doctor_phone,
         cc.status
       FROM chat_conversations cc
       JOIN cases c ON c.case_id = cc.case_id
       JOIN users pu ON pu.user_id = cc.patient_id
       JOIN users du ON du.user_id = cc.doctor_id
       WHERE cc.conversation_id = $1
       FOR UPDATE OF cc`,
      [conversationId]
    );

    if (convRes.rows.length === 0) {
      throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation was not found.');
    }

    const conv = convRes.rows[0];
    const initiatorId = Number(initiator.userId);
    const patientId = Number(conv.patient_id);
    const doctorId = Number(conv.doctor_id);

    if (initiatorId !== patientId && initiatorId !== doctorId) {
      throw new AppError(
        403,
        'NOT_CONVERSATION_PARTICIPANT',
        'Only conversation participants may initiate a call.'
      );
    }

    if (conv.status !== 'OPEN') {
      throw new AppError(
        422,
        'CONVERSATION_NOT_OPEN',
        'Calls can only be initiated while the case conversation is OPEN.'
      );
    }

    const isInitiatorPatient = initiatorId === patientId;
    const calleeId = isInitiatorPatient ? doctorId : patientId;
    const calleeName = isInitiatorPatient ? conv.doctor_name : conv.patient_name;
    const calleePhone = isInitiatorPatient ? conv.doctor_phone : conv.patient_phone;

    const callType = payload.callType || 'PHONE_DIAL';
    const initialCallStatus = callType === 'VOIP' ? 'RINGING' : 'INITIATED';

    const callInsert = await client.query(
      `INSERT INTO call_logs (
         conversation_id,
         initiator_id,
         callee_id,
         call_type,
         status,
         started_at
       )
       VALUES ($1, $2, $3, $4::call_type, $5::call_status, now())
       RETURNING call_id, started_at`,
      [conversationId, initiatorId, calleeId, callType, initialCallStatus]
    );

    const callRow = callInsert.rows[0];
    const callId = Number(callRow.call_id);

    // Record CALL_EVENT in chat_messages timeline
    await client.query(
      `INSERT INTO chat_messages (
         conversation_id,
         sender_id,
         message_type,
         body,
         metadata
       )
       VALUES ($1, $2, 'CALL_EVENT', $3, $4::jsonb)`,
      [
        conversationId,
        initiatorId,
        `${initiator.fullName} initiated a ${callType === 'VOIP' ? 'voice call' : 'phone call'}.`,
        JSON.stringify({ callId, callType, status: initialCallStatus }),
      ]
    );

    await writeAuditLog(client, {
      actorUserId: initiatorId,
      actorRole: initiator.role,
      action: 'CALL_INITIATED',
      entityType: 'call_logs',
      entityId: callId,
      afterData: { conversationId, calleeId, callType },
      req,
    });

    afterCommit(() => {
      emitToRooms(
        [`conv:${conversationId}`, `user:${calleeId}`],
        'call.initiated',
        {
          callId,
          conversationId,
          caseId: Number(conv.case_id),
          caseNumber: conv.case_number,
          callType,
          status: initialCallStatus,
          initiator: {
            userId: initiatorId,
            fullName: initiator.fullName,
            role: initiator.role,
          },
          startedAt: callRow.started_at,
        }
      );
    });

    return {
      callId,
      conversationId,
      callType,
      status: initialCallStatus,
      calleeId,
      calleeName,
      calleePhone,
      startedAt: callRow.started_at,
    };
  });
}
