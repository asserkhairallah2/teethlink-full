import { AppError, asyncHandler, sendSuccess } from '../../utils/errors.js';
import {
  approveAccountSchema,
  approveUserAccount,
  listAccountsForAdmin,
  listPendingAccountsQuerySchema,
  rejectOrSuspendAccountSchema,
  rejectUserAccount,
  suspendUserAccount,
} from './admin-accounts.service.js';

/**
 * GET /api/v1/admin/accounts/pending
 */
export const listPendingAccountsHandler = asyncHandler(async (req, res) => {
  const validatedQuery = listPendingAccountsQuerySchema.parse(req.query || {});
  const { accounts, meta } = await listAccountsForAdmin(validatedQuery);
  return sendSuccess(res, accounts, 200, meta);
});

/**
 * POST /api/v1/admin/accounts/:userId/approve
 */
export const approveAccountHandler = asyncHandler(async (req, res) => {
  const targetUserId = Number(req.params.userId);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw new AppError(400, 'INVALID_USER_ID', 'userId must be a positive integer.');
  }

  const validatedBody = approveAccountSchema.parse(req.body || {});
  const result = await approveUserAccount(
    targetUserId,
    req.user.userId,
    validatedBody,
    req
  );
  return sendSuccess(res, result, 200);
});

/**
 * POST /api/v1/admin/accounts/:userId/reject
 */
export const rejectAccountHandler = asyncHandler(async (req, res) => {
  const targetUserId = Number(req.params.userId);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw new AppError(400, 'INVALID_USER_ID', 'userId must be a positive integer.');
  }

  const { reason } = rejectOrSuspendAccountSchema.parse(req.body || {});
  const result = await rejectUserAccount(
    targetUserId,
    req.user.userId,
    reason,
    req
  );
  return sendSuccess(res, result, 200);
});

/**
 * POST /api/v1/admin/accounts/:userId/suspend
 */
export const suspendAccountHandler = asyncHandler(async (req, res) => {
  const targetUserId = Number(req.params.userId);
  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw new AppError(400, 'INVALID_USER_ID', 'userId must be a positive integer.');
  }

  const { reason } = rejectOrSuspendAccountSchema.parse(req.body || {});
  const result = await suspendUserAccount(
    targetUserId,
    req.user.userId,
    reason,
    req
  );
  return sendSuccess(res, result, 200);
});
