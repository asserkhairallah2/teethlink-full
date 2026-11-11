-- =============================================================================
-- TeethLink: Authentication & Medical Profile Schema (sql/auth_schema.sql)
-- Strictly aligned with:
--   1. Refrences/TeethLink prototype(1).html
--   2. Refrences/01_accounts_medical (1).png (Chen ERD)
--   3. Refrences/dental_matching_workflow_v3 (1).docx
--   4. Refrences/dental_requirements_and_user_stories_v3 (1).docx
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. PostgreSQL Extensions
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS citext;
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 2. Enumerated Types for Authentication & Accounts
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM (
    'PATIENT',      -- مريض: يطلب العلاج ويدخل سجله الطبي
    'DOCTOR',       -- طالب طب أسنان: يستلم الحالات وينفذها تحت إشراف مشرفه
    'SUPERVISOR',   -- مشرف أكاديمي: يعتمد الحالات ويشرف على طلبته
    'ADMIN'         -- مدير النظام: يعتمد الحسابات ويصدر أرقام المشرفين
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_status AS ENUM (
    'PENDING_APPROVAL', -- قيد انتظار اعتماد الأدمن
    'ACTIVE',           -- نشط ومعتمد
    'REJECTED',         -- مرفوض مع ذكر سبب الرفض
    'SUSPENDED',        -- موقوف مؤقتًا
    'DEACTIVATED'       -- معطل
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE gender_type AS ENUM ('MALE', 'FEMALE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE doctor_category AS ENUM (
    'UNDERGRAD_STUDENT', -- طالب جامعي (سنة رابعة أو خامسة)
    'INTERN',            -- طبيب امتياز
    'POSTGRAD',          -- دراسات عليا
    'STAFF_DOCTOR'       -- هيئة تدريس
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE availability_status AS ENUM ('AVAILABLE', 'BUSY', 'OFF_DUTY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE risk_severity AS ENUM ('INFO', 'CAUTION', 'HIGH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 3. Core Accounts Table (USERS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id           BIGSERIAL PRIMARY KEY,
  email             CITEXT UNIQUE,
  phone             VARCHAR(20) NOT NULL,
  password_hash     VARCHAR(255) NOT NULL,
  full_name         VARCHAR(120) NOT NULL,
  role              user_role NOT NULL,
  account_status    account_status NOT NULL DEFAULT 'PENDING_APPROVAL',
  rejection_reason  TEXT,
  approved_by       BIGINT REFERENCES users(user_id),
  approved_at       TIMESTAMPTZ,
  token_version     INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at        TIMESTAMPTZ,
  CONSTRAINT ck_user_phone CHECK (phone ~ '^\+?[0-9]{10,16}$')
);

CREATE INDEX IF NOT EXISTS idx_users_role_status ON users(role, account_status) WHERE deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email ON users(email) WHERE email IS NOT NULL;

-- -----------------------------------------------------------------------------
-- 4. Supervisor Profiles (SUPERVISORS)
--    Each supervisor receives a unique permanent `supervisor_code` upon admin approval
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS supervisor_profiles (
  supervisor_id      BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  supervisor_code    VARCHAR(12) NOT NULL UNIQUE, -- رقم المشرف المميز مثل 4 أو 7 أو SUP-0001
  department_name    VARCHAR(120),                -- e.g. 'Oral Surgery', 'Operative Dentistry'
  title              VARCHAR(60),                 -- e.g. 'Assoc. Prof. Dr.'
  specialty          VARCHAR(120),                -- e.g. 'Oral & Maxillofacial Surgery'
  contact_info       TEXT,
  is_triage_examiner BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 5. Student Doctor Profiles (STUDENTS)
--    Mandatory linking to `supervisor_id` (FR-12 & FR-14)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS student_doctor_profiles (
  doctor_id            BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  doctor_category      doctor_category NOT NULL DEFAULT 'UNDERGRAD_STUDENT',
  university_id_number VARCHAR(30) NOT NULL UNIQUE,
  university           VARCHAR(120) NOT NULL DEFAULT 'Cairo University',
  college              VARCHAR(120) NOT NULL DEFAULT 'Faculty of Dentistry',
  academic_year        SMALLINT NOT NULL DEFAULT 5, -- Year 4 or Year 5
  supervisor_id        BIGINT REFERENCES supervisor_profiles(supervisor_id),
  availability_status  availability_status NOT NULL DEFAULT 'AVAILABLE',
  max_active_cases     SMALLINT NOT NULL DEFAULT 5,
  photo_url            TEXT,
  id_card_url          TEXT,
  bio                  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_student_year CHECK (academic_year BETWEEN 1 AND 7)
);

CREATE INDEX IF NOT EXISTS idx_students_supervisor ON student_doctor_profiles(supervisor_id);

-- -----------------------------------------------------------------------------
-- 6. Patient Profiles & Photo Consent (PATIENTS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patient_profiles (
  patient_id                 BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  full_name                  VARCHAR(120),
  age                        SMALLINT,
  date_of_birth              DATE,
  gender                     gender_type,
  address_area               VARCHAR(120),
  photo_url                  TEXT,
  photo_consent              BOOLEAN NOT NULL DEFAULT FALSE, -- موافقة عرض صور قبل وبعد على بروفايل الطالب
  photo_consent_updated_at   TIMESTAMPTZ,
  has_critical_condition     BOOLEAN NOT NULL DEFAULT FALSE,
  questionnaire_completed_at TIMESTAMPTZ,
  medical_notes              TEXT,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 7. Medical Questionnaire Catalog (CONDITION CATALOG)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS medical_conditions (
  condition_id             BIGSERIAL PRIMARY KEY,
  code                     VARCHAR(50) NOT NULL UNIQUE,
  category                 VARCHAR(80) NOT NULL, -- 'Cardiovascular', 'Endocrine', etc.
  name_en                  VARCHAR(150) NOT NULL,
  name_ar                  VARCHAR(150) NOT NULL,
  question_text_en         TEXT NOT NULL,
  question_text_ar         TEXT NOT NULL,
  is_critical              BOOLEAN NOT NULL DEFAULT FALSE,
  requires_document_if_yes BOOLEAN NOT NULL DEFAULT FALSE,
  risk_severity            risk_severity NOT NULL DEFAULT 'INFO',
  is_active                BOOLEAN NOT NULL DEFAULT TRUE,
  display_order            SMALLINT NOT NULL DEFAULT 100
);

-- -----------------------------------------------------------------------------
-- 8. Patient Conditions Responses (PATIENT CONDITIONS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patient_conditions (
  patient_condition_id BIGSERIAL PRIMARY KEY,
  patient_id           BIGINT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  condition_id         BIGINT NOT NULL REFERENCES medical_conditions(condition_id),
  has_condition        BOOLEAN NOT NULL DEFAULT TRUE,
  details              TEXT, -- e.g. 'Type 2, last HbA1c 6.8, regular on Metformin'
  recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_patient_condition UNIQUE (patient_id, condition_id)
);

CREATE INDEX IF NOT EXISTS idx_pc_patient ON patient_conditions(patient_id);

-- -----------------------------------------------------------------------------
-- 9. Patient Current Medications (MEDICATIONS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patient_medications (
  medication_id   BIGSERIAL PRIMARY KEY,
  patient_id      BIGINT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  medication_name VARCHAR(120) NOT NULL, -- e.g. 'Metformin', 'Warfarin', 'Aspirin'
  dosage          VARCHAR(80),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pmed_patient ON patient_medications(patient_id);

-- -----------------------------------------------------------------------------
-- 10. Allergies Catalog (ALLERGIES CATALOG)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS allergies (
  allergy_id    BIGSERIAL PRIMARY KEY,
  code          VARCHAR(50) NOT NULL UNIQUE,
  name_en       VARCHAR(120) NOT NULL,
  name_ar       VARCHAR(120) NOT NULL,
  risk_severity risk_severity NOT NULL DEFAULT 'CAUTION',
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

-- -----------------------------------------------------------------------------
-- 11. Patient Allergies (PATIENT ALLERGIES)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patient_allergies (
  patient_allergy_id BIGSERIAL PRIMARY KEY,
  patient_id         BIGINT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  allergy_id         BIGINT NOT NULL REFERENCES allergies(allergy_id),
  notes              TEXT,
  diagnosed_at       DATE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_patient_allergy UNIQUE (patient_id, allergy_id)
);

CREATE INDEX IF NOT EXISTS idx_pallergy_patient ON patient_allergies(patient_id);

-- -----------------------------------------------------------------------------
-- 12. Student Service Permissions (STUDENT SERVICE PERMISSIONS)
--     Determines which dental services a student is permitted to take
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS doctor_service_permissions (
  permission_id BIGSERIAL PRIMARY KEY,
  doctor_id     BIGINT NOT NULL REFERENCES student_doctor_profiles(doctor_id) ON DELETE CASCADE,
  service_id    BIGINT NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  granted_by    BIGINT REFERENCES users(user_id),
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  notes         TEXT,
  CONSTRAINT uq_doc_svc_perm UNIQUE (doctor_id, service_id)
);

CREATE INDEX IF NOT EXISTS idx_dsp_doctor ON doctor_service_permissions(doctor_id);

-- -----------------------------------------------------------------------------
-- 13. Refresh Tokens & JWT Session Revocation
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_id   BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256
  is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rt_user ON refresh_tokens(user_id);
CREATE INDEX IF NOT EXISTS idx_rt_hash ON refresh_tokens(token_hash);

-- -----------------------------------------------------------------------------
-- 14. System Audit Log (AUDIT LOGS)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  log_id        BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(user_id),
  action        VARCHAR(80) NOT NULL,      -- 'APPROVE_ACCOUNT', 'REJECT_ACCOUNT', etc.
  entity_type   VARCHAR(60) NOT NULL,      -- 'USER', 'STUDENT_PROFILE', etc.
  entity_id     BIGINT,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_actor ON audit_logs(actor_user_id);

COMMIT;
