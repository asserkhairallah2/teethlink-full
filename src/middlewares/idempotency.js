import crypto from 'node:crypto';
import { AppError } from '../utils/errors.js';

/**
 * In-memory idempotency store with automatic TTL expiration.
 * Keyed by `${actorScope}:${method}:${routePath}:${idempotencyKey}`.
 *
 * @type {Map<string, {
 *   state: 'IN_FLIGHT' | 'COMPLETED',
 *   payloadHash: string,
 *   statusCode?: number,
 *   body?: any,
 *   createdAt: number,
 *   expiresAt: number
 * }>}
 */
const idempotencyStore = new Map();

const DEFAULT_TTL_MS = Number(process.env.IDEMPOTENCY_TTL_SECONDS || 86400) * 1000;

// Background sweep every 5 minutes to evict expired idempotency records
const cleanupTimer = setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of idempotencyStore.entries()) {
    if (entry.expiresAt <= now) {
      idempotencyStore.delete(key);
    }
  }
}, 5 * 60 * 1000);

if (typeof cleanupTimer.unref === 'function') {
  cleanupTimer.unref();
}

/**
 * Computes a deterministic SHA-256 digest of the incoming request payload
 * so reusing the same `Idempotency-Key` with a different body is rejected (`422`).
 *
 * @param {any} body
 * @returns {string}
 */
function hashPayload(body) {
  const serialized = body && typeof body === 'object' ? JSON.stringify(body) : String(body ?? '');
  return crypto.createHash('sha256').update(serialized).digest('hex');
}

/**
 * Express middleware enforcing idempotency on critical state-mutating POST endpoints (§0.3, §4):
 * - Exam booking (`POST /api/v1/exams/bookings`)
 * - Triage routing (`POST /api/v1/triage/bookings/:bookingId/route-to-department`)
 * - Case claim (`POST /api/v1/cases/:caseId/claim`)
 * - Bed occupancy & scheduling (`POST /api/v1/cases/:caseId/occupy-bed`, `POST /api/v1/cases/:caseId/appointments`)
 * - Session start (`POST /api/v1/appointments/:appointmentId/start-session`)
 *
 * @param {{ required?: boolean, ttlMs?: number }} [options]
 * @returns {import('express').RequestHandler}
 */
export function idempotencyGuard(options = {}) {
  const required = Boolean(options.required);
  const ttlMs = typeof options.ttlMs === 'number' && options.ttlMs > 0 ? options.ttlMs : DEFAULT_TTL_MS;

  return function idempotencyMiddleware(req, res, next) {
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = typeof rawKey === 'string' ? rawKey.trim() : '';

    if (!idempotencyKey) {
      if (required) {
        return next(
          new AppError(
            400,
            'IDEMPOTENCY_KEY_REQUIRED',
            'The Idempotency-Key header (UUID v4) is required for this endpoint.'
          )
        );
      }
      return next();
    }

    if (idempotencyKey.length < 8 || idempotencyKey.length > 128) {
      return next(
        new AppError(
          400,
          'INVALID_IDEMPOTENCY_KEY',
          'Idempotency-Key must be between 8 and 128 characters (UUID v4 recommended).'
        )
      );
    }

    const actorScope = req.user?.userId ? `user_${req.user.userId}` : `ip_${req.ip || 'anon'}`;
    const routeScope = `${req.method}:${req.baseUrl || ''}${req.path || req.originalUrl}`;
    const compositeKey = `${actorScope}:${routeScope}:${idempotencyKey}`;
    const payloadHash = hashPayload(req.body);
    const now = Date.now();

    const existing = idempotencyStore.get(compositeKey);
    if (existing && existing.expiresAt > now) {
      if (existing.payloadHash !== payloadHash) {
        return next(
          new AppError(
            422,
            'IDEMPOTENCY_KEY_PAYLOAD_MISMATCH',
            'This Idempotency-Key was already used with a different request payload.'
          )
        );
      }

      if (existing.state === 'IN_FLIGHT') {
        return next(
          new AppError(
            409,
            'IDEMPOTENCY_KEY_IN_FLIGHT',
            'A request with this Idempotency-Key is currently being processed. Please wait for it to finish.'
          )
        );
      }

      if (existing.state === 'COMPLETED') {
        res.setHeader('X-Idempotency-Replayed', 'true');
        return res.status(existing.statusCode || 200).json(existing.body);
      }
    }

    // Register request as IN_FLIGHT
    idempotencyStore.set(compositeKey, {
      state: 'IN_FLIGHT',
      payloadHash,
      createdAt: now,
      expiresAt: now + ttlMs,
    });

    let responseCaptured = false;
    const originalJson = res.json.bind(res);

    res.json = function interceptedJson(body) {
      responseCaptured = true;
      const statusCode = res.statusCode || 200;

      if (statusCode >= 200 && statusCode < 300) {
        idempotencyStore.set(compositeKey, {
          state: 'COMPLETED',
          payloadHash,
          statusCode,
          body,
          createdAt: now,
          expiresAt: Date.now() + ttlMs,
        });
      } else {
        // Remove IN_FLIGHT record on 4xx/5xx so client can retry or fix validation errors
        idempotencyStore.delete(compositeKey);
      }

      return originalJson(body);
    };

    res.on('close', () => {
      if (!responseCaptured) {
        const current = idempotencyStore.get(compositeKey);
        if (current && current.state === 'IN_FLIGHT') {
          idempotencyStore.delete(compositeKey);
        }
      }
    });

    return next();
  };
}
