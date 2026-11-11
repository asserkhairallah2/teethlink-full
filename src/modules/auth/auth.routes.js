import express from 'express';
import { authenticate } from '../../middlewares/auth.js';
import { multerUpload } from '../files/files.service.js';
import {
  getQuestionnaireHandler,
  listSupervisorsHandler,
  loginHandler,
  logoutHandler,
  refreshHandler,
  registerDoctorHandler,
  registerPatientHandler,
  registerSupervisorHandler,
  verifySupervisorHandler,
} from './auth.controller.js';

export const authRouter = express.Router();
export const medicalCatalogRouter = express.Router();

// GET /api/v1/auth/supervisors/list
authRouter.get('/supervisors/list', listSupervisorsHandler);

// GET /api/v1/auth/supervisors/verify/:code
authRouter.get('/supervisors/verify/:code', verifySupervisorHandler);

// GET /api/v1/medical-catalog/questionnaire
medicalCatalogRouter.get('/questionnaire', getQuestionnaireHandler);

// POST /api/v1/auth/register/patient (multipart/form-data or application/json)
authRouter.post(
  '/register/patient',
  multerUpload.fields([
    { name: 'medicalDocument', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ]),
  registerPatientHandler
);

// POST /api/v1/auth/register/doctor (multipart/form-data or application/json)
authRouter.post(
  '/register/doctor',
  multerUpload.fields([
    { name: 'idProofDocument', maxCount: 1 },
    { name: 'file', maxCount: 1 },
  ]),
  registerDoctorHandler
);

// POST /api/v1/auth/register/supervisor
authRouter.post('/register/supervisor', registerSupervisorHandler);

// POST /api/v1/auth/login
authRouter.post('/login', loginHandler);

// POST /api/v1/auth/refresh
authRouter.post('/refresh', refreshHandler);

// POST /api/v1/auth/logout
authRouter.post('/logout', authenticate, logoutHandler);
