import net from 'node:net';
import { emitToUser } from '../realtime/socketGateway.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Extracts a valid UUID string from `req.requestId` (e.g. 'req_550e8400-...') or returns null
 * so PostgreSQL `UUID` columns never fail on custom request ID prefixes.
 *
 * @param {string | null | undefined} rawRequestId
 * @returns {string | null}
 */
export function normalizeUuidOrNull(rawRequestId) {
  if (!rawRequestId || typeof rawRequestId !== 'string') {
    return null;
  }
  const stripped = rawRequestId.trim().replace(/^req_/i, '');
  return UUID_REGEX.test(stripped) ? stripped.toLowerCase() : null;
}

/**
 * Normalizes an Express `req.ip` string into a valid IPv4/IPv6 literal for PostgreSQL `INET` columns,
 * or returns `null` if invalid.
 *
 * @param {string | null | undefined} rawIp
 * @returns {string | null}
 */
export function normalizeInetOrNull(rawIp) {
  if (!rawIp || typeof rawIp !== 'string') {
    return null;
  }
  const candidate = rawIp.split(',')[0].trim();
  if (!candidate) {
    return null;
  }
  if (net.isIP(candidate) !== 0) {
    return candidate;
  }
  return null;
}

/**
 * Inserts an immutable row into `audit_logs`.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} dbClient
 * @param {{
 *   actorUserId?: number | null,
 *   actorRole?: 'PATIENT' | 'DOCTOR' | 'SUPERVISOR' | 'ADMIN' | null,
 *   action: string,
 *   entityType: string,
 *   entityId?: number | null,
 *   beforeData?: Record<string, any> | null,
 *   afterData?: Record<string, any> | null,
 *   req?: import('express').Request
 * }} params
 */
export async function writeAuditLog(
  dbClient,
  {
    actorUserId = null,
    actorRole = null,
    action,
    entityType,
    entityId = null,
    beforeData = null,
    afterData = null,
    req = undefined,
  }
) {
  const ipAddress = normalizeInetOrNull(req?.ip || req?.socket?.remoteAddress);
  const userAgent =
    typeof req?.headers?.['user-agent'] === 'string'
      ? req.headers['user-agent'].slice(0, 500)
      : null;
  const requestId = normalizeUuidOrNull(req?.requestId);

  const { rows } = await dbClient.query(
    `INSERT INTO audit_logs (
       actor_user_id,
       actor_role,
       action,
       entity_type,
       entity_id,
       before_data,
       after_data,
       ip_address,
       user_agent,
       request_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING log_id, created_at`,
    [
      actorUserId ?? req?.user?.userId ?? null,
      actorRole ?? req?.user?.role ?? null,
      action,
      entityType,
      entityId !== null && entityId !== undefined ? Number(entityId) : null,
      beforeData ? JSON.stringify(beforeData) : null,
      afterData ? JSON.stringify(afterData) : null,
      ipAddress,
      userAgent,
      requestId,
    ]
  );

  return rows[0];
}

/**
 * Inserts an in-app notification row into `notifications` and schedules a real-time
 * Socket.io `notification.created` push to `user:{userId}` via `afterCommit` (if provided).
 *
 * @param {import('pg').PoolClient | import('pg').Pool} dbClient
 * @param {{
 *   userId: number,
 *   type: string,
 *   title: string,
 *   body: string,
 *   data?: Record<string, any>,
 *   caseId?: number | null
 * }} payload
 * @param {((cb: () => void) => void) | undefined} [afterCommit]
 */
export async function createNotification(
  dbClient,
  { userId, type, title, body, data = {}, caseId = null },
  afterCommit = undefined
) {
  const { rows } = await dbClient.query(
    `INSERT INTO notifications (
       user_id,
       type,
       title,
       body,
       data,
       case_id
     )
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING
       notification_id,
       user_id,
       type,
       title,
       body,
       data,
       case_id,
       is_read,
       created_at`,
    [
      Number(userId),
      type,
      title,
      body,
      JSON.stringify(data || {}),
      caseId !== null && caseId !== undefined ? Number(caseId) : null,
    ]
  );

  const notif = rows[0];
  const emitFn = () => {
    emitToUser(Number(userId), 'notification.created', {
      notificationId: Number(notif.notification_id),
      type: notif.type,
      title: notif.title,
      body: notif.body,
      data: notif.data,
      caseId: notif.case_id ? Number(notif.case_id) : null,
      isRead: Boolean(notif.is_read),
      createdAt: notif.created_at,
    });
  };

  if (typeof afterCommit === 'function') {
    afterCommit(emitFn);
  } else {
    emitFn();
  }

  return notif;
}
