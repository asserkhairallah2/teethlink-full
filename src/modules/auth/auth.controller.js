import { asyncHandler, sendSuccess } from '../../utils/errors.js';
import { pool } from '../../db/pool.js';
import {
  extractMultipartOrJsonPayload,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerDoctorSchema,
  registerPatientSchema,
  registerSupervisorSchema,
} from './auth.validators.js';
import {
  getMedicalQuestionnaireCatalog,
  loginUser,
  logoutUser,
  refreshUserTokens,
  registerDoctor,
  registerPatient,
  registerSupervisor,
} from './auth.service.js';

/**
 * Resolves the first uploaded file from either `req.file` or `req.files`.
 *
 * @param {import('express').Request} req
 * @param {string[]} fieldNames
 * @returns {Express.Multer.File | undefined}
 */
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
 * GET /api/v1/medical-catalog/questionnaire
 */
export const getQuestionnaireHandler = asyncHandler(async (req, res) => {
  const lang = req.lang === 'en' ? 'en' : 'ar';
  const catalog = await getMedicalQuestionnaireCatalog(lang);
  return sendSuccess(res, catalog);
});

/**
 * POST /api/v1/auth/register/patient
 */
export const registerPatientHandler = asyncHandler(async (req, res) => {
  const rawPayload = extractMultipartOrJsonPayload(req);
  const validated = registerPatientSchema.parse(rawPayload);
  const uploadedFile = pickUploadedFile(req, ['medicalDocument', 'file']);

  const result = await registerPatient(validated, uploadedFile, req);
  return sendSuccess(res, result, 201);
});

/**
 * POST /api/v1/auth/register/doctor
 */
export const registerDoctorHandler = asyncHandler(async (req, res) => {
  const rawPayload = extractMultipartOrJsonPayload(req);
  const validated = registerDoctorSchema.parse(rawPayload);
  const idProofFile = pickUploadedFile(req, ['idProofDocument', 'file']);

  const result = await registerDoctor(validated, idProofFile, req);
  return sendSuccess(res, result, 201);
});

/**
 * POST /api/v1/auth/register/supervisor
 */
export const registerSupervisorHandler = asyncHandler(async (req, res) => {
  const rawPayload = extractMultipartOrJsonPayload(req);
  const validated = registerSupervisorSchema.parse(rawPayload);

  const result = await registerSupervisor(validated, req);
  return sendSuccess(res, result, 201);
});

/**
 * POST /api/v1/auth/login
 */
export const loginHandler = asyncHandler(async (req, res) => {
  const validated = loginSchema.parse(req.body || {});
  const result = await loginUser(validated, req);
  return sendSuccess(res, result, 200);
});

/**
 * POST /api/v1/auth/refresh
 */
export const refreshHandler = asyncHandler(async (req, res) => {
  const validated = refreshSchema.parse(req.body || {});
  const result = await refreshUserTokens(validated.refreshToken, req);
  return sendSuccess(res, result, 200);
});

/**
 * POST /api/v1/auth/logout
 */
export const logoutHandler = asyncHandler(async (req, res) => {
  const validated = logoutSchema.parse(req.body || {});
  const result = await logoutUser(req.user.userId, req.user.role, validated, req);
  return sendSuccess(res, result, 200);
});

/**
 * GET /api/v1/auth/supervisors/list
 */
export const listSupervisorsHandler = asyncHandler(async (_req, res) => {
  const { rows } = await pool.query(
    `SELECT
       sp.supervisor_id,
       sp.supervisor_code,
       u.full_name,
       sp.title,
       sp.specialty,
       d.name_en AS department_name_en,
       d.name_ar AS department_name_ar
     FROM supervisor_profiles sp
     JOIN users u ON u.user_id = sp.supervisor_id
     LEFT JOIN departments d ON d.department_id = sp.department_id
     WHERE u.account_status = 'ACTIVE' AND u.deleted_at IS NULL
     ORDER BY sp.supervisor_id ASC`
  );
  return sendSuccess(res, { supervisors: rows });
});

/**
 * GET /api/v1/auth/supervisors/verify/:code
 */
export const verifySupervisorHandler = asyncHandler(async (req, res) => {
  const code = (req.params.code || '').trim();
  const cleanUpper = code.toUpperCase();
  const { rows } = await pool.query(
    `SELECT
       sp.supervisor_id,
       sp.supervisor_code,
       u.full_name,
       sp.title,
       sp.specialty,
       d.name_en AS department_name_en,
       d.name_ar AS department_name_ar
     FROM supervisor_profiles sp
     JOIN users u ON u.user_id = sp.supervisor_id
     LEFT JOIN departments d ON d.department_id = sp.department_id
     WHERE (
       UPPER(sp.supervisor_code) = $1
       OR sp.supervisor_id::TEXT = $2
       OR UPPER(sp.supervisor_code) = ('SUP-000' || $2)
       OR UPPER(sp.supervisor_code) = ('SUP-' || $2)
       OR (UPPER(sp.supervisor_code) = 'SUP-0001' AND $2 IN ('1', '4'))
       OR (UPPER(sp.supervisor_code) = 'SUP-0002' AND $2 IN ('2', '7'))
     )
       AND u.account_status = 'ACTIVE'
       AND u.deleted_at IS NULL
     LIMIT 1`,
    [cleanUpper, code]
  );

  if (rows.length === 0) {
    return res.status(404).json({
      success: false,
      error: {
        code: 'SUPERVISOR_NOT_FOUND',
        message: `Supervisor ID "${code}" was not found or is not approved.`,
      },
    });
  }

  return sendSuccess(res, { valid: true, supervisor: rows[0] });
});
