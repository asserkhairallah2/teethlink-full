import crypto from 'node:crypto';

/**
 * Custom application error carrying an HTTP status code, machine-readable error code,
 * human-readable message, and optional structured details.
 */
export class AppError extends Error {
  /**
   * @param {number} statusCode - HTTP status code (e.g. 400, 401, 403, 404, 409, 422, 500)
   * @param {string} code - Machine-readable uppercase error code (e.g. 'SLOT_UNAVAILABLE')
   * @param {string} message - Localized or clear human-readable message
   * @param {Record<string, any> | Array<any> | null} [details=null] - Optional diagnostic payload
   */
  constructor(statusCode, code, message, details = null) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    Error.captureStackTrace?.(this, this.constructor);
  }
}

/**
 * Wraps an async Express route handler or middleware and forwards any rejected promise
 * to Express's `next(err)` error chain.
 *
 * @param {(req: import('express').Request, res: import('express').Response, next: import('express').NextFunction) => Promise<any>} fn
 * @returns {import('express').RequestHandler}
 */
export function asyncHandler(fn) {
  return function wrappedAsyncHandler(req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

/**
 * Sends a standardized TeethLink success envelope (§0.3):
 * `{ success: true, data, meta? }`
 *
 * @param {import('express').Response} res
 * @param {any} data
 * @param {number} [statusCode=200]
 * @param {Record<string, any>} [meta]
 */
export function sendSuccess(res, data, statusCode = 200, meta = undefined) {
  const payload = {
    success: true,
    data,
  };
  if (meta !== undefined && meta !== null) {
    payload.meta = meta;
  }
  return res.status(statusCode).json(payload);
}

/**
 * Express middleware that attaches a unique `req.requestId` (honoring incoming `X-Request-Id`
 * if provided) and echoes it on the `X-Request-Id` response header.
 * Also resolves `req.lang` ('ar' | 'en') from `?lang=` query or `Accept-Language` header.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function requestContextMiddleware(req, res, next) {
  const incomingRequestId = req.headers['x-request-id'];
  const requestId =
    typeof incomingRequestId === 'string' && incomingRequestId.trim().length > 0
      ? incomingRequestId.trim()
      : `req_${crypto.randomUUID()}`;

  req.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);

  const queryLang = typeof req.query?.lang === 'string' ? req.query.lang.toLowerCase() : '';
  const headerLang =
    typeof req.headers['accept-language'] === 'string'
      ? req.headers['accept-language'].toLowerCase()
      : '';

  if (queryLang === 'ar' || queryLang === 'en') {
    req.lang = queryLang;
  } else if (headerLang.startsWith('ar')) {
    req.lang = 'ar';
  } else {
    req.lang = 'en';
  }

  next();
}
