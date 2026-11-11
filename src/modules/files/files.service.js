import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { pool } from '../../db/pool.js';
import { AppError } from '../../utils/errors.js';

const MAX_UPLOAD_BYTES = Number(process.env.UPLOAD_MAX_BYTES || 10 * 1024 * 1024); // 10 MB
const UPLOAD_ROOT_DIR = path.resolve(process.cwd(), process.env.UPLOAD_DIR || './uploads');
const SIGNED_URL_TTL_SECONDS = Number(process.env.SIGNED_URL_TTL_SECONDS || 900); // 15 minutes

const ALLOWED_MIME_TO_EXT = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
};

const PURPOSE_TO_FOLDER = {
  MEDICAL_DOCUMENT: 'medical',
  PROFILE_PHOTO: 'profiles',
  CASE_PHOTO: 'cases',
  CHAT_ATTACHMENT: 'chat',
  DOCTOR_ID_PROOF: 'id-proofs',
};

/**
 * Verifies the magic bytes of an uploaded file buffer to prevent MIME spoofing.
 *
 * @param {Buffer} buffer
 * @param {string} mimeType
 * @returns {boolean}
 */
export function verifyMagicBytes(buffer, mimeType) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return false;
  }

  switch (mimeType) {
    case 'image/jpeg':
      return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;

    case 'image/png':
      return (
        buffer.length >= 8 &&
        buffer[0] === 0x89 &&
        buffer[1] === 0x50 &&
        buffer[2] === 0x4e &&
        buffer[3] === 0x47 &&
        buffer[4] === 0x0d &&
        buffer[5] === 0x0a &&
        buffer[6] === 0x1a &&
        buffer[7] === 0x0a
      );

    case 'image/webp':
      return (
        buffer.length >= 12 &&
        buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
        buffer.subarray(8, 12).toString('ascii') === 'WEBP'
      );

    case 'image/heic': {
      if (buffer.length < 12) return false;
      const boxType = buffer.subarray(4, 8).toString('ascii');
      const brand = buffer.subarray(8, 12).toString('ascii');
      return boxType === 'ftyp' && ['heic', 'heix', 'hevc', 'mif1', 'msf1'].includes(brand);
    }

    case 'application/pdf':
      return buffer.subarray(0, 5).toString('ascii') === '%PDF-';

    default:
      return false;
  }
}

/**
 * Multer memoryStorage instance configured with strict 10MB file size limit and MIME filter.
 */
export const multerUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: MAX_UPLOAD_BYTES,
    files: 5,
  },
  fileFilter: (_req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(ALLOWED_MIME_TO_EXT, mime)) {
      return cb(
        new AppError(
          400,
          'UNSUPPORTED_FILE_TYPE',
          `Unsupported file MIME type '${file.mimetype}'. Allowed: image/jpeg, image/png, image/webp, image/heic, application/pdf.`,
          { allowedMimeTypes: Object.keys(ALLOWED_MIME_TO_EXT) }
        )
      );
    }
    return cb(null, true);
  },
});

/**
 * Validates an uploaded Multer `file` object (size, MIME type, magic bytes), computes its
 * SHA-256 hash, and persists the binary to private local storage under
 * `{purposeFolder}/{yyyy}/{mm}/{uuid}.{ext}`.
 *
 * @param {Express.Multer.File} file
 * @param {'MEDICAL_DOCUMENT' | 'PROFILE_PHOTO' | 'CASE_PHOTO' | 'CHAT_ATTACHMENT' | 'DOCTOR_ID_PROOF'} purpose
 * @returns {Promise<{
 *   storageKey: string,
 *   originalName: string,
 *   mimeType: string,
 *   sizeBytes: number,
 *   sha256: string,
 *   fullDiskPath: string
 * }>}
 */
export async function validateAndStoreUploadedFile(file, purpose = 'MEDICAL_DOCUMENT') {
  if (!file || !Buffer.isBuffer(file.buffer)) {
    throw new AppError(400, 'FILE_REQUIRED', 'No valid file binary was received.');
  }

  const mimeType = (file.mimetype || '').toLowerCase();
  const ext = ALLOWED_MIME_TO_EXT[mimeType];
  if (!ext) {
    throw new AppError(
      400,
      'UNSUPPORTED_FILE_TYPE',
      `Unsupported file MIME type '${file.mimetype}'.`
    );
  }

  if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) {
    throw new AppError(
      413,
      'FILE_TOO_LARGE',
      `File size must be between 1 byte and ${MAX_UPLOAD_BYTES} bytes (10 MB).`
    );
  }

  if (!verifyMagicBytes(file.buffer, mimeType)) {
    throw new AppError(
      400,
      'INVALID_FILE_SIGNATURE',
      `File binary signature does not match declared MIME type '${mimeType}'.`
    );
  }

  const folder = PURPOSE_TO_FOLDER[purpose] || 'misc';
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0');
  const fileUuid = crypto.randomUUID();

  const storageKey = `${folder}/${yyyy}/${mm}/${fileUuid}.${ext}`;
  const fullDiskPath = path.resolve(UPLOAD_ROOT_DIR, storageKey);

  // Prevent path traversal outside UPLOAD_ROOT_DIR
  if (!fullDiskPath.startsWith(UPLOAD_ROOT_DIR)) {
    throw new AppError(400, 'INVALID_STORAGE_KEY', 'Resolved file storage path is invalid.');
  }

  const sha256 = crypto.createHash('sha256').update(file.buffer).digest('hex');
  const originalName = path.basename(file.originalname || `upload.${ext}`).slice(0, 255);

  await fs.mkdir(path.dirname(fullDiskPath), { recursive: true });
  await fs.writeFile(fullDiskPath, file.buffer, { flag: 'wx' });

  return {
    storageKey,
    originalName,
    mimeType,
    sizeBytes: file.size,
    sha256,
    fullDiskPath,
  };
}

/**
 * Deletes a stored file from disk without throwing if cleanup occurs after a DB rollback.
 *
 * @param {string | null | undefined} storageKey
 */
export async function deleteStoredFileQuietly(storageKey) {
  if (!storageKey || typeof storageKey !== 'string') {
    return;
  }
  try {
    const fullDiskPath = path.resolve(UPLOAD_ROOT_DIR, storageKey);
    if (fullDiskPath.startsWith(UPLOAD_ROOT_DIR)) {
      await fs.unlink(fullDiskPath);
    }
  } catch {
    // Ignore if file was already removed
  }
}

/**
 * Inserts a metadata row into the `files` table using either a transaction `client` or `pool`.
 *
 * @param {import('pg').PoolClient | import('pg').Pool} dbClient
 * @param {{
 *   ownerUserId: number,
 *   purpose: 'MEDICAL_DOCUMENT' | 'PROFILE_PHOTO' | 'CASE_PHOTO' | 'CHAT_ATTACHMENT' | 'DOCTOR_ID_PROOF',
 *   storageKey: string,
 *   originalName: string,
 *   mimeType: string,
 *   sizeBytes: number,
 *   sha256: string,
 *   isPrivate?: boolean
 * }} params
 */
export async function insertFileRecord(
  dbClient,
  {
    ownerUserId,
    purpose,
    storageKey,
    originalName,
    mimeType,
    sizeBytes,
    sha256,
    isPrivate = true,
  }
) {
  const { rows } = await dbClient.query(
    `INSERT INTO files (
       owner_user_id,
       purpose,
       storage_key,
       original_name,
       mime_type,
       size_bytes,
       sha256,
       is_private
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING
       file_id,
       owner_user_id,
       purpose,
       storage_key,
       original_name,
       mime_type,
       size_bytes,
       sha256,
       is_private,
       created_at`,
    [ownerUserId, purpose, storageKey, originalName, mimeType, sizeBytes, sha256, isPrivate]
  );

  return rows[0];
}

/**
 * Computes an HMAC-SHA256 signature for short-lived signed file URLs.
 *
 * @param {string} storageKey
 * @param {number} expiresAtUnix - Seconds since epoch
 * @returns {string}
 */
function signStorageKey(storageKey, expiresAtUnix) {
  const secret =
    process.env.SIGNED_URL_SECRET ||
    process.env.JWT_ACCESS_SECRET ||
    'teethlink-default-signing-secret';

  return crypto
    .createHmac('sha256', secret)
    .update(`${storageKey}:${expiresAtUnix}`)
    .digest('hex');
}

/**
 * Generates a short-lived signed download URL (default 15-min TTL) for a `storage_key`
 * as specified in §4.1 of BACKEND_SYSTEM_PLAN.md.
 *
 * @param {string | null | undefined} storageKey
 * @param {number} [ttlSeconds]
 * @returns {string | null}
 */
export function generateSignedFileUrl(storageKey, ttlSeconds = SIGNED_URL_TTL_SECONDS) {
  if (!storageKey || typeof storageKey !== 'string') {
    return null;
  }

  const baseUrl = (
    process.env.PUBLIC_BASE_URL ||
    `http://localhost:${process.env.PORT || 4000}`
  ).replace(/\/+$/, '');

  const expiresAtUnix = Math.floor(Date.now() / 1000) + ttlSeconds;
  const signature = signStorageKey(storageKey, expiresAtUnix);
  const encodedKey = storageKey
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');

  return `${baseUrl}/api/v1/files/signed/${encodedKey}?exp=${expiresAtUnix}&sig=${signature}`;
}

/**
 * Verifies an HMAC-SHA256 signature and expiration timestamp for a signed download URL.
 *
 * @param {string} storageKey
 * @param {string | number} exp
 * @param {string} sig
 * @returns {boolean}
 */
export function verifySignedFileUrl(storageKey, exp, sig) {
  if (!storageKey || !exp || !sig || typeof sig !== 'string') {
    return false;
  }

  const expiresAtUnix = Number(exp);
  if (!Number.isInteger(expiresAtUnix) || expiresAtUnix < Math.floor(Date.now() / 1000)) {
    return false;
  }

  const expectedSig = signStorageKey(storageKey, expiresAtUnix);
  const sigBuf = Buffer.from(sig, 'utf8');
  const expectedBuf = Buffer.from(expectedSig, 'utf8');

  if (sigBuf.length !== expectedBuf.length) {
    return false;
  }

  return crypto.timingSafeEqual(sigBuf, expectedBuf);
}

/**
 * Enforces the §0.4 Privacy Matrix for accessing a file record when accessed via JWT.
 *
 * - `ADMIN` and `SUPERVISOR`: full clinical/administrative oversight.
 * - Owner (`fileRow.owner_user_id === user.userId`): always allowed.
 * - `MEDICAL_DOCUMENT`: allowed for `DOCTOR` only if the doctor is `assigned_doctor_id`
 *   on an active or historical case belonging to `fileRow.owner_user_id`.
 * - `DOCTOR_ID_PROOF`: owner, `SUPERVISOR`, `ADMIN`.
 * - `CASE_PHOTO`: owner, case's `patient_id`, case's `assigned_doctor_id`, `SUPERVISOR`, `ADMIN`,
 *   or if published in a portfolio post where `patient_profiles.photo_consent = TRUE`.
 * - `CHAT_ATTACHMENT`: participant in the `chat_conversations` containing the message, or `ADMIN`.
 * - `PROFILE_PHOTO`: any authenticated user.
 *
 * @param {{ userId: number, role: string } | null} user
 * @param {{
 *   file_id: number,
 *   owner_user_id: number,
 *   purpose: string,
 *   storage_key: string,
 *   is_private: boolean
 * }} fileRow
 */
export async function assertFileAccess(user, fileRow) {
  if (!fileRow.is_private) {
    return;
  }

  if (!user) {
    throw new AppError(
      401,
      'AUTHENTICATION_REQUIRED',
      'Authentication or a valid signed URL is required to access this private file.'
    );
  }

  const userId = Number(user.userId);
  const ownerId = Number(fileRow.owner_user_id);

  if (userId === ownerId || user.role === 'ADMIN' || user.role === 'SUPERVISOR') {
    return;
  }

  if (fileRow.purpose === 'PROFILE_PHOTO') {
    return;
  }

  if (fileRow.purpose === 'MEDICAL_DOCUMENT') {
    if (user.role === 'DOCTOR') {
      const { rowCount } = await pool.query(
        `SELECT 1
         FROM cases c
         WHERE c.patient_id = $1
           AND c.assigned_doctor_id = $2
         LIMIT 1`,
        [ownerId, userId]
      );
      if (rowCount > 0) {
        return;
      }
    }
    throw new AppError(
      403,
      'MEDICAL_DOCUMENT_ACCESS_DENIED',
      'Only the patient, a triage supervisor, an admin, or the doctor assigned to this patient case may view medical documents.'
    );
  }

  if (fileRow.purpose === 'CASE_PHOTO') {
    const { rows } = await pool.query(
      `SELECT
         c.patient_id,
         c.assigned_doctor_id,
         pp.photo_consent,
         EXISTS (
           SELECT 1
           FROM student_post_photos spp
           JOIN student_posts sp ON sp.post_id = spp.post_id
           WHERE spp.photo_id = cp.photo_id
             AND sp.is_published = TRUE
         ) AS is_in_published_post
       FROM case_photos cp
       JOIN cases c ON c.case_id = cp.case_id
       JOIN patient_profiles pp ON pp.patient_id = c.patient_id
       WHERE cp.file_id = $1
       LIMIT 1`,
      [fileRow.file_id]
    );

    if (rows.length > 0) {
      const row = rows[0];
      if (
        Number(row.patient_id) === userId ||
        Number(row.assigned_doctor_id) === userId ||
        (row.photo_consent && row.is_in_published_post)
      ) {
        return;
      }
    }

    throw new AppError(
      403,
      'CASE_PHOTO_ACCESS_DENIED',
      'You do not have permission to view this case photo.'
    );
  }

  if (fileRow.purpose === 'CHAT_ATTACHMENT') {
    const { rowCount } = await pool.query(
      `SELECT 1
       FROM chat_messages cm
       JOIN chat_conversations cc ON cc.conversation_id = cm.conversation_id
       WHERE cm.attachment_file_id = $1
         AND (cc.patient_id = $2 OR cc.doctor_id = $2)
       LIMIT 1`,
      [fileRow.file_id, userId]
    );
    if (rowCount > 0) {
      return;
    }

    throw new AppError(
      403,
      'CHAT_ATTACHMENT_ACCESS_DENIED',
      'Only participants of this conversation can access this chat attachment.'
    );
  }

  throw new AppError(403, 'FILE_ACCESS_DENIED', 'You do not have permission to access this file.');
}

/**
 * Resolves a file metadata row by `fileId` or `storageKey` and verifies disk existence.
 *
 * @param {{ fileId?: number, storageKey?: string }} locator
 */
export async function getFileRecordAndDiskPath({ fileId, storageKey }) {
  let queryText;
  let queryParam;

  if (fileId !== undefined && fileId !== null) {
    queryText = `
      SELECT file_id, owner_user_id, purpose, storage_key, original_name, mime_type, size_bytes, sha256, is_private, created_at
      FROM files
      WHERE file_id = $1
      LIMIT 1
    `;
    queryParam = [Number(fileId)];
  } else if (storageKey) {
    queryText = `
      SELECT file_id, owner_user_id, purpose, storage_key, original_name, mime_type, size_bytes, sha256, is_private, created_at
      FROM files
      WHERE storage_key = $1
      LIMIT 1
    `;
    queryParam = [String(storageKey)];
  } else {
    throw new AppError(400, 'INVALID_FILE_LOCATOR', 'Either fileId or storageKey is required.');
  }

  const { rows } = await pool.query(queryText, queryParam);
  if (rows.length === 0) {
    throw new AppError(404, 'FILE_NOT_FOUND', 'Requested file was not found.');
  }

  const fileRow = rows[0];
  const fullDiskPath = path.resolve(UPLOAD_ROOT_DIR, fileRow.storage_key);

  if (!fullDiskPath.startsWith(UPLOAD_ROOT_DIR) || !existsSync(fullDiskPath)) {
    throw new AppError(404, 'FILE_BINARY_NOT_FOUND', 'Requested file binary is missing from storage.');
  }

  return { fileRow, fullDiskPath, createStream: () => createReadStream(fullDiskPath) };
}
