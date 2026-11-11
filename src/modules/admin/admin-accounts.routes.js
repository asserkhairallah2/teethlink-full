import express from 'express';
import { authenticate, authorizeRoles } from '../../middlewares/auth.js';
import {
  approveAccountHandler,
  listPendingAccountsHandler,
  rejectAccountHandler,
  suspendAccountHandler,
} from './admin-accounts.controller.js';

export const adminAccountsRouter = express.Router();

// All admin account management routes require an authenticated ADMIN user
adminAccountsRouter.use(authenticate, authorizeRoles('ADMIN'));

// GET /api/v1/admin/accounts/pending
adminAccountsRouter.get('/pending', listPendingAccountsHandler);

// POST /api/v1/admin/accounts/:userId/approve
adminAccountsRouter.post('/:userId/approve', approveAccountHandler);

// POST /api/v1/admin/accounts/:userId/reject
adminAccountsRouter.post('/:userId/reject', rejectAccountHandler);

// POST /api/v1/admin/accounts/:userId/suspend
adminAccountsRouter.post('/:userId/suspend', suspendAccountHandler);
