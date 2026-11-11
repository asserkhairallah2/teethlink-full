import { z } from 'zod';
import { AppError } from '../../utils/errors.js';

const E164_PHONE_REGEX = /^\+[1-9][0-9]{7,14}$/;
const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Helper to parse `req.body` when a request may arrive either as `application/json`
 * or as `multipart/form-data` with a JSON-encoded `payload` field (or flat form fields).
 *
 * @param {import('express').Request} req
 * @returns {Record<string, any>}
 */
export function extractMultipartOrJsonPayload(req) {
  const body = req.body || {};

  if (typeof body.payload === 'string' && body.payload.trim().length > 0) {
    try {
      return JSON.parse(body.payload);
    } catch {
      throw new AppError(
        400,
        'INVALID_JSON_PAYLOAD',
        'Field "payload" in multipart/form-data must be valid JSON.'
      );
    }
  }

  if (body.payload && typeof body.payload === 'object') {
    return body.payload;
  }

  // Also parse nested JSON strings if form fields were sent individually
  const normalized = { ...body };
  for (const jsonKey of ['medicalQuestionnaire', 'requestedDepartmentIds', 'conditions', 'allergies', 'medications']) {
    if (typeof normalized[jsonKey] === 'string') {
      try {
        normalized[jsonKey] = JSON.parse(normalized[jsonKey]);
      } catch {
        throw new AppError(400, 'INVALID_JSON_PAYLOAD', `Field "${jsonKey}" must be valid JSON.`);
      }
    }
  }

  for (const boolKey of ['photoConsent', 'dataSharingConsent', 'isTriageExaminer']) {
    if (normalized[boolKey] === 'true') normalized[boolKey] = true;
    if (normalized[boolKey] === 'false') normalized[boolKey] = false;
  }

  if (typeof normalized.academicYear === 'string' && normalized.academicYear.trim() !== '') {
    normalized.academicYear = Number(normalized.academicYear);
  }

  return normalized;
}

export const conditionAnswerSchema = z.object({
  conditionId: z.coerce.number().int().positive(),
  hasCondition: z.boolean(),
  selectedOptions: z.array(z.string().trim().min(1)).optional().default([]),
  details: z.string().trim().max(1000).nullable().optional(),
  documentDelivery: z
    .enum(['NOT_REQUIRED', 'UPLOADED', 'WILL_BRING_PHYSICALLY'])
    .optional(),
});

export const allergyAnswerSchema = z.object({
  allergyId: z.coerce.number().int().positive(),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const medicationAnswerSchema = z.object({
  medicationName: z.string().trim().min(1).max(120),
  dosage: z.string().trim().max(60).nullable().optional(),
  frequency: z.string().trim().max(60).nullable().optional(),
  isAnticoagulant: z.boolean().optional().default(false),
  notes: z.string().trim().max(500).nullable().optional(),
});

export const medicalQuestionnaireSchema = z.object({
  conditions: z.array(conditionAnswerSchema).optional().default([]),
  allergies: z.array(allergyAnswerSchema).optional().default([]),
  medications: z.array(medicationAnswerSchema).optional().default([]),
  medicalNotes: z.string().trim().max(2000).nullable().optional(),
  documentDelivery: z
    .enum(['NOT_REQUIRED', 'UPLOADED', 'WILL_BRING_PHYSICALLY'])
    .optional(),
  documentType: z
    .enum(['PRESCRIPTION', 'DIAGNOSIS_REPORT', 'LAB_RESULT', 'OTHER'])
    .optional()
    .default('PRESCRIPTION'),
  diagnosisDate: z
    .string()
    .regex(ISO_DATE_REGEX, 'diagnosisDate must be YYYY-MM-DD')
    .nullable()
    .optional(),
  preUploadedFileId: z.coerce.number().int().positive().optional(),
});

export const registerPatientSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  phone: z
    .string()
    .trim()
    .regex(E164_PHONE_REGEX, 'Phone number must be in E.164 format (e.g. +201001234567).'),
  email: z.string().trim().email().max(120).nullable().optional(),
  password: z.string().min(8, 'Password must be at least 8 characters long.').max(128),
  preferredLanguage: z.enum(['ar', 'en']).optional().default('ar'),
  dateOfBirth: z
    .string()
    .regex(ISO_DATE_REGEX, 'dateOfBirth must be YYYY-MM-DD')
    .nullable()
    .optional(),
  gender: z.enum(['MALE', 'FEMALE']).nullable().optional(),
  nationalId: z
    .string()
    .trim()
    .regex(/^[0-9]{14}$/, 'Egyptian National ID must be 14 digits.')
    .nullable()
    .optional(),
  addressArea: z.string().trim().max(120).nullable().optional(),
  emergencyContactPhone: z
    .string()
    .trim()
    .regex(E164_PHONE_REGEX, 'Emergency contact phone must be in E.164 format.')
    .nullable()
    .optional(),
  photoConsent: z.boolean().optional().default(false),
  dataSharingConsent: z.literal(true, {
    errorMap: () => ({ message: 'dataSharingConsent must be explicitly accepted (true).' }),
  }),
  medicalQuestionnaire: medicalQuestionnaireSchema,
});

export const registerDoctorSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  phone: z
    .string()
    .trim()
    .regex(E164_PHONE_REGEX, 'Phone number must be in E.164 format (e.g. +201098765432).'),
  email: z.string().trim().email().max(120).nullable().optional(),
  password: z.string().min(8).max(128),
  preferredLanguage: z.enum(['ar', 'en']).optional().default('ar'),
  doctorCategory: z
    .enum(['UNDERGRAD_STUDENT', 'INTERN', 'POSTGRAD', 'STAFF_DOCTOR'])
    .optional()
    .default('UNDERGRAD_STUDENT'),
  universityIdNumber: z.string().trim().min(3).max(30),
  university: z.string().trim().max(120).optional().default('October 6 University'),
  college: z.string().trim().max(120).optional().default('Faculty of Dentistry'),
  academicYear: z.coerce.number().int().min(1).max(7).nullable().optional(),
  requestedDepartmentIds: z
    .array(z.coerce.number().int().positive())
    .optional()
    .default([1, 2, 4]),
  supervisorCode: z.string().trim().min(1).max(12).nullable().optional(),
  bio: z.string().trim().max(1000).nullable().optional(),
  idProofFileId: z.coerce.number().int().positive().nullable().optional(),
});

export const registerSupervisorSchema = z.object({
  fullName: z.string().trim().min(3).max(120),
  phone: z
    .string()
    .trim()
    .regex(E164_PHONE_REGEX, 'Phone number must be in E.164 format (e.g. +201000000002).'),
  email: z.string().trim().email().max(120).nullable().optional(),
  password: z.string().min(8).max(128),
  preferredLanguage: z.enum(['ar', 'en']).optional().default('ar'),
  departmentId: z.union([z.string().trim().min(1), z.number().int().positive()]).nullable().optional(),
  title: z.string().trim().max(60).nullable().optional(),
  specialty: z.string().trim().max(120).nullable().optional(),
  isTriageExaminer: z.boolean().optional().default(true),
});

export const loginSchema = z
  .object({
    phone: z.string().trim().min(3).optional(),
    identifier: z.string().trim().min(3).optional(),
    email: z.string().trim().email().optional(),
    password: z.string().min(1, 'Password is required.'),
    fcmToken: z.string().trim().min(10).max(4096).nullable().optional(),
    platform: z.enum(['ANDROID', 'IOS', 'WEB']).optional(),
  })
  .transform((val) => ({
    ...val,
    phone: val.phone || val.identifier || val.email || '',
  }))
  .refine((val) => val.phone.length >= 3, {
    path: ['phone'],
    message: 'Phone number or email address is required.',
  });

export const refreshSchema = z.object({
  refreshToken: z.string().trim().min(16, 'Valid refreshToken is required.'),
});

export const logoutSchema = z.object({
  refreshToken: z.string().trim().min(16).optional(),
  fcmToken: z.string().trim().min(10).max(4096).optional(),
  allDevices: z.boolean().optional().default(false),
});
