import { AppError, asyncHandler, sendSuccess } from '../../utils/errors.js';
import { extractMultipartOrJsonPayload } from '../auth/auth.validators.js';
import {
  getPatientMedicalProfile,
  updateMedicalProfileSchema,
  updateMyMedicalProfile,
  uploadMedicalDocumentMetaSchema,
  uploadMyMedicalDocument,
} from './patients.service.js';

function pickUploadedFile(req, fieldNames) {
  if (req.file) {
    return req.file;
  }
  if (req.files && typeof req.files === 'object') {
    for (const name of fieldNames) {
      if (Array.isArray(req.files[name]) && req.files[name].length > 0) {
        return req.files[name][0];
      }
    }
  }
  return undefined;
}

/**
 * GET /api/v1/patients/:patientId/medical-profile
 * (Also handles GET /api/v1/patients/me/medical-profile)
 */
export const getPatientMedicalProfileHandler = asyncHandler(async (req, res) => {
  const rawId = req.params.patientId;
  const patientId =
    !rawId || rawId === 'me' ? Number(req.user.userId) : Number(rawId);

  if (!Number.isInteger(patientId) || patientId <= 0) {
    throw new AppError(400, 'INVALID_PATIENT_ID', 'patientId must be a positive integer.');
  }

  const profile = await getPatientMedicalProfile(patientId, req.user, req.lang || 'ar');
  return sendSuccess(res, profile);
});

/**
 * PUT /api/v1/patients/me/medical-profile
 */
export const updateMyMedicalProfileHandler = asyncHandler(async (req, res) => {
  const rawPayload = extractMultipartOrJsonPayload(req);
  const validated = updateMedicalProfileSchema.parse(rawPayload);
  const uploadedFile = pickUploadedFile(req, ['medicalDocument', 'file']);

  const updatedProfile = await updateMyMedicalProfile(
    req.user.userId,
    validated,
    uploadedFile,
    req
  );
  return sendSuccess(res, updatedProfile);
});

/**
 * POST /api/v1/patients/me/medical-documents
 */
export const uploadMyMedicalDocumentHandler = asyncHandler(async (req, res) => {
  const rawMeta = extractMultipartOrJsonPayload(req);
  const validatedMeta = uploadMedicalDocumentMetaSchema.parse(rawMeta);
  const uploadedFile = pickUploadedFile(req, ['medicalDocument', 'file']);

  const doc = await uploadMyMedicalDocument(
    req.user.userId,
    uploadedFile,
    validatedMeta,
    req
  );
  return sendSuccess(res, doc, 201);
});
