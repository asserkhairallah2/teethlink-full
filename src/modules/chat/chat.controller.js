import { AppError, asyncHandler, sendSuccess } from '../../utils/errors.js';
import { extractMultipartOrJsonPayload } from '../auth/auth.validators.js';
import {
  getConversationByCaseId,
  initiateCallSchema,
  initiateConversationCall,
  listConversationMessages,
  listMessagesQuerySchema,
  listMyConversations,
  markConversationMessagesRead,
  markReadSchema,
  sendChatMessageSchema,
  sendConversationMessage,
} from './chat.service.js';

function pickUploadedFile(req, fieldNames) {
  if (req.file) {
    return req.file;
  }
  if (req.files && typeof req.files === 'object') {
    for (const name of fieldNames) {
      if (Array.isArray(req.files[name]) && req.files[name].length > 0) {
        return req.files[name][0];
      }
    }
  }
  return undefined;
}

/**
 * GET /api/v1/conversations
 */
export const listMyConversationsHandler = asyncHandler(async (req, res) => {
  const data = await listMyConversations(req.user, req.lang || 'ar');
  return sendSuccess(res, data);
});

/**
 * GET /api/v1/cases/:caseId/conversation
 */
export const getCaseConversationHandler = asyncHandler(async (req, res) => {
  const caseId = Number(req.params.caseId);
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new AppError(400, 'INVALID_CASE_ID', 'caseId must be a positive integer.');
  }

  const data = await getConversationByCaseId(caseId, req.user, req.lang || 'ar');
  return sendSuccess(res, data);
});

/**
 * GET /api/v1/conversations/:conversationId/messages
 */
export const listConversationMessagesHandler = asyncHandler(async (req, res) => {
  const conversationId = Number(req.params.conversationId);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    throw new AppError(400, 'INVALID_CONVERSATION_ID', 'conversationId must be a positive integer.');
  }

  const validatedQuery = listMessagesQuerySchema.parse(req.query || {});
  const data = await listConversationMessages(conversationId, req.user, validatedQuery);
  return sendSuccess(res, data);
});

/**
 * POST /api/v1/conversations/:conversationId/messages
 */
export const sendConversationMessageHandler = asyncHandler(async (req, res) => {
  const conversationId = Number(req.params.conversationId);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    throw new AppError(400, 'INVALID_CONVERSATION_ID', 'conversationId must be a positive integer.');
  }

  const rawBody = extractMultipartOrJsonPayload(req);
  const validatedBody = sendChatMessageSchema.parse(rawBody);
  const uploadedFile = pickUploadedFile(req, ['attachment', 'file']);

  const data = await sendConversationMessage(
    conversationId,
    req.user,
    validatedBody,
    uploadedFile,
    req
  );
  return sendSuccess(res, data, 201);
});

/**
 * POST /api/v1/conversations/:conversationId/read
 */
export const markConversationReadHandler = asyncHandler(async (req, res) => {
  const conversationId = Number(req.params.conversationId);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    throw new AppError(400, 'INVALID_CONVERSATION_ID', 'conversationId must be a positive integer.');
  }

  const validatedBody = markReadSchema.parse(req.body || {});
  const data = await markConversationMessagesRead(conversationId, req.user, validatedBody);
  return sendSuccess(res, data);
});

/**
 * POST /api/v1/conversations/:conversationId/calls
 */
export const initiateConversationCallHandler = asyncHandler(async (req, res) => {
  const conversationId = Number(req.params.conversationId);
  if (!Number.isInteger(conversationId) || conversationId <= 0) {
    throw new AppError(400, 'INVALID_CONVERSATION_ID', 'conversationId must be a positive integer.');
  }

  const validatedBody = initiateCallSchema.parse(req.body || {});
  const data = await initiateConversationCall(conversationId, req.user, validatedBody, req);
  return sendSuccess(res, data, 201);
});
