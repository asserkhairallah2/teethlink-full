import express from 'express';
import { authenticate, authorizeRoles } from '../../middlewares/auth.js';
import { multerUpload } from '../files/files.service.js';
import {
  getPatientMedicalProfileHandler,
  updateMyMedicalProfileHandler,
  uploadMyMedicalDocumentHandler,
} from './patients.controller.js';

export const patientsRouter = express.Router();

// GET /api/v1/patients/me/medical-profile
patientsRouter.get(
  '/me/medical-profile',
  authenticate,
  authorizeRoles('PATIENT'),
  getPatientMedicalProfileHandler
);

// PUT /api/v1/patients/me/medical-profile
patientsRouter.put(
  '/me/medical-profile',
  authenticate,
  authorizeRoles('PATIENT'),
  multerUpload.fields([
    { name: 'medicalDocument', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ]),
  updateMyMedicalProfileHandler
);

// POST /api/v1/patients/me/medical-documents
patientsRouter.post(
  '/me/medical-documents',
  authenticate,
  authorizeRoles('PATIENT'),
  multerUpload.fields([
    { name: 'medicalDocument', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ]),
  uploadMyMedicalDocumentHandler
);

// GET /api/v1/patients/:patientId/medical-profile
patientsRouter.get(
  '/:patientId/medical-profile',
  authenticate,
  authorizeRoles('PATIENT', 'DOCTOR', 'SUPERVISOR', 'ADMIN'),
  getPatientMedicalProfileHandler
);
