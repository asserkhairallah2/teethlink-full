import { AppError } from '../utils/errors.js';
import { mapPgError } from '../db/pool.js';

/**
 * 404 handler for unmatched API routes.
 *
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} next
 */
export function notFoundHandler(req, res, next) {
  next(
    new AppError(
      404,
      'ROUTE_NOT_FOUND',
      `Route ${req.method} ${req.originalUrl} does not exist on this server.`
    )
  );
}

/**
 * Global Express error handling middleware producing the standardized error envelope (§0.3):
 * `{ success: false, error: { code, message, details }, requestId }`
 *
 * @param {any} err
 * @param {import('express').Request} req
 * @param {import('express').Response} res
 * @param {import('express').NextFunction} _next
 */
export function errorHandler(err, req, res, _next) {
  const requestId = req.requestId || 'req_unknown';

  // 1. Map any raw PostgreSQL error that was not already mapped by pool/withTransaction
  const mappedErr = err && err.code && !(err instanceof AppError) ? mapPgError(err) : err;

  // 2. Known AppError
  if (mappedErr instanceof AppError) {
    return res.status(mappedErr.statusCode).json({
      success: false,
      error: {
        code: mappedErr.code,
        message: mappedErr.message,
        details: mappedErr.details ?? null,
      },
      requestId,
    });
  }

  // 3. Zod validation error
  if (mappedErr && mappedErr.name === 'ZodError') {
    const issues = Array.isArray(mappedErr.issues)
      ? mappedErr.issues.map((issue) => ({
          path: Array.isArray(issue.path) ? issue.path.join('.') : String(issue.path || ''),
          message: issue.message,
          code: issue.code,
        }))
      : [];

    return res.status(400).json({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed. Check error.details.issues for field-level errors.',
        details: { issues },
      },
      requestId,
    });
  }

  // 4. Multer multipart file upload errors
  if (mappedErr && mappedErr.name === 'MulterError') {
    const isTooLarge = mappedErr.code === 'LIMIT_FILE_SIZE';
    return res.status(isTooLarge ? 413 : 400).json({
      success: false,
      error: {
        code: isTooLarge ? 'FILE_TOO_LARGE' : 'FILE_UPLOAD_ERROR',
        message: isTooLarge
          ? 'Uploaded file exceeds the maximum allowed size limit (10 MB).'
          : mappedErr.message || 'Multipart file upload error.',
        details: {
          multerCode: mappedErr.code,
          field: mappedErr.field || null,
        },
      },
      requestId,
    });
  }

  // 5. Malformed JSON body error from express.json()
  if (mappedErr instanceof SyntaxError && 'body' in mappedErr) {
    return res.status(400).json({
      success: false,
      error: {
        code: 'INVALID_JSON_PAYLOAD',
        message: 'Malformed JSON in request body.',
        details: null,
      },
      requestId,
    });
  }

  // 6. JWT verification errors
  if (mappedErr && mappedErr.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'TOKEN_EXPIRED',
        message: 'Access token has expired. Please refresh your token or sign in again.',
        details: { expiredAt: mappedErr.expiredAt || null },
      },
      requestId,
    });
  }

  if (mappedErr && mappedErr.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      error: {
        code: 'INVALID_TOKEN',
        message: 'Invalid authentication token.',
        details: null,
      },
      requestId,
    });
  }

  // 7. Unhandled internal error
  console.error(`[ErrorHandler] Unhandled error on ${req.method} ${req.originalUrl} (${requestId}):`, mappedErr);

  const isProd = process.env.NODE_ENV === 'production';
  return res.status(500).json({
    success: false,
    error: {
      code: 'INTERNAL_SERVER_ERROR',
      message: isProd
        ? 'An unexpected internal server error occurred.'
        : mappedErr?.message || 'An unexpected internal server error occurred.',
      details: isProd ? null : { stack: mappedErr?.stack || null },
    },
    requestId,
  });
}
