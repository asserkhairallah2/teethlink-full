-- =============================================================================
-- TeethLink — Complete PostgreSQL 15+ Schema (sql/001_schema.sql)
-- Strictly aligned with BACKEND_SYSTEM_PLAN_2.md
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 2.1 Extensions, Sequences & Enum Types
-- -----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS citext;
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS pgcrypto;
EXCEPTION WHEN OTHERS THEN NULL; END $$;

CREATE SEQUENCE IF NOT EXISTS case_number_seq      START 1000;
CREATE SEQUENCE IF NOT EXISTS exam_booking_ref_seq START 1;

-- Accounts
DO $$ BEGIN
  CREATE TYPE user_role AS ENUM ('PATIENT','DOCTOR','SUPERVISOR','ADMIN');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_status AS ENUM ('PENDING_APPROVAL','ACTIVE','REJECTED','SUSPENDED','DEACTIVATED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE gender_type AS ENUM ('MALE','FEMALE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE doctor_category AS ENUM ('UNDERGRAD_STUDENT','INTERN','POSTGRAD','STAFF_DOCTOR');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE availability_status AS ENUM ('AVAILABLE','BUSY','OFF_DUTY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Medical
DO $$ BEGIN
  CREATE TYPE medical_doc_status AS ENUM ('NOT_REQUIRED','UPLOADED','WILL_BRING_PHYSICALLY','VERIFIED','MISSING');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE medical_doc_type AS ENUM ('PRESCRIPTION','DIAGNOSIS_REPORT','LAB_RESULT','OTHER');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE risk_severity AS ENUM ('INFO','CAUTION','HIGH');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Files
DO $$ BEGIN
  CREATE TYPE file_purpose AS ENUM ('MEDICAL_DOCUMENT','PROFILE_PHOTO','CASE_PHOTO','CHAT_ATTACHMENT','DOCTOR_ID_PROOF');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Initial Exam
DO $$ BEGIN
  CREATE TYPE exam_slot_status AS ENUM ('AVAILABLE','HELD','BOOKED','BLOCKED','CONSUMED','EXPIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE exam_booking_status AS ENUM ('BOOKED','CHECKED_IN','EXAMINED','CANCELLED','NO_SHOW');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE exception_scope AS ENUM ('EXAM_CLINIC','DEPARTMENT','HOSPITAL');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE triage_outcome AS ENUM ('ROUTED','NO_TREATMENT_NEEDED','REFERRED_OUT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Cases
DO $$ BEGIN
  CREATE TYPE case_status AS ENUM (
    'EXAM_BOOKED','EXAM_CHECKED_IN','EXAM_NO_SHOW','TRIAGE_CLOSED',
    'WAITING_FOR_DOCTOR','CLAIMED','SCHEDULED','IN_TREATMENT',
    'AWAITING_OUTCOME','NEEDS_FOLLOW_UP','FINISHED','CANCELLED'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE case_priority AS ENUM ('ROUTINE','PRIORITY','URGENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE tooth_type AS ENUM ('INCISOR','CANINE','PREMOLAR','MOLAR','MULTIPLE','NOT_APPLICABLE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE assignment_end_reason AS ENUM ('DOCTOR_RELEASED','AUTO_RELEASED_UNSCHEDULED','ADMIN_REASSIGNED','CASE_CANCELLED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Beds / Appointments
DO $$ BEGIN
  CREATE TYPE bed_operational_status AS ENUM ('ACTIVE','OUT_OF_SERVICE','RETIRED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE appointment_path AS ENUM ('LIVE_BED','SCHEDULED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE appointment_status AS ENUM ('SCHEDULED','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW','RESCHEDULED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE session_outcome AS ENUM ('NEEDS_FOLLOW_UP','FINISHED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bed_ticket_type AS ENUM ('LIVE','SCHEDULED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bed_ticket_status AS ENUM ('RESERVED','OCCUPIED','FREED','CANCELLED','NO_SHOW');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE bed_free_reason AS ENUM ('DOCTOR_FINISHED','ADMIN_FORCED','AUTO_END_OF_DAY');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Documentation / Communication
DO $$ BEGIN
  CREATE TYPE photo_type AS ENUM ('BEFORE','AFTER','DURING','XRAY','TRIAGE');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE review_status AS ENUM ('NOT_REQUIRED','PENDING','APPROVED','REVISION_REQUESTED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE conversation_status AS ENUM ('OPEN','READ_ONLY','CLOSED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE message_type AS ENUM ('TEXT','IMAGE','FILE','SYSTEM','CALL_EVENT');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE call_type AS ENUM ('PHONE_DIAL','VOIP');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE call_status AS ENUM ('INITIATED','RINGING','ANSWERED','MISSED','DECLINED','ENDED');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- -----------------------------------------------------------------------------
-- 2.2 Accounts, Files & Profiles
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  user_id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  role                  user_role      NOT NULL,
  full_name             VARCHAR(120)   NOT NULL,
  phone                 VARCHAR(16)    NOT NULL,
  email                 CITEXT,
  password_hash         VARCHAR(255)   NOT NULL,
  account_status        account_status NOT NULL DEFAULT 'PENDING_APPROVAL',
  rejection_reason      TEXT,
  approved_by           BIGINT REFERENCES users(user_id),
  approved_at           TIMESTAMPTZ,
  phone_verified_at     TIMESTAMPTZ,
  profile_photo_file_id BIGINT,
  preferred_language    CHAR(2)        NOT NULL DEFAULT 'ar',
  token_version         INT            NOT NULL DEFAULT 0,
  last_login_at         TIMESTAMPTZ,
  created_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ    NOT NULL DEFAULT now(),
  deleted_at            TIMESTAMPTZ,
  CONSTRAINT uq_users_phone         UNIQUE (phone),
  CONSTRAINT ck_users_phone_e164    CHECK (phone ~ '^\+[1-9][0-9]{7,14}$'),
  CONSTRAINT ck_users_lang          CHECK (preferred_language IN ('ar','en')),
  CONSTRAINT ck_users_reject_reason CHECK (account_status <> 'REJECTED' OR rejection_reason IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email     ON users(email) WHERE email IS NOT NULL;
CREATE INDEX IF NOT EXISTS        ix_users_role_status ON users(role, account_status);

CREATE TABLE IF NOT EXISTS files (
  file_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_user_id  BIGINT       NOT NULL REFERENCES users(user_id),
  purpose        file_purpose NOT NULL,
  storage_key    TEXT         NOT NULL UNIQUE,
  original_name  VARCHAR(255),
  mime_type      VARCHAR(100) NOT NULL,
  size_bytes     INT          NOT NULL,
  sha256         CHAR(64),
  is_private     BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ck_files_mime CHECK (mime_type IN ('image/jpeg','image/png','image/webp','image/heic','application/pdf')),
  CONSTRAINT ck_files_size CHECK (size_bytes > 0 AND size_bytes <= 10485760)
);

DO $$ BEGIN
  ALTER TABLE users
    ADD CONSTRAINT fk_users_photo FOREIGN KEY (profile_photo_file_id) REFERENCES files(file_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS departments (
  department_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code           VARCHAR(30)  NOT NULL UNIQUE,
  name_en        VARCHAR(80)  NOT NULL,
  name_ar        VARCHAR(80)  NOT NULL,
  description    TEXT,
  is_active      BOOLEAN      NOT NULL DEFAULT TRUE,
  display_order  SMALLINT     NOT NULL DEFAULT 0,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS services (
  service_id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id       BIGINT       NOT NULL REFERENCES departments(department_id),
  code                VARCHAR(40)  NOT NULL UNIQUE,
  name_en             VARCHAR(100) NOT NULL,
  name_ar             VARCHAR(100) NOT NULL,
  description         TEXT,
  requires_permission BOOLEAN      NOT NULL DEFAULT FALSE,
  min_academic_year   SMALLINT,
  typical_sessions    SMALLINT     NOT NULL DEFAULT 1,
  is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT uq_services_dept_pair UNIQUE (service_id, department_id),
  CONSTRAINT uq_services_dept_name UNIQUE (department_id, name_en),
  CONSTRAINT ck_services_year      CHECK (min_academic_year IS NULL OR min_academic_year BETWEEN 1 AND 7),
  CONSTRAINT ck_services_sessions  CHECK (typical_sessions BETWEEN 1 AND 20)
);

CREATE TABLE IF NOT EXISTS supervisor_profiles (
  supervisor_id      BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  supervisor_code    VARCHAR(12) NOT NULL UNIQUE,
  department_id      BIGINT REFERENCES departments(department_id),
  title              VARCHAR(60),
  specialty          VARCHAR(120),
  is_triage_examiner BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS student_doctor_profiles (
  doctor_id            BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  doctor_category      doctor_category     NOT NULL DEFAULT 'UNDERGRAD_STUDENT',
  university_id_number VARCHAR(30)         NOT NULL UNIQUE,
  university           VARCHAR(120),
  college              VARCHAR(120),
  academic_year        SMALLINT,
  supervisor_id        BIGINT REFERENCES supervisor_profiles(supervisor_id),
  availability_status  availability_status NOT NULL DEFAULT 'AVAILABLE',
  max_active_cases     SMALLINT            NOT NULL DEFAULT 5,
  id_proof_file_id     BIGINT REFERENCES files(file_id),
  bio                  TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_doc_year     CHECK (academic_year IS NULL OR academic_year BETWEEN 1 AND 7),
  CONSTRAINT ck_doc_max_case CHECK (max_active_cases BETWEEN 1 AND 30)
);

CREATE TABLE IF NOT EXISTS doctor_departments (
  doctor_id     BIGINT      NOT NULL REFERENCES student_doctor_profiles(doctor_id) ON DELETE CASCADE,
  department_id BIGINT      NOT NULL REFERENCES departments(department_id),
  is_primary    BOOLEAN     NOT NULL DEFAULT FALSE,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  assigned_by   BIGINT      REFERENCES users(user_id),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doctor_id, department_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_doctor_primary_department ON doctor_departments(doctor_id) WHERE is_primary;
CREATE INDEX IF NOT EXISTS        ix_doctor_departments_dept   ON doctor_departments(department_id) WHERE is_active;

CREATE TABLE IF NOT EXISTS doctor_service_permissions (
  permission_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doctor_id     BIGINT      NOT NULL REFERENCES student_doctor_profiles(doctor_id) ON DELETE CASCADE,
  service_id    BIGINT      NOT NULL REFERENCES services(service_id),
  granted_by    BIGINT      NOT NULL REFERENCES users(user_id),
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  granted_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_at    TIMESTAMPTZ,
  CONSTRAINT uq_doctor_service UNIQUE (doctor_id, service_id),
  CONSTRAINT ck_perm_revoked   CHECK (is_active OR revoked_at IS NOT NULL)
);


-- -----------------------------------------------------------------------------
-- 2.3 Medical Questionnaire, Documents & Risk Flags
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS risk_flags (
  risk_flag_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code             VARCHAR(40)   NOT NULL UNIQUE,
  name_en          VARCHAR(80)   NOT NULL,
  name_ar          VARCHAR(80)   NOT NULL,
  severity         risk_severity NOT NULL DEFAULT 'CAUTION',
  rule_description TEXT,
  is_active        BOOLEAN       NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS medical_conditions (
  condition_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code                     VARCHAR(40)  NOT NULL UNIQUE,
  category                 VARCHAR(60)  NOT NULL,
  name_en                  VARCHAR(100) NOT NULL,
  name_ar                  VARCHAR(100) NOT NULL,
  question_text_en         TEXT         NOT NULL,
  question_text_ar         TEXT         NOT NULL,
  is_critical              BOOLEAN      NOT NULL DEFAULT FALSE,
  requires_document_if_yes BOOLEAN      NOT NULL DEFAULT FALSE,
  checklist_options        JSONB        NOT NULL DEFAULT '[]',
  risk_flag_id             BIGINT REFERENCES risk_flags(risk_flag_id),
  is_sensitive             BOOLEAN      NOT NULL DEFAULT FALSE,
  applies_to_gender        gender_type,
  display_order            SMALLINT     NOT NULL DEFAULT 0,
  is_active                BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT ck_mc_checklist_array CHECK (jsonb_typeof(checklist_options) = 'array')
);

CREATE TABLE IF NOT EXISTS allergies (
  allergy_id   BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code         VARCHAR(40)  NOT NULL UNIQUE,
  name_en      VARCHAR(100) NOT NULL,
  name_ar      VARCHAR(100) NOT NULL,
  risk_flag_id BIGINT REFERENCES risk_flags(risk_flag_id),
  is_active    BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS patient_profiles (
  patient_id                 BIGINT PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  date_of_birth              DATE,
  gender                     gender_type,
  national_id                VARCHAR(14) UNIQUE,
  address_area               VARCHAR(120),
  emergency_contact_phone    VARCHAR(16),
  questionnaire_completed_at TIMESTAMPTZ,
  has_critical_condition     BOOLEAN            NOT NULL DEFAULT FALSE,
  medical_document_status    medical_doc_status NOT NULL DEFAULT 'NOT_REQUIRED',
  medical_attachment_url     TEXT,
  latest_medical_document_id BIGINT,
  medical_notes              TEXT,
  photo_consent              BOOLEAN            NOT NULL DEFAULT FALSE,
  photo_consent_updated_at   TIMESTAMPTZ,
  data_sharing_consent_at    TIMESTAMPTZ        NOT NULL,
  no_show_count              SMALLINT           NOT NULL DEFAULT 0,
  booking_blocked_until      TIMESTAMPTZ,
  created_at                 TIMESTAMPTZ        NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ        NOT NULL DEFAULT now(),
  CONSTRAINT ck_pp_dob       CHECK (date_of_birth IS NULL OR date_of_birth BETWEEN DATE '1900-01-01' AND CURRENT_DATE),
  CONSTRAINT ck_pp_doc_state CHECK (has_critical_condition OR medical_document_status IN ('NOT_REQUIRED','UPLOADED','VERIFIED'))
);

CREATE TABLE IF NOT EXISTS patient_conditions (
  patient_id       BIGINT             NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  condition_id     BIGINT             NOT NULL REFERENCES medical_conditions(condition_id),
  has_condition    BOOLEAN            NOT NULL,
  selected_options JSONB              NOT NULL DEFAULT '[]',
  details          TEXT,
  document_status  medical_doc_status NOT NULL DEFAULT 'NOT_REQUIRED',
  answered_at      TIMESTAMPTZ        NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ        NOT NULL DEFAULT now(),
  PRIMARY KEY (patient_id, condition_id),
  CONSTRAINT ck_pc_no_doc_when_no CHECK (has_condition OR document_status = 'NOT_REQUIRED'),
  CONSTRAINT ck_pc_options_array  CHECK (jsonb_typeof(selected_options) = 'array')
);
CREATE INDEX IF NOT EXISTS ix_pc_yes ON patient_conditions(patient_id) WHERE has_condition;

CREATE TABLE IF NOT EXISTS patient_medical_documents (
  document_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id     BIGINT           NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  file_id        BIGINT           NOT NULL UNIQUE REFERENCES files(file_id),
  condition_id   BIGINT           REFERENCES medical_conditions(condition_id),
  document_type  medical_doc_type NOT NULL DEFAULT 'PRESCRIPTION',
  diagnosis_date DATE,
  notes          TEXT,
  is_current     BOOLEAN          NOT NULL DEFAULT TRUE,
  verified_by    BIGINT           REFERENCES users(user_id),
  verified_at    TIMESTAMPTZ,
  uploaded_at    TIMESTAMPTZ      NOT NULL DEFAULT now(),
  CONSTRAINT ck_pmd_verified CHECK ((verified_by IS NULL) = (verified_at IS NULL))
);
CREATE INDEX IF NOT EXISTS ix_pmd_patient ON patient_medical_documents(patient_id, uploaded_at DESC);

DO $$ BEGIN
  ALTER TABLE patient_profiles
    ADD CONSTRAINT fk_pp_latest_doc FOREIGN KEY (latest_medical_document_id) REFERENCES patient_medical_documents(document_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS patient_allergies (
  patient_id BIGINT NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  allergy_id BIGINT NOT NULL REFERENCES allergies(allergy_id),
  notes      TEXT,
  PRIMARY KEY (patient_id, allergy_id)
);

CREATE TABLE IF NOT EXISTS patient_medications (
  medication_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  patient_id       BIGINT       NOT NULL REFERENCES patient_profiles(patient_id) ON DELETE CASCADE,
  medication_name  VARCHAR(120) NOT NULL,
  dosage           VARCHAR(60),
  frequency        VARCHAR(60),
  is_anticoagulant BOOLEAN      NOT NULL DEFAULT FALSE,
  notes            TEXT,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE OR REPLACE VIEW v_patient_risk_flags AS
  SELECT pc.patient_id, rf.risk_flag_id, rf.code, rf.name_en, rf.name_ar, rf.severity,
         'CONDITION'::VARCHAR(20) AS source, mc.code AS source_code
  FROM patient_conditions pc
  JOIN medical_conditions mc ON mc.condition_id = pc.condition_id
  JOIN risk_flags rf         ON rf.risk_flag_id = mc.risk_flag_id
  WHERE pc.has_condition AND rf.is_active
UNION
  SELECT pa.patient_id, rf.risk_flag_id, rf.code, rf.name_en, rf.name_ar, rf.severity,
         'ALLERGY'::VARCHAR(20) AS source, a.code AS source_code
  FROM patient_allergies pa
  JOIN allergies a   ON a.allergy_id    = pa.allergy_id
  JOIN risk_flags rf ON rf.risk_flag_id = a.risk_flag_id
  WHERE rf.is_active
UNION
  SELECT pm.patient_id, rf.risk_flag_id, rf.code, rf.name_en, rf.name_ar, rf.severity,
         'MEDICATION'::VARCHAR(20) AS source, 'ANTICOAGULANT'::VARCHAR(40) AS source_code
  FROM patient_medications pm
  JOIN risk_flags rf ON rf.code = 'ANTICOAGULANT'
  WHERE pm.is_anticoagulant AND rf.is_active;


-- -----------------------------------------------------------------------------
-- 2.4 Initial Examination Scheduling (10-Minute Slots)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS exam_schedule_templates (
  template_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  day_of_week    SMALLINT    NOT NULL,
  start_time     TIME        NOT NULL,
  end_time       TIME        NOT NULL,
  slot_minutes   SMALLINT    NOT NULL DEFAULT 10,
  stations       SMALLINT    NOT NULL DEFAULT 1,
  effective_from DATE        NOT NULL DEFAULT CURRENT_DATE,
  effective_to   DATE,
  is_active      BOOLEAN     NOT NULL DEFAULT TRUE,
  created_by     BIGINT      REFERENCES users(user_id),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_est_dow      CHECK (day_of_week BETWEEN 1 AND 7),
  CONSTRAINT ck_est_range    CHECK (end_time > start_time),
  CONSTRAINT ck_est_minutes  CHECK (slot_minutes BETWEEN 5 AND 60),
  CONSTRAINT ck_est_divides  CHECK ((EXTRACT(EPOCH FROM (end_time - start_time))::INT / 60) % slot_minutes = 0),
  CONSTRAINT ck_est_stations CHECK (stations BETWEEN 1 AND 20),
  CONSTRAINT ck_est_eff      CHECK (effective_to IS NULL OR effective_to >= effective_from)
);

CREATE TABLE IF NOT EXISTS calendar_exceptions (
  exception_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exception_date    DATE            NOT NULL,
  scope             exception_scope NOT NULL,
  department_id     BIGINT REFERENCES departments(department_id),
  is_closed         BOOLEAN         NOT NULL DEFAULT TRUE,
  custom_start_time TIME,
  custom_end_time   TIME,
  reason            VARCHAR(200),
  created_by        BIGINT REFERENCES users(user_id),
  created_at        TIMESTAMPTZ     NOT NULL DEFAULT now(),
  CONSTRAINT uq_cal_exception UNIQUE NULLS NOT DISTINCT (exception_date, scope, department_id),
  CONSTRAINT ck_cal_dept      CHECK ((scope = 'DEPARTMENT') = (department_id IS NOT NULL)),
  CONSTRAINT ck_cal_custom    CHECK (is_closed OR (custom_start_time IS NOT NULL AND custom_end_time > custom_start_time))
);

CREATE TABLE IF NOT EXISTS initial_exam_slots (
  slot_id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  exam_date          DATE             NOT NULL,
  start_time         TIME             NOT NULL,
  end_time           TIME             NOT NULL,
  station_no         SMALLINT         NOT NULL DEFAULT 1,
  starts_at          TIMESTAMPTZ      NOT NULL,
  ends_at            TIMESTAMPTZ      NOT NULL,
  status             exam_slot_status NOT NULL DEFAULT 'AVAILABLE',
  held_by_patient_id BIGINT REFERENCES patient_profiles(patient_id),
  hold_expires_at    TIMESTAMPTZ,
  blocked_reason     VARCHAR(200),
  template_id        BIGINT REFERENCES exam_schedule_templates(template_id),
  version            INT              NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ      NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ      NOT NULL DEFAULT now(),
  CONSTRAINT uq_slot_time_station UNIQUE (exam_date, start_time, station_no),
  CONSTRAINT ck_slot_range        CHECK (end_time > start_time AND ends_at > starts_at),
  CONSTRAINT ck_slot_hold         CHECK ((status = 'HELD') = (held_by_patient_id IS NOT NULL AND hold_expires_at IS NOT NULL)),
  CONSTRAINT ck_slot_blocked      CHECK (status <> 'BLOCKED' OR blocked_reason IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS        ix_slots_available          ON initial_exam_slots(exam_date, start_time) WHERE status = 'AVAILABLE';
CREATE INDEX IF NOT EXISTS        ix_slots_holds              ON initial_exam_slots(hold_expires_at)       WHERE status = 'HELD';
CREATE UNIQUE INDEX IF NOT EXISTS uq_slot_one_hold_per_patient ON initial_exam_slots(held_by_patient_id)  WHERE status = 'HELD';


-- -----------------------------------------------------------------------------
-- 2.5 Cases, Exam Bookings & Triage
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cases (
  case_id                 BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_number             VARCHAR(20)   NOT NULL UNIQUE
                          DEFAULT ('TL-' || lpad(nextval('case_number_seq')::TEXT, 7, '0')),
  patient_id              BIGINT        NOT NULL REFERENCES patient_profiles(patient_id),
  parent_case_id          BIGINT        REFERENCES cases(case_id),
  triage_id               BIGINT,
  routed_by_supervisor_id BIGINT        REFERENCES supervisor_profiles(supervisor_id),
  department_id           BIGINT        REFERENCES departments(department_id),
  service_id              BIGINT,
  tooth_numbers           SMALLINT[]    NOT NULL DEFAULT '{}',
  tooth_type              tooth_type,
  procedure_details       TEXT,
  triage_notes            TEXT,
  priority                case_priority NOT NULL DEFAULT 'ROUTINE',
  status                  case_status   NOT NULL DEFAULT 'EXAM_BOOKED',
  assigned_doctor_id      BIGINT        REFERENCES student_doctor_profiles(doctor_id),
  broadcasted_at          TIMESTAMPTZ,
  claimed_at              TIMESTAMPTZ,
  finished_at             TIMESTAMPTZ,
  closed_reason           TEXT,
  medical_snapshot        JSONB,
  total_sessions          SMALLINT      NOT NULL DEFAULT 0,
  escalation_level        SMALLINT      NOT NULL DEFAULT 0,
  version                 INT           NOT NULL DEFAULT 0,
  created_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT fk_cases_service_in_dept FOREIGN KEY (service_id, department_id)
    REFERENCES services(service_id, department_id),
  CONSTRAINT ck_cases_routing_fields CHECK (
    status IN ('EXAM_BOOKED','EXAM_CHECKED_IN','EXAM_NO_SHOW','TRIAGE_CLOSED','CANCELLED')
    OR (department_id IS NOT NULL AND broadcasted_at IS NOT NULL)
  ),
  CONSTRAINT ck_cases_doctor_required CHECK (
    status NOT IN ('CLAIMED','SCHEDULED','IN_TREATMENT','AWAITING_OUTCOME','NEEDS_FOLLOW_UP','FINISHED')
    OR (assigned_doctor_id IS NOT NULL AND claimed_at IS NOT NULL)
  ),
  CONSTRAINT ck_cases_waiting_unassigned CHECK (status <> 'WAITING_FOR_DOCTOR' OR assigned_doctor_id IS NULL),
  CONSTRAINT ck_cases_finished_at        CHECK (status <> 'FINISHED' OR finished_at IS NOT NULL),
  CONSTRAINT ck_cases_no_self_parent     CHECK (parent_case_id IS NULL OR parent_case_id <> case_id),
  CONSTRAINT ck_cases_fdi CHECK (tooth_numbers <@ ARRAY[
      11,12,13,14,15,16,17,18, 21,22,23,24,25,26,27,28,
      31,32,33,34,35,36,37,38, 41,42,43,44,45,46,47,48,
      51,52,53,54,55, 61,62,63,64,65, 71,72,73,74,75, 81,82,83,84,85]::SMALLINT[])
);
CREATE INDEX IF NOT EXISTS ix_cases_feed          ON cases(department_id, priority DESC, broadcasted_at) WHERE status = 'WAITING_FOR_DOCTOR';
CREATE INDEX IF NOT EXISTS ix_cases_doctor_active ON cases(assigned_doctor_id, status) WHERE status IN ('CLAIMED','SCHEDULED','IN_TREATMENT','AWAITING_OUTCOME','NEEDS_FOLLOW_UP');
CREATE INDEX IF NOT EXISTS ix_cases_patient       ON cases(patient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_cases_parent        ON cases(parent_case_id) WHERE parent_case_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS initial_exam_bookings (
  booking_id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_ref                 VARCHAR(20)         NOT NULL UNIQUE
                              DEFAULT ('EX-' || lpad(nextval('exam_booking_ref_seq')::TEXT, 7, '0')),
  slot_id                     BIGINT              NOT NULL REFERENCES initial_exam_slots(slot_id),
  patient_id                  BIGINT              NOT NULL REFERENCES patient_profiles(patient_id),
  case_id                     BIGINT              NOT NULL REFERENCES cases(case_id),
  status                      exam_booking_status NOT NULL DEFAULT 'BOOKED',
  rescheduled_from_booking_id BIGINT              REFERENCES initial_exam_bookings(booking_id),
  booked_at                   TIMESTAMPTZ         NOT NULL DEFAULT now(),
  checked_in_at               TIMESTAMPTZ,
  checked_in_by               BIGINT              REFERENCES users(user_id),
  examined_at                 TIMESTAMPTZ,
  cancelled_at                TIMESTAMPTZ,
  cancel_reason               VARCHAR(200),
  cancelled_by                BIGINT              REFERENCES users(user_id),
  no_show_at                  TIMESTAMPTZ,
  idempotency_key             UUID,
  created_at                  TIMESTAMPTZ         NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ         NOT NULL DEFAULT now(),
  CONSTRAINT ck_eb_checkin CHECK (status NOT IN ('CHECKED_IN','EXAMINED') OR checked_in_at IS NOT NULL),
  CONSTRAINT ck_eb_cancel  CHECK (status <> 'CANCELLED' OR cancelled_at IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_booking_slot_active    ON initial_exam_bookings(slot_id)    WHERE status IN ('BOOKED','CHECKED_IN','EXAMINED');
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_booking_patient_active ON initial_exam_bookings(patient_id) WHERE status IN ('BOOKED','CHECKED_IN');
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_booking_case_active    ON initial_exam_bookings(case_id)    WHERE status IN ('BOOKED','CHECKED_IN','EXAMINED');
CREATE UNIQUE INDEX IF NOT EXISTS uq_exam_booking_idem           ON initial_exam_bookings(patient_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

CREATE TABLE IF NOT EXISTS triage_assessments (
  triage_id             BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  booking_id            BIGINT         NOT NULL UNIQUE REFERENCES initial_exam_bookings(booking_id),
  patient_id            BIGINT         NOT NULL REFERENCES patient_profiles(patient_id),
  supervisor_id         BIGINT         NOT NULL REFERENCES supervisor_profiles(supervisor_id),
  chief_complaint       TEXT,
  clinical_findings     TEXT,
  diagnosis_summary     TEXT           NOT NULL,
  outcome               triage_outcome NOT NULL,
  referral_note         TEXT,
  medical_docs_verified BOOLEAN        NOT NULL DEFAULT FALSE,
  examined_at           TIMESTAMPTZ    NOT NULL DEFAULT now(),
  CONSTRAINT ck_triage_referral CHECK (outcome <> 'REFERRED_OUT' OR referral_note IS NOT NULL)
);

DO $$ BEGIN
  ALTER TABLE cases
    ADD CONSTRAINT fk_cases_triage FOREIGN KEY (triage_id) REFERENCES triage_assessments(triage_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS case_risk_flags (
  case_id      BIGINT      NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  risk_flag_id BIGINT      NOT NULL REFERENCES risk_flags(risk_flag_id),
  snapshot_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (case_id, risk_flag_id)
);

CREATE TABLE IF NOT EXISTS case_assignments (
  assignment_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id       BIGINT      NOT NULL REFERENCES cases(case_id),
  doctor_id     BIGINT      NOT NULL REFERENCES student_doctor_profiles(doctor_id),
  assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  ended_at      TIMESTAMPTZ,
  end_reason    assignment_end_reason,
  ended_by      BIGINT      REFERENCES users(user_id),
  notes         TEXT,
  CONSTRAINT ck_ca_end CHECK ((ended_at IS NULL) = (end_reason IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_case_active_assignment ON case_assignments(case_id) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS        ix_ca_doctor              ON case_assignments(doctor_id, assigned_at DESC);

CREATE TABLE IF NOT EXISTS case_status_history (
  history_id  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id     BIGINT      NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  from_status case_status,
  to_status   case_status NOT NULL,
  changed_by  BIGINT      REFERENCES users(user_id),
  reason      TEXT,
  metadata    JSONB       NOT NULL DEFAULT '{}',
  changed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_csh_case ON case_status_history(case_id, changed_at);

CREATE TABLE IF NOT EXISTS case_status_transitions (
  from_status case_status NOT NULL,
  to_status   case_status NOT NULL,
  PRIMARY KEY (from_status, to_status)
);

CREATE TABLE IF NOT EXISTS doctor_hidden_cases (
  doctor_id BIGINT      NOT NULL REFERENCES student_doctor_profiles(doctor_id) ON DELETE CASCADE,
  case_id   BIGINT      NOT NULL REFERENCES cases(case_id) ON DELETE CASCADE,
  hidden_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (doctor_id, case_id)
);


-- -----------------------------------------------------------------------------
-- 2.6 Clinics, Beds, Periods, Appointments & Bed Tickets
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clinics (
  clinic_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  department_id BIGINT      NOT NULL REFERENCES departments(department_id),
  clinic_number VARCHAR(10) NOT NULL UNIQUE,
  name          VARCHAR(80),
  building      VARCHAR(40),
  floor         VARCHAR(10),
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clinic_beds (
  bed_id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  clinic_id             BIGINT                 NOT NULL REFERENCES clinics(clinic_id),
  bed_number            SMALLINT               NOT NULL,
  label                 VARCHAR(30)            NOT NULL UNIQUE,
  operational_status    bed_operational_status NOT NULL DEFAULT 'ACTIVE',
  out_of_service_reason VARCHAR(200),
  is_reservable         BOOLEAN                NOT NULL DEFAULT TRUE,
  version               INT                    NOT NULL DEFAULT 0,
  created_at            TIMESTAMPTZ            NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ            NOT NULL DEFAULT now(),
  CONSTRAINT uq_bed_in_clinic UNIQUE (clinic_id, bed_number),
  CONSTRAINT ck_bed_number    CHECK (bed_number > 0),
  CONSTRAINT ck_bed_oos       CHECK (operational_status <> 'OUT_OF_SERVICE' OR out_of_service_reason IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS bed_ticket_periods (
  period_id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code          VARCHAR(20) NOT NULL UNIQUE,
  name_en       VARCHAR(40) NOT NULL,
  name_ar       VARCHAR(40) NOT NULL,
  start_time    TIME        NOT NULL,
  end_time      TIME        NOT NULL,
  display_order SMALLINT    NOT NULL DEFAULT 0,
  is_active     BOOLEAN     NOT NULL DEFAULT TRUE,
  CONSTRAINT ck_period_range CHECK (end_time > start_time)
);

CREATE TABLE IF NOT EXISTS appointments (
  appointment_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id             BIGINT             NOT NULL REFERENCES cases(case_id),
  session_no          SMALLINT           NOT NULL,
  doctor_id           BIGINT             NOT NULL REFERENCES student_doctor_profiles(doctor_id),
  patient_id          BIGINT             NOT NULL REFERENCES patient_profiles(patient_id),
  department_id       BIGINT             NOT NULL REFERENCES departments(department_id),
  path                appointment_path   NOT NULL,
  appointment_date    DATE               NOT NULL,
  period_id           BIGINT             REFERENCES bed_ticket_periods(period_id),
  planned_start_at    TIMESTAMPTZ        NOT NULL,
  status              appointment_status NOT NULL DEFAULT 'SCHEDULED',
  checked_in_at       TIMESTAMPTZ,
  started_at          TIMESTAMPTZ,
  ended_at            TIMESTAMPTZ,
  outcome             session_outcome,
  procedure_performed TEXT,
  session_notes       TEXT,
  next_steps          TEXT,
  rescheduled_from_id BIGINT             REFERENCES appointments(appointment_id),
  cancel_reason       VARCHAR(200),
  created_by          BIGINT             NOT NULL REFERENCES users(user_id),
  created_at          TIMESTAMPTZ        NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ        NOT NULL DEFAULT now(),
  CONSTRAINT uq_appt_session   UNIQUE (case_id, session_no),
  CONSTRAINT ck_appt_period    CHECK (path <> 'SCHEDULED' OR period_id IS NOT NULL),
  CONSTRAINT ck_appt_started   CHECK (status <> 'IN_PROGRESS' OR started_at IS NOT NULL),
  CONSTRAINT ck_appt_completed CHECK (status <> 'COMPLETED' OR (started_at IS NOT NULL AND ended_at IS NOT NULL)),
  CONSTRAINT ck_appt_order     CHECK (ended_at IS NULL OR ended_at >= started_at),
  CONSTRAINT ck_appt_outcome   CHECK (outcome IS NULL OR status = 'COMPLETED')
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_appt_one_open_per_case ON appointments(case_id) WHERE status IN ('SCHEDULED','IN_PROGRESS');
CREATE INDEX IF NOT EXISTS        ix_appt_doctor_date       ON appointments(doctor_id, appointment_date);
CREATE INDEX IF NOT EXISTS        ix_appt_patient_date      ON appointments(patient_id, appointment_date);

CREATE TABLE IF NOT EXISTS bed_tickets (
  ticket_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  ticket_code         VARCHAR(32)       NOT NULL UNIQUE,
  ticket_type         bed_ticket_type   NOT NULL,
  status              bed_ticket_status NOT NULL,
  bed_id              BIGINT            NOT NULL REFERENCES clinic_beds(bed_id),
  department_id       BIGINT            NOT NULL REFERENCES departments(department_id),
  appointment_id      BIGINT            NOT NULL REFERENCES appointments(appointment_id),
  case_id             BIGINT            NOT NULL REFERENCES cases(case_id),
  doctor_id           BIGINT            NOT NULL REFERENCES student_doctor_profiles(doctor_id),
  patient_id          BIGINT            NOT NULL REFERENCES patient_profiles(patient_id),
  service_date        DATE              NOT NULL,
  period_id           BIGINT            REFERENCES bed_ticket_periods(period_id),
  planned_start_at    TIMESTAMPTZ       NOT NULL,
  reserved_at         TIMESTAMPTZ,
  occupied_at         TIMESTAMPTZ,
  freed_at            TIMESTAMPTZ,
  freed_by            BIGINT            REFERENCES users(user_id),
  free_reason         bed_free_reason,
  cancelled_at        TIMESTAMPTZ,
  cancel_reason       VARCHAR(200),
  swapped_from_bed_id BIGINT            REFERENCES clinic_beds(bed_id),
  created_by          BIGINT            NOT NULL REFERENCES users(user_id),
  version             INT               NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ       NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ       NOT NULL DEFAULT now(),
  CONSTRAINT ck_bt_live_never_reserved CHECK (ticket_type = 'SCHEDULED' OR status IN ('OCCUPIED','FREED','CANCELLED')),
  CONSTRAINT ck_bt_sched_period        CHECK (ticket_type <> 'SCHEDULED' OR period_id IS NOT NULL),
  CONSTRAINT ck_bt_reserved_at         CHECK (status <> 'RESERVED' OR reserved_at IS NOT NULL),
  CONSTRAINT ck_bt_occupied_at         CHECK (status <> 'OCCUPIED' OR (occupied_at IS NOT NULL AND freed_at IS NULL)),
  CONSTRAINT ck_bt_freed               CHECK (status <> 'FREED' OR (occupied_at IS NOT NULL AND freed_at >= occupied_at AND free_reason IS NOT NULL)),
  CONSTRAINT ck_bt_cancelled           CHECK (status NOT IN ('CANCELLED','NO_SHOW') OR cancelled_at IS NOT NULL)
);

-- ===== ZERO DOUBLE-BOOKING GUARANTEES (partial unique indexes) =====
-- 1) A physical bed has at most ONE occupant right now (open-ended live occupancy)
CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_bed_occupied          ON bed_tickets(bed_id)                          WHERE status = 'OCCUPIED';
-- 2) A bed can be reserved only once per date + period (future "ticket")
CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_bed_period_reserved   ON bed_tickets(bed_id, service_date, period_id) WHERE status = 'RESERVED';
-- 3) A case / an appointment holds at most one active ticket
CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_case_active           ON bed_tickets(case_id)        WHERE status IN ('RESERVED','OCCUPIED');
CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_appt_active           ON bed_tickets(appointment_id) WHERE status IN ('RESERVED','OCCUPIED');
-- 4) A doctor treats one patient at a time; a patient sits on one bed at a time
CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_doctor_occupied       ON bed_tickets(doctor_id)  WHERE status = 'OCCUPIED';
CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_patient_occupied      ON bed_tickets(patient_id) WHERE status = 'OCCUPIED';
-- 5) A doctor / patient cannot book two reservations at the exact same timestamp,
--    but CAN schedule multiple cases at different times within the same period (e.g., 09:00 and 10:30)
CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_doctor_planned_start  ON bed_tickets(doctor_id,  planned_start_at) WHERE status = 'RESERVED';
CREATE UNIQUE INDEX IF NOT EXISTS uq_bt_patient_planned_start ON bed_tickets(patient_id, planned_start_at) WHERE status = 'RESERVED';

-- Query support indexes
CREATE INDEX IF NOT EXISTS ix_bt_dept_date      ON bed_tickets(department_id, service_date, period_id) WHERE status IN ('RESERVED','OCCUPIED');
CREATE INDEX IF NOT EXISTS ix_bt_reserved_due   ON bed_tickets(planned_start_at) WHERE status = 'RESERVED';
CREATE INDEX IF NOT EXISTS ix_bt_occupied_since ON bed_tickets(occupied_at)      WHERE status = 'OCCUPIED';
CREATE INDEX IF NOT EXISTS ix_bt_report         ON bed_tickets(service_date, department_id);

-- Live board view (derived bed state with 30-min WINDOW reservation protection)
CREATE OR REPLACE VIEW v_bed_live_board AS
SELECT b.bed_id, b.label, b.bed_number, c.clinic_id, c.clinic_number, c.department_id, b.operational_status,
       occ.ticket_id AS occupied_ticket_id, occ.occupied_at, occ.doctor_id AS occupied_by_doctor_id,
       occ.patient_id AS occupied_patient_id, occ.case_id AS occupied_case_id,
       res.ticket_id AS upcoming_reserved_ticket_id, res.planned_start_at AS reserved_planned_start_at,
       next_res.planned_start_at AS next_reservation_at,
       CASE WHEN b.operational_status <> 'ACTIVE' THEN 'OUT_OF_SERVICE'
            WHEN occ.ticket_id IS NOT NULL       THEN 'OCCUPIED'
            WHEN res.ticket_id IS NOT NULL       THEN 'RESERVED_WINDOW_ACTIVE'
            ELSE 'FREE' END AS live_status
FROM clinic_beds b
JOIN clinics c ON c.clinic_id = b.clinic_id
LEFT JOIN bed_tickets occ ON occ.bed_id = b.bed_id AND occ.status = 'OCCUPIED'
LEFT JOIN LATERAL (
  SELECT bt.ticket_id, bt.planned_start_at
  FROM bed_tickets bt
  WHERE bt.bed_id = b.bed_id
    AND bt.status = 'RESERVED'
    AND bt.service_date = CURRENT_DATE
    AND now() >= (bt.planned_start_at - INTERVAL '30 minutes')
  ORDER BY bt.planned_start_at ASC
  LIMIT 1
) res ON TRUE
LEFT JOIN LATERAL (
  SELECT bt2.planned_start_at
  FROM bed_tickets bt2
  WHERE bt2.bed_id = b.bed_id
    AND bt2.status = 'RESERVED'
    AND bt2.service_date = CURRENT_DATE
  ORDER BY bt2.planned_start_at ASC
  LIMIT 1
) next_res ON TRUE
WHERE b.operational_status <> 'RETIRED';


-- -----------------------------------------------------------------------------
-- 2.7 Communication (Doctor–Patient Chat & Calls)
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS chat_conversations (
  conversation_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id                      BIGINT              NOT NULL REFERENCES cases(case_id),
  patient_id                   BIGINT              NOT NULL REFERENCES patient_profiles(patient_id),
  doctor_id                    BIGINT              NOT NULL REFERENCES student_doctor_profiles(doctor_id),
  status                       conversation_status NOT NULL DEFAULT 'OPEN',
  opened_at                    TIMESTAMPTZ         NOT NULL DEFAULT now(),
  read_only_at                 TIMESTAMPTZ,
  closed_at                    TIMESTAMPTZ,
  last_message_id              BIGINT,
  last_message_at              TIMESTAMPTZ,
  patient_last_read_message_id BIGINT              NOT NULL DEFAULT 0,
  doctor_last_read_message_id  BIGINT              NOT NULL DEFAULT 0,
  CONSTRAINT uq_conv_case_doctor UNIQUE (case_id, doctor_id),
  CONSTRAINT ck_conv_parties     CHECK (patient_id <> doctor_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_conv_case_open ON chat_conversations(case_id) WHERE status = 'OPEN';
CREATE INDEX IF NOT EXISTS        ix_conv_patient   ON chat_conversations(patient_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS        ix_conv_doctor    ON chat_conversations(doctor_id,  last_message_at DESC);

CREATE TABLE IF NOT EXISTS chat_messages (
  message_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id    BIGINT       NOT NULL REFERENCES chat_conversations(conversation_id) ON DELETE CASCADE,
  sender_id          BIGINT       REFERENCES users(user_id),
  message_type       message_type NOT NULL DEFAULT 'TEXT',
  body               TEXT,
  attachment_file_id BIGINT       REFERENCES files(file_id),
  client_message_id  UUID,
  metadata           JSONB        NOT NULL DEFAULT '{}',
  created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT ck_msg_body_len   CHECK (body IS NULL OR char_length(body) <= 4000),
  CONSTRAINT ck_msg_text       CHECK (message_type <> 'TEXT' OR body IS NOT NULL),
  CONSTRAINT ck_msg_attachment CHECK (message_type NOT IN ('IMAGE','FILE') OR attachment_file_id IS NOT NULL),
  CONSTRAINT ck_msg_sender     CHECK ((message_type = 'SYSTEM') = (sender_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_msg_client_id ON chat_messages(conversation_id, sender_id, client_message_id) WHERE client_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS        ix_msg_conv      ON chat_messages(conversation_id, message_id DESC);

DO $$ BEGIN
  ALTER TABLE chat_conversations
    ADD CONSTRAINT fk_conv_last_msg FOREIGN KEY (last_message_id) REFERENCES chat_messages(message_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS call_logs (
  call_id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  conversation_id BIGINT      NOT NULL REFERENCES chat_conversations(conversation_id),
  initiator_id    BIGINT      NOT NULL REFERENCES users(user_id),
  callee_id       BIGINT      NOT NULL REFERENCES users(user_id),
  call_type       call_type   NOT NULL DEFAULT 'PHONE_DIAL',
  status          call_status NOT NULL DEFAULT 'INITIATED',
  started_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  answered_at     TIMESTAMPTZ,
  ended_at        TIMESTAMPTZ,
  CONSTRAINT ck_call_parties CHECK (initiator_id <> callee_id)
);


-- -----------------------------------------------------------------------------
-- 2.8 Documentation, Ratings, Notifications, Audit & Platform
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS completion_reports (
  report_id              BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id                BIGINT        NOT NULL UNIQUE REFERENCES cases(case_id),
  doctor_id              BIGINT        NOT NULL REFERENCES student_doctor_profiles(doctor_id),
  final_diagnosis        TEXT,
  procedure_summary      TEXT          NOT NULL,
  materials_used         TEXT,
  result                 TEXT,
  total_sessions         SMALLINT      NOT NULL,
  post_care_instructions TEXT,
  review_status          review_status NOT NULL DEFAULT 'NOT_REQUIRED',
  reviewer_supervisor_id BIGINT        REFERENCES supervisor_profiles(supervisor_id),
  review_notes           TEXT,
  reviewed_at            TIMESTAMPTZ,
  created_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT ck_cr_sessions CHECK (total_sessions >= 1),
  CONSTRAINT ck_cr_review   CHECK (review_status NOT IN ('APPROVED','REVISION_REQUESTED') OR reviewed_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS case_photos (
  photo_id       BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id        BIGINT      NOT NULL REFERENCES cases(case_id),
  appointment_id BIGINT      REFERENCES appointments(appointment_id),
  report_id      BIGINT      REFERENCES completion_reports(report_id),
  file_id        BIGINT      NOT NULL UNIQUE REFERENCES files(file_id),
  photo_type     photo_type  NOT NULL,
  caption        VARCHAR(300),
  uploaded_by    BIGINT      NOT NULL REFERENCES users(user_id),
  taken_at       TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_case_photos_case ON case_photos(case_id, photo_type);

CREATE TABLE IF NOT EXISTS student_posts (
  post_id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  doctor_id              BIGINT      NOT NULL REFERENCES student_doctor_profiles(doctor_id),
  case_id                BIGINT      NOT NULL UNIQUE REFERENCES cases(case_id),
  description            TEXT        NOT NULL,
  is_published           BOOLEAN     NOT NULL DEFAULT FALSE,
  published_at           TIMESTAMPTZ,
  approved_by_supervisor BIGINT      REFERENCES supervisor_profiles(supervisor_id),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_post_published CHECK (NOT is_published OR published_at IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS student_post_photos (
  post_id  BIGINT   NOT NULL REFERENCES student_posts(post_id) ON DELETE CASCADE,
  photo_id BIGINT   NOT NULL REFERENCES case_photos(photo_id),
  position SMALLINT NOT NULL DEFAULT 0,
  PRIMARY KEY (post_id, photo_id)
);

CREATE TABLE IF NOT EXISTS ratings (
  rating_id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  case_id             BIGINT      NOT NULL UNIQUE REFERENCES cases(case_id),
  patient_id          BIGINT      NOT NULL REFERENCES patient_profiles(patient_id),
  doctor_id           BIGINT      NOT NULL REFERENCES student_doctor_profiles(doctor_id),
  score               SMALLINT    NOT NULL,
  communication_score SMALLINT,
  punctuality_score   SMALLINT,
  comment             TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ck_rating_score CHECK (
    score BETWEEN 1 AND 5
    AND (communication_score IS NULL OR communication_score BETWEEN 1 AND 5)
    AND (punctuality_score  IS NULL OR punctuality_score  BETWEEN 1 AND 5)
  )
);

CREATE TABLE IF NOT EXISTS notifications (
  notification_id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id         BIGINT       NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  type            VARCHAR(50)  NOT NULL,
  title           VARCHAR(150) NOT NULL,
  body            TEXT         NOT NULL,
  data            JSONB        NOT NULL DEFAULT '{}',
  case_id         BIGINT       REFERENCES cases(case_id),
  is_read         BOOLEAN      NOT NULL DEFAULT FALSE,
  read_at         TIMESTAMPTZ,
  push_sent_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_notif_user_unread ON notifications(user_id, created_at DESC) WHERE NOT is_read;
CREATE INDEX IF NOT EXISTS ix_notif_user        ON notifications(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS user_devices (
  device_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id      BIGINT      NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  fcm_token    TEXT        NOT NULL UNIQUE,
  platform     VARCHAR(10) NOT NULL CHECK (platform IN ('ANDROID','IOS','WEB')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_id    BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id     BIGINT      NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash  CHAR(64)    NOT NULL UNIQUE,
  family_id   UUID        NOT NULL,
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  user_agent  TEXT,
  ip_address  INET,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS phone_otps (
  otp_id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  phone       VARCHAR(16) NOT NULL,
  purpose     VARCHAR(20) NOT NULL CHECK (purpose IN ('VERIFY_PHONE','RESET_PASSWORD')),
  code_hash   CHAR(64)    NOT NULL,
  attempts    SMALLINT    NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_otp_phone ON phone_otps(phone, purpose, created_at DESC);

CREATE TABLE IF NOT EXISTS audit_logs (
  log_id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  actor_user_id BIGINT      REFERENCES users(user_id),
  actor_role    user_role,
  action        VARCHAR(60) NOT NULL,
  entity_type   VARCHAR(40) NOT NULL,
  entity_id     BIGINT,
  before_data   JSONB,
  after_data    JSONB,
  ip_address    INET,
  user_agent    TEXT,
  request_id    UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_audit_entity ON audit_logs(entity_type, entity_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_audit_actor  ON audit_logs(actor_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS system_settings (
  key         VARCHAR(60) PRIMARY KEY,
  value       JSONB       NOT NULL,
  description TEXT,
  updated_by  BIGINT      REFERENCES users(user_id),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- Database Triggers & Functions
-- -----------------------------------------------------------------------------

-- 1) Generic set_updated_at() trigger function
CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'departments', 'services', 'supervisor_profiles',
    'student_doctor_profiles', 'medical_conditions', 'patient_profiles',
    'patient_conditions', 'exam_schedule_templates', 'initial_exam_slots',
    'cases', 'initial_exam_bookings', 'clinics', 'clinic_beds',
    'appointments', 'bed_tickets', 'completion_reports',
    'student_posts', 'system_settings'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS trg_%I_set_updated_at ON %I;', t, t);
    EXECUTE format(
      'CREATE TRIGGER trg_%I_set_updated_at BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at();',
      t, t
    );
  END LOOP;
END;
$$;

-- 2) Case state-machine transition validation trigger (defense in depth)
CREATE OR REPLACE FUNCTION fn_cases_valid_transition()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.status IS DISTINCT FROM NEW.status THEN
    IF NOT EXISTS (
      SELECT 1
      FROM case_status_transitions cst
      WHERE cst.from_status = OLD.status
        AND cst.to_status   = NEW.status
    ) THEN
      RAISE EXCEPTION 'ILLEGAL_CASE_TRANSITION: cannot transition case % from % to %',
        OLD.case_id, OLD.status, NEW.status
        USING ERRCODE = 'P0001';
    END IF;

    IF NEW.version = OLD.version THEN
      NEW.version := OLD.version + 1;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cases_valid_transition ON cases;
CREATE TRIGGER trg_cases_valid_transition
BEFORE UPDATE OF status ON cases
FOR EACH ROW
EXECUTE FUNCTION fn_cases_valid_transition();

-- 3) Audit log immutability trigger (append-only enforcement)
CREATE OR REPLACE FUNCTION fn_audit_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'AUDIT_LOG_IMMUTABLE: audit_logs rows cannot be updated or deleted'
    USING ERRCODE = 'P0001';
END;
$$;

DROP TRIGGER IF EXISTS trg_audit_immutable ON audit_logs;
CREATE TRIGGER trg_audit_immutable
BEFORE UPDATE OR DELETE ON audit_logs
FOR EACH ROW
EXECUTE FUNCTION fn_audit_immutable();

COMMIT;
