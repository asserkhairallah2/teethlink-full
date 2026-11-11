-- =============================================================================
-- TeethLink: Full Relational System Database Schema (sql/full_system_schema.sql)
-- Complete 24-Entity Schema matching Refrences/schema (1).png & Chen ERDs:
--   1. Accounts & Profiles (Users, Supervisors, Students, Patients)
--   2. Medical Profile & Risk Flags (Conditions, Medications, Allergies)
--   3. Clinical Services & Student Permissions
--   4. Cases, Routing & Problem Photos
--   5. Appointments, Matching & Calendar
--   6. Completion Reports, Before/After Photos, Portfolio Posts
--   7. Patient Ratings & Reviews
--   8. System Notifications & Audit Logs
--   9. Clinical Beds & Operating Sessions
-- =============================================================================

BEGIN;

CREATE EXTENSION IF NOT EXISTS citext;
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 1. Enums
-- -----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('PATIENT', 'DOCTOR', 'SUPERVISOR', 'ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_status AS ENUM ('PENDING_APPROVAL', 'ACTIVE', 'REJECTED', 'SUSPENDED', 'DEACTIVATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE case_status AS ENUM (
    'WAITING_FOR_DOCTOR',   -- معروضة للطلبة المؤهلين
    'AWAITING_SUPERVISOR', -- استلمها الطالب وتنتظر مراجعة المشرف
    'RESERVED',             -- وافق المشرف، وتم حجز الحالة للطالب لاقتراح موعد
    'CONFIRMED',            -- أكد المريض الموعد المقترح
    'IN_TREATMENT',         -- جاري العلاج
    'AWAITING_REVIEW',      -- انتهى العلاج وتنتظر مراجعة التقرير
    'COMPLETED',            -- مكتملة ومعتمدة
    'NEEDS_FOLLOW_UP',      -- تحتاج متابعة لاحقة
    'CANCELLED',            -- ملغاة
    'REJECTED'              -- مرفوضة
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE supervisor_decision AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'REVISION_REQUESTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE patient_appointment_response AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'ALTERNATIVE_REQUESTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE photo_type AS ENUM ('BEFORE', 'AFTER', 'INTRAORAL', 'RADIOGRAPH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE risk_severity AS ENUM ('INFO', 'CAUTION', 'HIGH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- -----------------------------------------------------------------------------
-- 2. Core Accounts & Profiles Cluster
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id          BIGSERIAL PRIMARY KEY,
  email            CITEXT UNIQUE,
  phone            VARCHAR(20) NOT NULL,
  password_hash    VARCHAR(255) NOT NULL,
  full_name        VARCHAR(120) NOT NULL,
  role             user_role NOT NULL,
  account_status   account_status NOT NULL DEFAULT 'PENDING_APPROVAL',
  rejection_reason TEXT,
  approved_by      BIGINT REFERENCES users(user_id),
  approved_at      TIMESTAMPTZ,
  token_version    INTEGER NOT NULL DEFAULT 0,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Supervisors (1:0..1 to users)
CREATE TABLE IF NOT EXISTS supervisor_profiles (
  supervisor_id      BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  supervisor_code    VARCHAR(12) NOT NULL UNIQUE, -- Unique ID (e.g. 4, 7, SUP-0001)
  name               VARCHAR(120) NOT NULL,
  department         VARCHAR(120) NOT NULL,
  specialty          VARCHAR(120) NOT NULL,
  contact_info       TEXT,
  is_triage_examiner BOOLEAN NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Students (1:0..1 to users, linked to Supervisor)
CREATE TABLE IF NOT EXISTS student_doctor_profiles (
  student_id           BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  supervisor_id        BIGINT NOT NULL REFERENCES supervisor_profiles(supervisor_id),
  name                 VARCHAR(120) NOT NULL,
  age                  INTEGER,
  university           VARCHAR(120) NOT NULL DEFAULT 'Cairo University',
  college              VARCHAR(120) NOT NULL DEFAULT 'Faculty of Dentistry',
  academic_year        INTEGER NOT NULL DEFAULT 5, -- Year 4 or Year 5
  university_id_number VARCHAR(30) UNIQUE,
  photo_url            TEXT,
  id_card_url          TEXT,
  bio                  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Patients (1:0..1 to users)
CREATE TABLE IF NOT EXISTS patient_profiles (
  patient_id                 BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  full_name                  VARCHAR(120) NOT NULL,
  age                        INTEGER,
  phone                      VARCHAR(20),
  photo_url                  TEXT,
  photo_consent              BOOLEAN NOT NULL DEFAULT FALSE,
  photo_consent_updated_at   TIMESTAMPTZ,
  has_critical_condition     BOOLEAN NOT NULL DEFAULT FALSE,
  questionnaire_completed_at TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 3. Medical Profile, Conditions & Allergies Cluster
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS medical_conditions (
  condition_id BIGSERIAL PRIMARY KEY,
  name         VARCHAR(120) NOT NULL UNIQUE,
  category     VARCHAR(80) NOT NULL,
  is_active    BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS patient_conditions (
  patient_id   BIGINT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  condition_id BIGINT NOT NULL REFERENCES medical_conditions(condition_id),
  details      TEXT,
  recorded_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, condition_id)
);

CREATE TABLE IF NOT EXISTS patient_medications (
  medication_id   BIGSERIAL PRIMARY KEY,
  patient_id      BIGINT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  medication_name VARCHAR(120) NOT NULL,
  dosage          VARCHAR(80),
  notes           TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS allergies (
  allergy_id BIGSERIAL PRIMARY KEY,
  name       VARCHAR(120) NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS patient_allergies (
  patient_id BIGINT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  allergy_id BIGINT NOT NULL REFERENCES allergies(allergy_id),
  notes      TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, allergy_id)
);

-- -----------------------------------------------------------------------------
-- 4. Clinical Services & Student Service Permissions
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS services (
  service_id  BIGSERIAL PRIMARY KEY,
  name        VARCHAR(120) NOT NULL UNIQUE,
  description TEXT,
  is_active   BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS student_service_permissions (
  permission_id BIGSERIAL PRIMARY KEY,
  student_id    BIGINT NOT NULL REFERENCES student_doctor_profiles(student_id) ON DELETE CASCADE,
  service_id    BIGINT NOT NULL REFERENCES services(service_id),
  approved_by   BIGINT REFERENCES users(user_id),
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_student_service UNIQUE (student_id, service_id)
);

-- -----------------------------------------------------------------------------
-- 5. Cases, Risk Flags & Photos Cluster
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_flags (
  risk_flag_id     BIGSERIAL PRIMARY KEY,
  name             VARCHAR(80) NOT NULL UNIQUE,
  rule_description TEXT
);

CREATE TABLE IF NOT EXISTS cases (
  case_id             BIGSERIAL PRIMARY KEY,
  case_number         VARCHAR(30) NOT NULL UNIQUE, -- e.g. CASE-1042
  patient_id          BIGINT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE RESTRICT,
  service_id          BIGINT NOT NULL REFERENCES services(service_id) ON DELETE RESTRICT,
  student_id          BIGINT REFERENCES student_doctor_profiles(student_id) ON DELETE SET NULL,
  description         TEXT NOT NULL,
  preferred_time      TIMESTAMPTZ,
  preferred_location  TEXT,
  status              case_status NOT NULL DEFAULT 'WAITING_FOR_DOCTOR',
  supervisor_decision supervisor_decision NOT NULL DEFAULT 'PENDING',
  rejection_reason    TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_conditions (
  case_id      BIGINT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  condition_id BIGINT NOT NULL REFERENCES medical_conditions(condition_id),
  PRIMARY KEY (case_id, condition_id)
);

CREATE TABLE IF NOT EXISTS case_risk_flags (
  case_id      BIGINT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  risk_flag_id BIGINT NOT NULL REFERENCES risk_flags(risk_flag_id),
  PRIMARY KEY (case_id, risk_flag_id)
);

CREATE TABLE IF NOT EXISTS case_request_photos (
  request_photo_id BIGSERIAL PRIMARY KEY,
  case_id          BIGINT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  photo_url        TEXT NOT NULL,
  description      TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 6. Appointments & Student Declines
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointments (
  appointment_id    BIGSERIAL PRIMARY KEY,
  case_id           BIGINT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  student_id        BIGINT NOT NULL REFERENCES student_doctor_profiles(student_id),
  appointment_date  DATE NOT NULL,
  time_slot         TIME NOT NULL,
  place             TEXT NOT NULL DEFAULT 'Faculty of Dentistry, Clinic 3',
  patient_response  patient_appointment_response NOT NULL DEFAULT 'PENDING',
  response_deadline TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_declined_cases (
  student_id  BIGINT NOT NULL REFERENCES student_doctor_profiles(student_id) ON DELETE CASCADE,
  case_id     BIGINT NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  declined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (student_id, case_id)
);

-- -----------------------------------------------------------------------------
-- 7. Treatment Completion Reports, Photos & Portfolio Posts
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS completion_reports (
  report_id           BIGSERIAL PRIMARY KEY,
  case_id             BIGINT NOT NULL UNIQUE REFERENCES cases(case_id) ON DELETE CASCADE,
  visit_date          DATE NOT NULL,
  performed_service   TEXT NOT NULL,
  completion_state    TEXT NOT NULL DEFAULT 'Completed',
  needs_follow_up     BOOLEAN NOT NULL DEFAULT FALSE,
  notes               TEXT,
  supervisor_decision supervisor_decision NOT NULL DEFAULT 'PENDING',
  review_notes        TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS case_photos (
  photo_id   BIGSERIAL PRIMARY KEY,
  report_id  BIGINT NOT NULL REFERENCES completion_reports(report_id) ON DELETE CASCADE,
  photo_type photo_type NOT NULL, -- 'BEFORE', 'AFTER'
  photo_url  TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_posts (
  post_id      BIGSERIAL PRIMARY KEY,
  student_id   BIGINT NOT NULL REFERENCES student_doctor_profiles(student_id) ON DELETE CASCADE,
  case_id      BIGINT NOT NULL UNIQUE REFERENCES cases(case_id) ON DELETE CASCADE,
  description  TEXT NOT NULL,
  is_published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 8. Ratings, Notifications & Audit Logs Cluster
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ratings (
  rating_id  BIGSERIAL PRIMARY KEY,
  case_id    BIGINT NOT NULL UNIQUE REFERENCES cases(case_id) ON DELETE CASCADE,
  patient_id BIGINT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  score      INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  comment    TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id BIGSERIAL PRIMARY KEY,
  user_id         BIGINT NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  case_id         BIGINT REFERENCES cases(case_id) ON DELETE SET NULL,
  message         TEXT NOT NULL,
  is_read         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id        BIGSERIAL PRIMARY KEY,
  actor_user_id BIGINT REFERENCES users(user_id) ON DELETE SET NULL,
  action        VARCHAR(80) NOT NULL,
  entity_type   VARCHAR(60) NOT NULL,
  entity_id     BIGINT,
  details       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- -----------------------------------------------------------------------------
-- 9. Clinical Beds & Operating Sessions (Hospital Extension)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS departments (
  department_id BIGSERIAL PRIMARY KEY,
  code          VARCHAR(20) NOT NULL UNIQUE,
  name_en       VARCHAR(100) NOT NULL,
  name_ar       VARCHAR(100) NOT NULL,
  description   TEXT,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS clinic_beds (
  bed_id             BIGSERIAL PRIMARY KEY,
  department_id      BIGINT NOT NULL REFERENCES departments(department_id),
  bed_number         VARCHAR(20) NOT NULL,
  operational_status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  is_occupied        BOOLEAN NOT NULL DEFAULT FALSE,
  current_case_id    BIGINT REFERENCES cases(case_id),
  current_doctor_id  BIGINT REFERENCES users(user_id),
  occupied_at        TIMESTAMPTZ,
  CONSTRAINT uq_dept_bed UNIQUE (department_id, bed_number)
);

CREATE TABLE IF NOT EXISTS bed_tickets (
  ticket_id        BIGSERIAL PRIMARY KEY,
  bed_id           BIGINT NOT NULL REFERENCES clinic_beds(bed_id),
  case_id          BIGINT NOT NULL REFERENCES cases(case_id),
  doctor_id        BIGINT NOT NULL REFERENCES users(user_id),
  patient_id       BIGINT NOT NULL REFERENCES users(user_id),
  status           VARCHAR(20) NOT NULL DEFAULT 'RESERVED',
  service_date     DATE NOT NULL,
  planned_start_at TIMESTAMPTZ NOT NULL,
  planned_end_at   TIMESTAMPTZ NOT NULL,
  actual_start_at  TIMESTAMPTZ,
  actual_end_at    TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMIT;
