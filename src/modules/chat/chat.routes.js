import express from 'express';
import { authenticate, authorizeRoles } from '../../middlewares/auth.js';
import { idempotencyGuard } from '../../middlewares/idempotency.js';
import { multerUpload } from '../files/files.service.js';
import {
  getCaseConversationHandler,
  initiateConversationCallHandler,
  listConversationMessagesHandler,
  listMyConversationsHandler,
  markConversationReadHandler,
  sendConversationMessageHandler,
} from './chat.controller.js';

export const conversationsRouter = express.Router();
export const caseConversationRouter = express.Router();

// GET /api/v1/conversations
conversationsRouter.get(
  '/',
  authenticate,
  authorizeRoles('PATIENT', 'DOCTOR', 'ADMIN'),
  listMyConversationsHandler
);

// GET /api/v1/conversations/:conversationId/messages
conversationsRouter.get(
  '/:conversationId/messages',
  authenticate,
  authorizeRoles('PATIENT', 'DOCTOR', 'SUPERVISOR', 'ADMIN'),
  listConversationMessagesHandler
);

// POST /api/v1/conversations/:conversationId/messages
conversationsRouter.post(
  '/:conversationId/messages',
  authenticate,
  authorizeRoles('PATIENT', 'DOCTOR'),
  idempotencyGuard({ required: false }),
  multerUpload.fields([
    { name: 'attachment', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ]),
  sendConversationMessageHandler
);

// POST /api/v1/conversations/:conversationId/read
conversationsRouter.post(
  '/:conversationId/read',
  authenticate,
  authorizeRoles('PATIENT', 'DOCTOR'),
  markConversationReadHandler
);

// POST /api/v1/conversations/:conversationId/calls
conversationsRouter.post(
  '/:conversationId/calls',
  authenticate,
  authorizeRoles('PATIENT', 'DOCTOR'),
  initiateConversationCallHandler
);

// GET /api/v1/cases/:caseId/conversation
caseConversationRouter.get(
  '/:caseId/conversation',
  authenticate,
  authorizeRoles('PATIENT', 'DOCTOR', 'SUPERVISOR', 'ADMIN'),
  getCaseConversationHandler
);
