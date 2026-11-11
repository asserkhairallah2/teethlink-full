import express from 'express';
import { pool } from '../../db/pool.js';
import { authenticate, optionalAuthenticate } from '../../middlewares/auth.js';
import { AppError, asyncHandler, sendSuccess } from '../../utils/errors.js';
import {
  assertFileAccess,
  deleteStoredFileQuietly,
  generateSignedFileUrl,
  getFileRecordAndDiskPath,
  insertFileRecord,
  multerUpload,
  validateAndStoreUploadedFile,
  verifySignedFileUrl,
} from './files.service.js';

const VALID_PURPOSES = [
  'MEDICAL_DOCUMENT',
  'PROFILE_PHOTO',
  'CASE_PHOTO',
  'CHAT_ATTACHMENT',
  'DOCTOR_ID_PROOF',
];

/**
 * POST /api/v1/files/upload
 * Standalone authenticated multipart file upload endpoint.
 */
export const uploadFileHandler = asyncHandler(async (req, res) => {
  if (!req.file) {
    throw new AppError(400, 'FILE_REQUIRED', 'Multipart field "file" is required.');
  }

  const rawPurpose = String(req.body?.purpose || 'MEDICAL_DOCUMENT').toUpperCase();
  if (!VALID_PURPOSES.includes(rawPurpose)) {
    throw new AppError(
      400,
      'INVALID_FILE_PURPOSE',
      `Invalid file purpose '${rawPurpose}'. Allowed: ${VALID_PURPOSES.join(', ')}.`
    );
  }

  const isPrivate = rawPurpose !== 'PROFILE_PHOTO';
  const stored = await validateAndStoreUploadedFile(req.file, rawPurpose);

  try {
    const fileRow = await insertFileRecord(pool, {
      ownerUserId: req.user.userId,
      purpose: rawPurpose,
      storageKey: stored.storageKey,
      originalName: stored.originalName,
      mimeType: stored.mimeType,
      sizeBytes: stored.sizeBytes,
      sha256: stored.sha256,
      isPrivate,
    });

    return sendSuccess(
      res,
      {
        fileId: Number(fileRow.file_id),
        ownerUserId: Number(fileRow.owner_user_id),
        purpose: fileRow.purpose,
        storageKey: fileRow.storage_key,
        originalName: fileRow.original_name,
        mimeType: fileRow.mime_type,
        sizeBytes: Number(fileRow.size_bytes),
        sha256: fileRow.sha256,
        isPrivate: Boolean(fileRow.is_private),
        signedUrl: generateSignedFileUrl(fileRow.storage_key),
        createdAt: fileRow.created_at,
      },
      201
    );
  } catch (err) {
    await deleteStoredFileQuietly(stored.storageKey);
    throw err;
  }
});

/**
 * GET /api/v1/files/:fileId
 * Returns metadata and a fresh 15-minute signed URL after enforcing §0.4 privacy checks.
 */
export const getFileMetadataHandler = asyncHandler(async (req, res) => {
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    throw new AppError(400, 'INVALID_FILE_ID', 'fileId must be a positive integer.');
  }

  const { fileRow } = await getFileRecordAndDiskPath({ fileId });
  await assertFileAccess(req.user, fileRow);

  return sendSuccess(res, {
    fileId: Number(fileRow.file_id),
    ownerUserId: Number(fileRow.owner_user_id),
    purpose: fileRow.purpose,
    storageKey: fileRow.storage_key,
    originalName: fileRow.original_name,
    mimeType: fileRow.mime_type,
    sizeBytes: Number(fileRow.size_bytes),
    sha256: fileRow.sha256,
    isPrivate: Boolean(fileRow.is_private),
    signedUrl: generateSignedFileUrl(fileRow.storage_key),
    createdAt: fileRow.created_at,
  });
});

/**
 * GET /api/v1/files/:fileId/download
 * Streams a file binary if either a valid HMAC signature (?exp=&sig=) is supplied
 * OR the authenticated caller passes the §0.4 role/ownership privacy matrix.
 */
export const downloadFileByIdHandler = asyncHandler(async (req, res) => {
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(fileId) || fileId <= 0) {
    throw new AppError(400, 'INVALID_FILE_ID', 'fileId must be a positive integer.');
  }

  const { fileRow, createStream } = await getFileRecordAndDiskPath({ fileId });

  const { exp, sig } = req.query;
  const hasValidSignature = verifySignedFileUrl(fileRow.storage_key, exp, sig);

  if (!hasValidSignature) {
    await assertFileAccess(req.user, fileRow);
  }

  res.setHeader('Content-Type', fileRow.mime_type);
  res.setHeader('Content-Length', String(fileRow.size_bytes));
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${encodeURIComponent(fileRow.original_name || 'document')}"`
  );
  res.setHeader('Cache-Control', 'private, max-age=900');

  const stream = createStream();
  stream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
});

/**
 * GET /api/v1/files/signed/:folder/:year/:month/:filename
 * Streams a file addressed by its storage_key using HMAC signature verification
 * (with fallback to authenticated JWT access check).
 */
export const downloadSignedStorageKeyHandler = asyncHandler(async (req, res) => {
  const { folder, year, month, filename } = req.params;
  const storageKey = `${folder}/${year}/${month}/${filename}`;

  const { fileRow, createStream } = await getFileRecordAndDiskPath({ storageKey });

  const { exp, sig } = req.query;
  const hasValidSignature = verifySignedFileUrl(storageKey, exp, sig);

  if (!hasValidSignature) {
    await assertFileAccess(req.user, fileRow);
  }

  res.setHeader('Content-Type', fileRow.mime_type);
  res.setHeader('Content-Length', String(fileRow.size_bytes));
  res.setHeader(
    'Content-Disposition',
    `inline; filename="${encodeURIComponent(fileRow.original_name || filename)}"`
  );
  res.setHeader('Cache-Control', 'private, max-age=900');

  const stream = createStream();
  stream.on('error', (err) => {
    if (!res.headersSent) {
      res.status(500).end();
    } else {
      res.destroy(err);
    }
  });
  stream.pipe(res);
});

export const filesRouter = express.Router();

filesRouter.post('/upload', authenticate, multerUpload.single('file'), uploadFileHandler);
filesRouter.get('/signed/:folder/:year/:month/:filename', optionalAuthenticate, downloadSignedStorageKeyHandler);
filesRouter.get('/:fileId/download', optionalAuthenticate, downloadFileByIdHandler);
filesRouter.get('/:fileId', authenticate, getFileMetadataHandler);
