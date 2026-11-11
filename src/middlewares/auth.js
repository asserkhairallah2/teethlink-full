import jwt from 'jsonwebtoken';
import { pool } from '../db/pool.js';
import { AppError, asyncHandler } from '../utils/errors.js';

/**
 * Extracts a Bearer token from an Authorization header string.
 *
 * @param {string | undefined} authHeader
 * @returns {string | null}
 */
export function extractBearerToken(authHeader) {
  if (!authHeader || typeof authHeader !== 'string') {
    return null;
  }
  const parts = authHeader.trim().split(/\s+/);
  if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
    return null;
  }
  return parts[1];
}

/**
 * Verifies a JWT access token and loads the authoritative user security context from PostgreSQL,
 * enforcing:
 * - `users.deleted_at IS NULL`
 * - `users.account_status = 'ACTIVE'`
 * - `users.token_version = payload.tv`
 * - Active `doctor_departments` list for `DOCTOR` role
 * - `supervisor_profiles.is_triage_examiner` flag for `SUPERVISOR` role
 *
 * @param {string} token
 * @returns {Promise<{
 *   userId: number,
 *   role: 'PATIENT' | 'DOCTOR' | 'SUPERVISOR' | 'ADMIN',
 *   fullName: string,
 *   phone: string,
 *   email: string | null,
 *   accountStatus: string,
 *   preferredLanguage: 'ar' | 'en',
 *   tokenVersion: number,
 *   departmentIds: number[],
 *   isTriageExaminer: boolean
 * }>}
 */
export async function verifyAndLoadUserContext(token) {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) {
    throw new AppError(500, 'AUTH_CONFIG_ERROR', 'JWT_ACCESS_SECRET is not configured on the server.');
  }

  let payload;
  try {
    payload = jwt.verify(token, secret);
  } catch (err) {
    if (err.name === 'TokenExpiredError') {
      throw new AppError(401, 'TOKEN_EXPIRED', 'Access token has expired.', {
        expiredAt: err.expiredAt || null,
      });
    }
    throw new AppError(401, 'INVALID_TOKEN', 'Invalid or malformed access token.');
  }

  const userId = Number(payload.sub || payload.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    throw new AppError(401, 'INVALID_TOKEN_PAYLOAD', 'Token subject is invalid.');
  }

  const userQuery = `
    SELECT
      u.user_id,
      u.role,
      u.full_name,
      u.phone,
      u.email,
      u.account_status,
      u.preferred_language,
      u.token_version,
      u.deleted_at,
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
    WHERE u.user_id = $1
    LIMIT 1
  `;

  const { rows } = await pool.query(userQuery, [userId]);
  if (rows.length === 0 || rows[0].deleted_at !== null) {
    throw new AppError(401, 'USER_NOT_FOUND', 'The user account associated with this token no longer exists.');
  }

  const userRow = rows[0];

  if (userRow.account_status !== 'ACTIVE') {
    throw new AppError(
      403,
      'ACCOUNT_NOT_ACTIVE',
      `Your account status is currently ${userRow.account_status}. Access requires an ACTIVE account.`,
      { accountStatus: userRow.account_status }
    );
  }

  const tokenVersionInJwt = payload.tv !== undefined ? Number(payload.tv) : Number(userRow.token_version);
  if (tokenVersionInJwt !== Number(userRow.token_version)) {
    throw new AppError(
      401,
      'TOKEN_REVOKED',
      'Your session has been invalidated due to a security update or password change. Please log in again.'
    );
  }

  return {
    userId: Number(userRow.user_id),
    role: userRow.role,
    fullName: userRow.full_name,
    phone: userRow.phone,
    email: userRow.email,
    accountStatus: userRow.account_status,
    preferredLanguage: userRow.preferred_language === 'en' ? 'en' : 'ar',
    tokenVersion: Number(userRow.token_version),
    departmentIds: Array.isArray(userRow.department_ids)
      ? userRow.department_ids.map((id) => Number(id))
      : [],
    isTriageExaminer: Boolean(userRow.is_triage_examiner),
  };
}

/**
 * Mandatory JWT authentication middleware.
 * Populates `req.user` or responds with `401`/`403`.
 */
export const authenticate = asyncHandler(async (req, _res, next) => {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    throw new AppError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Missing or invalid Authorization Bearer token header.'
    );
  }

  const userContext = await verifyAndLoadUserContext(token);
  req.user = userContext;

  if (!req.query?.lang && !req.headers['accept-language']) {
    req.lang = userContext.preferredLanguage;
  }

  next();
});

/**
 * Optional JWT authentication middleware.
 * Populates `req.user` if a valid Bearer token is provided, or `req.user = null` if omitted.
 */
export const optionalAuthenticate = asyncHandler(async (req, _res, next) => {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    req.user = null;
    return next();
  }

  const userContext = await verifyAndLoadUserContext(token);
  req.user = userContext;
  next();
});

/**
 * Role-based access control (RBAC) guard factory.
 * Must be placed after `authenticate`.
 *
 * @param {...('PATIENT' | 'DOCTOR' | 'SUPERVISOR' | 'ADMIN')} allowedRoles
 * @returns {import('express').RequestHandler}
 */
export function authorizeRoles(...allowedRoles) {
  return function roleGuard(req, _res, next) {
    if (!req.user) {
      return next(
        new AppError(401, 'AUTHENTICATION_REQUIRED', 'Authentication is required to access this resource.')
      );
    }

    if (!allowedRoles.includes(req.user.role)) {
      return next(
        new AppError(
          403,
          'FORBIDDEN_ROLE',
          `Role '${req.user.role}' is not permitted to perform this action. Required: ${allowedRoles.join(', ')}.`,
          { userRole: req.user.role, allowedRoles }
        )
      );
    }

    return next();
  };
}
