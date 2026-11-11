-- =============================================================================
-- TeethLink — Comprehensive Demo & Dummy Data (sql/003_demo_data.sql)
-- Populates realistic users across all 4 roles, medical histories, risk flags,
-- initial exam bookings, triage assessments, InDrive waiting-list cases,
-- claimed/scheduled/occupied bed tickets, real-time chat messages,
-- completed reports, ratings, and portfolio posts.
-- =============================================================================

BEGIN;

-- Ensure future 10-minute initial exam slots exist for today + next 3 days (all 7 days of week)
INSERT INTO initial_exam_slots (
  exam_date, start_time, end_time, station_no, starts_at, ends_at, status, template_id
)
SELECT
  d::DATE AS exam_date,
  slot_ts::TIME AS start_time,
  (slot_ts + (est.slot_minutes || ' minutes')::INTERVAL)::TIME AS end_time,
  st_no::SMALLINT AS station_no,
  (slot_ts AT TIME ZONE 'Africa/Cairo') AS starts_at,
  ((slot_ts + (est.slot_minutes || ' minutes')::INTERVAL) AT TIME ZONE 'Africa/Cairo') AS ends_at,
  'AVAILABLE'::exam_slot_status AS status,
  est.template_id
FROM generate_series(CURRENT_DATE, CURRENT_DATE + INTERVAL '3 days', INTERVAL '1 day') AS d
JOIN exam_schedule_templates est
  ON est.is_active = TRUE
 AND est.day_of_week = EXTRACT(ISODOW FROM d)::SMALLINT
CROSS JOIN LATERAL generate_series(
  d::DATE + TIME '08:00:00',
  d::DATE + TIME '22:50:00',
  INTERVAL '10 minutes'
) AS slot_ts
CROSS JOIN LATERAL generate_series(1, est.stations) AS st_no
ON CONFLICT (exam_date, start_time, station_no) DO NOTHING;

-- -----------------------------------------------------------------------------
-- 1. Demo Users (Supervisors, Student Doctors, Patients)
--    Passwords:
--      Admin:      Admin@12345      ($2a$10$t9DHuS2VoK6qNHvDXtr6d.t./pP.SQHPVDqd5FiJKKBjLoS/wsjQu)
--      Supervisor: Supervisor@12345 ($2a$10$1j8VvpUpWLipx.ZEwlHlEu19VLOEghnHHC1jRMw4cX5JPHbHTcdXK)
--      Doctor:     Doctor@12345     ($2a$10$us0oQ1AW1Icf6oeTwJ57lukMD9v9EuJBfXzbs0vxhGBET9pdamN4i)
--      Patient:    Patient@12345    ($2a$10$7cxdk5nKrY59RDuSB2cSVOLOUIokEB/YLtPbamdW4ggrZXSFd4ACK)
-- -----------------------------------------------------------------------------
INSERT INTO users (
  role, full_name, phone, email, password_hash,
  account_status, approved_at, phone_verified_at, preferred_language
) VALUES
  -- Second Supervisor
  (
    'SUPERVISOR',
    'Dr. Mona Adel (Endodontics Supervisor)',
    '+201000000003',
    'mona.adel@teethlink.edu.eg',
    '$2a$10$1j8VvpUpWLipx.ZEwlHlEu19VLOEghnHHC1jRMw4cX5JPHbHTcdXK',
    'ACTIVE',
    now(),
    now(),
    'ar'
  ),
  -- Doctor 1 (ACTIVE — Senior 5th Year Student Doctor)
  (
    'DOCTOR',
    'Dr. Omar Khaled',
    '+201000000101',
    'omar.khaled@o6u.edu.eg',
    '$2a$10$us0oQ1AW1Icf6oeTwJ57lukMD9v9EuJBfXzbs0vxhGBET9pdamN4i',
    'ACTIVE',
    now(),
    now(),
    'ar'
  ),
  -- Doctor 2 (ACTIVE — Intern Doctor)
  (
    'DOCTOR',
    'Dr. Nourhan Tarek',
    '+201000000102',
    'nourhan.tarek@o6u.edu.eg',
    '$2a$10$us0oQ1AW1Icf6oeTwJ57lukMD9v9EuJBfXzbs0vxhGBET9pdamN4i',
    'ACTIVE',
    now(),
    now(),
    'ar'
  ),
  -- Doctor 3 (PENDING_APPROVAL — visible in Admin Pending Accounts Queue)
  (
    'DOCTOR',
    'Dr. Karim Mostafa',
    '+201000000103',
    'karim.mostafa@o6u.edu.eg',
    '$2a$10$us0oQ1AW1Icf6oeTwJ57lukMD9v9EuJBfXzbs0vxhGBET9pdamN4i',
    'PENDING_APPROVAL',
    NULL,
    now(),
    'ar'
  ),
  -- Patient 1 (Sara Ahmed Hassan — Diabetic & Hypertensive with uploaded prescription)
  (
    'PATIENT',
    'Sara Ahmed Hassan',
    '+201000000201',
    'sara.hassan@gmail.com',
    '$2a$10$7cxdk5nKrY59RDuSB2cSVOLOUIokEB/YLtPbamdW4ggrZXSFd4ACK',
    'ACTIVE',
    now(),
    now(),
    'ar'
  ),
  -- Patient 2 (Mahmoud Saeed — Cardiac & Anticoagulant patient)
  (
    'PATIENT',
    'Mahmoud Saeed Abdelrahman',
    '+201000000202',
    'mahmoud.saeed@gmail.com',
    '$2a$10$7cxdk5nKrY59RDuSB2cSVOLOUIokEB/YLtPbamdW4ggrZXSFd4ACK',
    'ACTIVE',
    now(),
    now(),
    'ar'
  ),
  -- Patient 3 (Fatma Ali Ibrahim — Checked in for Triage today + has 1 finished case)
  (
    'PATIENT',
    'Fatma Ali Ibrahim',
    '+201000000203',
    'fatma.ali@gmail.com',
    '$2a$10$7cxdk5nKrY59RDuSB2cSVOLOUIokEB/YLtPbamdW4ggrZXSFd4ACK',
    'ACTIVE',
    now(),
    now(),
    'ar'
  ),
  -- Patient 4 (Youssef Adel Kamal — Ready to book a new 10-minute Initial Exam slot)
  (
    'PATIENT',
    'Youssef Adel Kamal',
    '+201000000204',
    'youssef.adel@gmail.com',
    '$2a$10$7cxdk5nKrY59RDuSB2cSVOLOUIokEB/YLtPbamdW4ggrZXSFd4ACK',
    'ACTIVE',
    now(),
    now(),
    'ar'
  )
ON CONFLICT (phone) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      full_name = EXCLUDED.full_name;

-- Supervisor 2 Profile
INSERT INTO supervisor_profiles (
  supervisor_id, supervisor_code, department_id, title, specialty, is_triage_examiner
)
SELECT
  u.user_id,
  'SUP-0002',
  (SELECT department_id FROM departments WHERE code = 'ENDO'),
  'Assoc. Prof. Dr.',
  'Endodontics & Root Canal Therapy',
  TRUE
FROM users u
WHERE u.phone = '+201000000003'
ON CONFLICT (supervisor_id) DO NOTHING;

-- Student Doctor Profiles
INSERT INTO student_doctor_profiles (
  doctor_id, university_id_number, university, college, doctor_category,
  academic_year, availability_status, max_active_cases, bio
)
SELECT
  u.user_id,
  'O6U-2026-501',
  'October 6 University',
  'Faculty of Dentistry',
  'UNDERGRAD_STUDENT',
  5,
  'AVAILABLE',
  8,
  'Senior 5th-year dental student specializing in Endodontics, Restorative Dentistry, and Oral Surgery.'
FROM users u
WHERE u.phone = '+201000000101'
ON CONFLICT (doctor_id) DO NOTHING;

INSERT INTO student_doctor_profiles (
  doctor_id, university_id_number, university, college, doctor_category,
  academic_year, availability_status, max_active_cases, bio
)
SELECT
  u.user_id,
  'O6U-2026-502',
  'October 6 University',
  'Faculty of Dentistry',
  'INTERN',
  NULL,
  'AVAILABLE',
  8,
  'Dental Intern at O6U Teaching Hospital — Restorative, Prosthodontics, and Pediatric Dentistry.'
FROM users u
WHERE u.phone = '+201000000102'
ON CONFLICT (doctor_id) DO NOTHING;

INSERT INTO student_doctor_profiles (
  doctor_id, university_id_number, university, college, doctor_category,
  academic_year, availability_status, max_active_cases, bio
)
SELECT
  u.user_id,
  'O6U-2026-503',
  'October 6 University',
  'Faculty of Dentistry',
  'UNDERGRAD_STUDENT',
  4,
  'AVAILABLE',
  5,
  '4th-year dental student requesting access to Restorative and Periodontics clinics.'
FROM users u
WHERE u.phone = '+201000000103'
ON CONFLICT (doctor_id) DO NOTHING;

-- Doctor Department Memberships
INSERT INTO doctor_departments (doctor_id, department_id, is_primary, is_active, assigned_by)
SELECT
  (SELECT user_id FROM users WHERE phone = '+201000000101'),
  d.department_id,
  (d.code = 'ENDO'),
  TRUE,
  (SELECT user_id FROM users WHERE phone = '+201000000001')
FROM departments d
WHERE d.code IN ('RESTORATIVE', 'ENDO', 'PERIO', 'SURGERY')
ON CONFLICT (doctor_id, department_id) DO UPDATE SET is_active = TRUE;

INSERT INTO doctor_departments (doctor_id, department_id, is_primary, is_active, assigned_by)
SELECT
  (SELECT user_id FROM users WHERE phone = '+201000000102'),
  d.department_id,
  (d.code = 'RESTORATIVE'),
  TRUE,
  (SELECT user_id FROM users WHERE phone = '+201000000001')
FROM departments d
WHERE d.code IN ('RESTORATIVE', 'ENDO', 'PROSTHO', 'PEDO')
ON CONFLICT (doctor_id, department_id) DO UPDATE SET is_active = TRUE;

INSERT INTO doctor_departments (doctor_id, department_id, is_primary, is_active, assigned_by)
SELECT
  (SELECT user_id FROM users WHERE phone = '+201000000103'),
  d.department_id,
  (d.code = 'RESTORATIVE'),
  FALSE,
  NULL
FROM departments d
WHERE d.code IN ('RESTORATIVE', 'PERIO')
ON CONFLICT (doctor_id, department_id) DO NOTHING;

-- Grant special service permissions to Dr. Omar Khaled (+201000000101)
INSERT INTO doctor_service_permissions (doctor_id, service_id, granted_by, is_active)
SELECT
  (SELECT user_id FROM users WHERE phone = '+201000000101'),
  s.service_id,
  (SELECT user_id FROM users WHERE phone = '+201000000002'),
  TRUE
FROM services s
WHERE s.code IN ('RCT_RETREATMENT', 'SURGICAL_EXTRACTION')
ON CONFLICT (doctor_id, service_id) DO UPDATE SET is_active = TRUE;

-- -----------------------------------------------------------------------------
-- 2. Patient Profiles, Medical Conditions, Allergies, Medications & Files
-- -----------------------------------------------------------------------------

-- Demo Prescription File for Sara Ahmed Hassan
INSERT INTO files (
  owner_user_id, purpose, storage_key, original_name, mime_type, size_bytes, sha256, is_private
)
SELECT
  u.user_id,
  'MEDICAL_DOCUMENT',
  'medical/2026/11/demo-sara-prescription.pdf',
  'Sara_Diabetes_Hypertension_Report.pdf',
  'application/pdf',
  245120,
  'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  TRUE
FROM users u
WHERE u.phone = '+201000000201'
  AND NOT EXISTS (
    SELECT 1 FROM files f WHERE f.storage_key = 'medical/2026/11/demo-sara-prescription.pdf'
  );

-- Patient 1 Profile (Sara)
INSERT INTO patient_profiles (
  patient_id, national_id, date_of_birth, gender, address_area,
  emergency_contact_phone,
  has_critical_condition, medical_document_status, medical_attachment_url,
  photo_consent, photo_consent_updated_at, data_sharing_consent_at, questionnaire_completed_at
)
SELECT
  u.user_id,
  '29205142101234',
  DATE '1992-05-14',
  'FEMALE',
  '6th of October City, 4th District, Giza',
  '+201099887766',
  TRUE,
  'VERIFIED',
  '/api/v1/files/' || (SELECT file_id FROM files WHERE storage_key = 'medical/2026/11/demo-sara-prescription.pdf' LIMIT 1) || '/download',
  TRUE,
  now(),
  now(),
  now()
FROM users u
WHERE u.phone = '+201000000201'
ON CONFLICT (patient_id) DO NOTHING;

-- Patient 2 Profile (Mahmoud)
INSERT INTO patient_profiles (
  patient_id, national_id, date_of_birth, gender, address_area,
  emergency_contact_phone,
  has_critical_condition, medical_document_status, medical_attachment_url,
  photo_consent, photo_consent_updated_at, data_sharing_consent_at, questionnaire_completed_at
)
SELECT
  u.user_id,
  '26811202105678',
  DATE '1968-11-20',
  'MALE',
  'Sheikh Zayed City, Giza',
  '+201122334455',
  TRUE,
  'WILL_BRING_PHYSICALLY',
  NULL,
  TRUE,
  now(),
  now(),
  now()
FROM users u
WHERE u.phone = '+201000000202'
ON CONFLICT (patient_id) DO NOTHING;

-- Patient 3 Profile (Fatma)
INSERT INTO patient_profiles (
  patient_id, national_id, date_of_birth, gender, address_area,
  emergency_contact_phone,
  has_critical_condition, medical_document_status, medical_attachment_url,
  photo_consent, photo_consent_updated_at, data_sharing_consent_at, questionnaire_completed_at
)
SELECT
  u.user_id,
  '29908032109012',
  DATE '1999-08-03',
  'FEMALE',
  'Al-Hosary Square, 6th of October City',
  '+201233445566',
  FALSE,
  'NOT_REQUIRED',
  NULL,
  TRUE,
  now(),
  now(),
  now()
FROM users u
WHERE u.phone = '+201000000203'
ON CONFLICT (patient_id) DO NOTHING;

-- Patient 4 Profile (Youssef)
INSERT INTO patient_profiles (
  patient_id, national_id, date_of_birth, gender, address_area,
  emergency_contact_phone,
  has_critical_condition, medical_document_status, medical_attachment_url,
  photo_consent, photo_consent_updated_at, data_sharing_consent_at, questionnaire_completed_at
)
SELECT
  u.user_id,
  '30102192103456',
  DATE '2001-02-19',
  'MALE',
  'Faisal, Giza',
  '+201555667788',
  FALSE,
  'NOT_REQUIRED',
  NULL,
  TRUE,
  now(),
  now(),
  now()
FROM users u
WHERE u.phone = '+201000000204'
ON CONFLICT (patient_id) DO NOTHING;

-- Medical Conditions for Sara (Diabetes + Hypertension)
INSERT INTO patient_conditions (
  patient_id, condition_id, has_condition, selected_options, details, document_status
)
SELECT
  (SELECT user_id FROM users WHERE phone = '+201000000201'),
  mc.condition_id,
  (mc.code IN ('DIABETES', 'HYPERTENSION')),
  CASE
    WHEN mc.code = 'DIABETES' THEN '["TYPE_2","CONTROLLED"]'::jsonb
    WHEN mc.code = 'HYPERTENSION' THEN '["CONTROLLED"]'::jsonb
    ELSE '[]'::jsonb
  END,
  CASE
    WHEN mc.code = 'DIABETES' THEN 'Type 2 controlled on Metformin 1000mg; last HbA1c = 6.7%'
    WHEN mc.code = 'HYPERTENSION' THEN 'Controlled on Concor 5mg daily (BP 125/80)'
    ELSE NULL
  END,
  CASE
    WHEN mc.code IN ('DIABETES', 'HYPERTENSION') THEN 'VERIFIED'::medical_doc_status
    ELSE 'NOT_REQUIRED'::medical_doc_status
  END
FROM medical_conditions mc
WHERE mc.is_critical = TRUE
ON CONFLICT (patient_id, condition_id) DO NOTHING;

-- Allergy for Sara (Penicillin)
INSERT INTO patient_allergies (patient_id, allergy_id, notes)
SELECT
  (SELECT user_id FROM users WHERE phone = '+201000000201'),
  a.allergy_id,
  'Severe skin rash and urticaria from Amoxicillin'
FROM allergies a
WHERE a.code = 'PENICILLIN'
ON CONFLICT (patient_id, allergy_id) DO NOTHING;

-- Medical Conditions for Mahmoud (Cardiac + Anticoagulant)
INSERT INTO patient_conditions (
  patient_id, condition_id, has_condition, selected_options, details, document_status
)
SELECT
  (SELECT user_id FROM users WHERE phone = '+201000000202'),
  mc.condition_id,
  (mc.code IN ('HEART_DISEASE', 'ANTICOAGULANT_BLEEDING')),
  CASE
    WHEN mc.code = 'HEART_DISEASE' THEN '["STENT"]'::jsonb
    WHEN mc.code = 'ANTICOAGULANT_BLEEDING' THEN '["ANTIPLATELET","WARFARIN"]'::jsonb
    ELSE '[]'::jsonb
  END,
  CASE
    WHEN mc.code = 'HEART_DISEASE' THEN 'Coronary stent placed 2 years ago; stable angina'
    WHEN mc.code = 'ANTICOAGULANT_BLEEDING' THEN 'On Plavix 75mg & Aspirin 81mg; INR = 2.1'
    ELSE NULL
  END,
  CASE
    WHEN mc.code IN ('HEART_DISEASE', 'ANTICOAGULANT_BLEEDING') THEN 'WILL_BRING_PHYSICALLY'::medical_doc_status
    ELSE 'NOT_REQUIRED'::medical_doc_status
  END
FROM medical_conditions mc
WHERE mc.is_critical = TRUE
ON CONFLICT (patient_id, condition_id) DO NOTHING;

INSERT INTO patient_medications (patient_id, medication_name, dosage, frequency, is_anticoagulant, notes)
SELECT
  (SELECT user_id FROM users WHERE phone = '+201000000202'),
  'Clopidogrel (Plavix)',
  '75 mg',
  'Once daily',
  TRUE,
  'Cardiology maintenance post-stent'
WHERE NOT EXISTS (
  SELECT 1 FROM patient_medications pm
  WHERE pm.patient_id = (SELECT user_id FROM users WHERE phone = '+201000000202')
);

-- -----------------------------------------------------------------------------
-- 3. Demo Cases, Initial Exam Bookings, Triage, Feed, Beds & Chat
--    Only insert if demo cases haven't been seeded yet
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  v_admin_id      BIGINT := (SELECT user_id FROM users WHERE phone = '+201000000001');
  v_sup_hany_id   BIGINT := (SELECT user_id FROM users WHERE phone = '+201000000002');
  v_doc_omar_id   BIGINT := (SELECT user_id FROM users WHERE phone = '+201000000101');
  v_doc_nour_id   BIGINT := (SELECT user_id FROM users WHERE phone = '+201000000102');
  v_pat_sara_id   BIGINT := (SELECT user_id FROM users WHERE phone = '+201000000201');
  v_pat_mahmoud   BIGINT := (SELECT user_id FROM users WHERE phone = '+201000000202');
  v_pat_fatma_id  BIGINT := (SELECT user_id FROM users WHERE phone = '+201000000203');

  v_dept_rest     BIGINT := (SELECT department_id FROM departments WHERE code = 'RESTORATIVE');
  v_dept_endo     BIGINT := (SELECT department_id FROM departments WHERE code = 'ENDO');
  v_dept_surg     BIGINT := (SELECT department_id FROM departments WHERE code = 'SURGERY');

  v_svc_rct_molar BIGINT := (SELECT service_id FROM services WHERE code = 'RCT_MOLAR');
  v_svc_rct_prem  BIGINT := (SELECT service_id FROM services WHERE code = 'RCT_PREMOLAR');
  v_svc_fill_post BIGINT := (SELECT service_id FROM services WHERE code = 'FILLING_CLASS_I_II');
  v_svc_fill_ant  BIGINT := (SELECT service_id FROM services WHERE code = 'FILLING_ANTERIOR');
  v_svc_extr_simp BIGINT := (SELECT service_id FROM services WHERE code = 'SIMPLE_EXTRACTION');

  v_bed_c1_b01    BIGINT := (SELECT bed_id FROM clinic_beds WHERE label = 'C1-B01');
  v_bed_c1_b02    BIGINT := (SELECT bed_id FROM clinic_beds WHERE label = 'C1-B02');
  v_bed_c2_b01    BIGINT := (SELECT bed_id FROM clinic_beds WHERE label = 'C2-B01');

  v_period_morn   BIGINT := (SELECT period_id FROM bed_ticket_periods WHERE code = 'MORNING');

  v_slot_fatma    BIGINT;
  v_slot_sara     BIGINT;
  v_slot_mahmoud  BIGINT;

  v_case_triage   BIGINT;
  v_booking_fatma BIGINT;

  v_case_feed_1   BIGINT;
  v_booking_sara  BIGINT;
  v_triage_sara   BIGINT;

  v_case_feed_2   BIGINT;
  v_booking_mah   BIGINT;
  v_triage_mah    BIGINT;

  v_case_feed_3   BIGINT;
  v_case_live     BIGINT;
  v_appt_live     BIGINT;
  v_ticket_live   BIGINT;
  v_conv_live     BIGINT;
  v_msg_id        BIGINT;

  v_case_sched    BIGINT;
  v_appt_sched    BIGINT;
  v_conv_sched    BIGINT;

  v_case_fin      BIGINT;
  v_appt_fin      BIGINT;
  v_rep_fin       BIGINT;
  v_conv_fin      BIGINT;
BEGIN
  IF EXISTS (SELECT 1 FROM cases LIMIT 1) THEN
    RETURN;
  END IF;

  -- Pick 3 slots today for our demo bookings
  SELECT slot_id INTO v_slot_sara
  FROM initial_exam_slots
  WHERE exam_date = CURRENT_DATE AND station_no = 1
  ORDER BY start_time ASC
  LIMIT 1;

  SELECT slot_id INTO v_slot_mahmoud
  FROM initial_exam_slots
  WHERE exam_date = CURRENT_DATE AND station_no = 1 AND slot_id <> v_slot_sara
  ORDER BY start_time ASC
  LIMIT 1;

  SELECT slot_id INTO v_slot_fatma
  FROM initial_exam_slots
  WHERE exam_date = CURRENT_DATE AND station_no = 1 AND slot_id NOT IN (v_slot_sara, v_slot_mahmoud)
  ORDER BY start_time ASC
  LIMIT 1;

  -- ===========================================================================
  -- CASE 1: Fatma Ali — EXAM_CHECKED_IN (Waiting in Supervisor Triage Queue Today!)
  -- ===========================================================================
  UPDATE initial_exam_slots SET status = 'BOOKED' WHERE slot_id = v_slot_fatma;

  INSERT INTO cases (patient_id, status)
  VALUES (v_pat_fatma_id, 'EXAM_CHECKED_IN')
  RETURNING case_id INTO v_case_triage;

  INSERT INTO initial_exam_bookings (
    slot_id, patient_id, case_id, status, booked_at, checked_in_at, checked_in_by
  )
  VALUES (
    v_slot_fatma, v_pat_fatma_id, v_case_triage, 'CHECKED_IN',
    now() - INTERVAL '45 minutes', now() - INTERVAL '10 minutes', v_sup_hany_id
  )
  RETURNING booking_id INTO v_booking_fatma;

  -- ===========================================================================
  -- CASE 2 & CASE 4: Sara Ahmed Hassan — Routed to ENDO (#36) & RESTORATIVE (#15,#16)
  -- (Both are WAITING_FOR_DOCTOR on the InDrive Department Feed!)
  -- ===========================================================================
  UPDATE initial_exam_slots SET status = 'CONSUMED' WHERE slot_id = v_slot_sara;

  INSERT INTO cases (
    patient_id, routed_by_supervisor_id, department_id, service_id,
    tooth_numbers, tooth_type, procedure_details, triage_notes,
    priority, status, broadcasted_at
  )
  VALUES (
    v_pat_sara_id, v_sup_hany_id, v_dept_endo, v_svc_rct_molar,
    ARRAY[36]::SMALLINT[], 'MOLAR',
    'Root canal therapy required on lower left first molar (#36) with acute irreversible pulpitis.',
    'Patient has controlled Type-2 Diabetes & Hypertension and Penicillin allergy (prescribe Clindamycin/Azithromycin if needed). Prescription verified.',
    'PRIORITY', 'WAITING_FOR_DOCTOR', now() - INTERVAL '20 minutes'
  )
  RETURNING case_id INTO v_case_feed_1;

  INSERT INTO initial_exam_bookings (
    slot_id, patient_id, case_id, status, booked_at, checked_in_at, checked_in_by, examined_at
  )
  VALUES (
    v_slot_sara, v_pat_sara_id, v_case_feed_1, 'EXAMINED',
    now() - INTERVAL '2 hours', now() - INTERVAL '35 minutes', v_sup_hany_id, now() - INTERVAL '20 minutes'
  )
  RETURNING booking_id INTO v_booking_sara;

  INSERT INTO triage_assessments (
    booking_id, patient_id, supervisor_id, chief_complaint, clinical_findings,
    diagnosis_summary, outcome, medical_docs_verified, examined_at
  )
  VALUES (
    v_booking_sara, v_pat_sara_id, v_sup_hany_id,
    'Spontaneous throbbing pain in lower left back tooth (#36) and sensitivity on upper right premolar.',
    'Deep carious lesion exposing pulp on #36; Class II occlusal-distal caries on #15 and #16.',
    'Irreversible pulpitis on #36 (Endodontics) + Class II caries on #15, #16 (Restorative).',
    'ROUTED', TRUE, now() - INTERVAL '20 minutes'
  )
  RETURNING triage_id INTO v_triage_sara;

  UPDATE cases SET triage_id = v_triage_sara WHERE case_id = v_case_feed_1;

  -- Snapshot risk flags for Sara's case
  INSERT INTO case_risk_flags (case_id, risk_flag_id)
  SELECT v_case_feed_1, rf.risk_flag_id
  FROM v_patient_risk_flags rf
  WHERE rf.patient_id = v_pat_sara_id
  ON CONFLICT DO NOTHING;

  -- Sibling Case 4 in RESTORATIVE for Sara
  INSERT INTO cases (
    patient_id, parent_case_id, triage_id, routed_by_supervisor_id,
    department_id, service_id, tooth_numbers, tooth_type,
    procedure_details, triage_notes, priority, status, broadcasted_at
  )
  VALUES (
    v_pat_sara_id, v_case_feed_1, v_triage_sara, v_sup_hany_id,
    v_dept_rest, v_svc_fill_post, ARRAY[15, 16]::SMALLINT[], 'PREMOLAR',
    'Class II composite restoration on upper right second premolar (#15) and first molar (#16).',
    'Controlled diabetes & hypertension; Penicillin allergy.',
    'ROUTINE', 'WAITING_FOR_DOCTOR', now() - INTERVAL '18 minutes'
  )
  RETURNING case_id INTO v_case_feed_3;

  INSERT INTO case_risk_flags (case_id, risk_flag_id)
  SELECT v_case_feed_3, rf.risk_flag_id
  FROM v_patient_risk_flags rf
  WHERE rf.patient_id = v_pat_sara_id
  ON CONFLICT DO NOTHING;

  -- ===========================================================================
  -- CASE 3: Mahmoud Saeed — WAITING_FOR_DOCTOR in SURGERY (URGENT Extraction #48)
  -- ===========================================================================
  UPDATE initial_exam_slots SET status = 'CONSUMED' WHERE slot_id = v_slot_mahmoud;

  INSERT INTO cases (
    patient_id, routed_by_supervisor_id, department_id, service_id,
    tooth_numbers, tooth_type, procedure_details, triage_notes,
    priority, status, broadcasted_at
  )
  VALUES (
    v_pat_mahmoud, v_sup_hany_id, v_dept_surg, v_svc_extr_simp,
    ARRAY[48]::SMALLINT[], 'MOLAR',
    'Extraction of mobile periodontally compromised lower right third molar (#48).',
    'HIGH RISK: Patient has coronary stent and takes Plavix/Aspirin. Check INR report before local anesthesia and apply local hemostatic measures.',
    'URGENT', 'WAITING_FOR_DOCTOR', now() - INTERVAL '12 minutes'
  )
  RETURNING case_id INTO v_case_feed_2;

  INSERT INTO initial_exam_bookings (
    slot_id, patient_id, case_id, status, booked_at, checked_in_at, checked_in_by, examined_at
  )
  VALUES (
    v_slot_mahmoud, v_pat_mahmoud, v_case_feed_2, 'EXAMINED',
    now() - INTERVAL '90 minutes', now() - INTERVAL '25 minutes', v_sup_hany_id, now() - INTERVAL '12 minutes'
  )
  RETURNING booking_id INTO v_booking_mah;

  INSERT INTO triage_assessments (
    booking_id, patient_id, supervisor_id, chief_complaint, clinical_findings,
    diagnosis_summary, outcome, medical_docs_verified, examined_at
  )
  VALUES (
    v_booking_mah, v_pat_mahmoud, v_sup_hany_id,
    'Painful mobile lower right wisdom tooth (#48).',
    'Grade III mobility on #48 with pericoronitis.',
    'Indicated for extraction in Oral Surgery with bleeding precautions.',
    'ROUTED', TRUE, now() - INTERVAL '12 minutes'
  )
  RETURNING triage_id INTO v_triage_mah;

  UPDATE cases SET triage_id = v_triage_mah WHERE case_id = v_case_feed_2;

  INSERT INTO case_risk_flags (case_id, risk_flag_id)
  SELECT v_case_feed_2, rf.risk_flag_id
  FROM v_patient_risk_flags rf
  WHERE rf.patient_id = v_pat_mahmoud
  ON CONFLICT DO NOTHING;

  -- ===========================================================================
  -- CASE 5: Sara Ahmed Hassan — IN_TREATMENT right now on Bed C2-B01 with Dr. Omar!
  -- ===========================================================================
  INSERT INTO cases (
    patient_id, routed_by_supervisor_id, department_id, service_id,
    tooth_numbers, tooth_type, procedure_details, triage_notes,
    priority, status, assigned_doctor_id, broadcasted_at, claimed_at, total_sessions
  )
  VALUES (
    v_pat_sara_id, v_sup_hany_id, v_dept_endo, v_svc_rct_prem,
    ARRAY[24]::SMALLINT[], 'PREMOLAR',
    'Root canal therapy on upper left first premolar (#24) — two canals.',
    'Penicillin allergy; controlled diabetes.',
    'PRIORITY', 'IN_TREATMENT', v_doc_omar_id,
    now() - INTERVAL '2 hours', now() - INTERVAL '50 minutes', 1
  )
  RETURNING case_id INTO v_case_live;

  INSERT INTO case_assignments (case_id, doctor_id, assigned_at)
  VALUES (v_case_live, v_doc_omar_id, now() - INTERVAL '50 minutes');

  INSERT INTO appointments (
    case_id, session_no, doctor_id, patient_id, department_id,
    path, appointment_date, period_id, planned_start_at,
    status, checked_in_at, started_at, session_notes, created_by
  )
  VALUES (
    v_case_live, 1, v_doc_omar_id, v_pat_sara_id, v_dept_endo,
    'LIVE_BED', CURRENT_DATE, v_period_morn, now() - INTERVAL '35 minutes',
    'IN_PROGRESS', now() - INTERVAL '35 minutes', now() - INTERVAL '35 minutes',
    'Access cavity and working length determination on #24.', v_doc_omar_id
  )
  RETURNING appointment_id INTO v_appt_live;

  INSERT INTO bed_tickets (
    ticket_code, ticket_type, status, bed_id, department_id,
    appointment_id, case_id, doctor_id, patient_id,
    service_date, period_id, planned_start_at, occupied_at, created_by
  )
  VALUES (
    'BT-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-C2B01-L' || v_appt_live::TEXT,
    'LIVE', 'OCCUPIED', v_bed_c2_b01, v_dept_endo,
    v_appt_live, v_case_live, v_doc_omar_id, v_pat_sara_id,
    CURRENT_DATE, v_period_morn, now() - INTERVAL '35 minutes', now() - INTERVAL '35 minutes', v_doc_omar_id
  )
  RETURNING ticket_id INTO v_ticket_live;

  -- Open Chat Conversation between Dr. Omar & Sara for Case 5
  INSERT INTO chat_conversations (case_id, patient_id, doctor_id, status, opened_at)
  VALUES (v_case_live, v_pat_sara_id, v_doc_omar_id, 'OPEN', now() - INTERVAL '50 minutes')
  RETURNING conversation_id INTO v_conv_live;

  INSERT INTO chat_messages (conversation_id, sender_id, message_type, body, created_at)
  VALUES
    (v_conv_live, NULL, 'SYSTEM', 'Dr. Omar Khaled has accepted your case.', now() - INTERVAL '50 minutes'),
    (v_conv_live, v_doc_omar_id, 'TEXT', 'أهلاً بحضرتك أستاذة سارة، أنا د. عمر خالد في قسم علاج الجذور. تم تجهيز السرير C2-B01 في عيادة C2 بالدور الثاني.', now() - INTERVAL '42 minutes'),
    (v_conv_live, v_pat_sara_id, 'TEXT', 'شكراً يا دكتور عمر، أنا وصلت أمام عيادة C2 ومعي التحاليل الطبية.', now() - INTERVAL '38 minutes');

  SELECT MAX(message_id) INTO v_msg_id FROM chat_messages WHERE conversation_id = v_conv_live;

  UPDATE chat_conversations
  SET last_message_id = v_msg_id, last_message_at = now() - INTERVAL '38 minutes'
  WHERE conversation_id = v_conv_live;

  -- ===========================================================================
  -- CASE 6: Mahmoud Saeed — SCHEDULED (Future Bed Ticket Reserved for Tomorrow with Dr. Nourhan)
  -- ===========================================================================
  INSERT INTO cases (
    patient_id, routed_by_supervisor_id, department_id, service_id,
    tooth_numbers, tooth_type, procedure_details, triage_notes,
    priority, status, assigned_doctor_id, broadcasted_at, claimed_at, total_sessions
  )
  VALUES (
    v_pat_mahmoud, v_sup_hany_id, v_dept_rest, v_svc_fill_ant,
    ARRAY[11]::SMALLINT[], 'INCISOR',
    'Class IV aesthetic composite restoration on upper right central incisor (#11).',
    'Non-surgical restorative procedure; safe under current antiplatelet regimen.',
    'ROUTINE', 'SCHEDULED', v_doc_nour_id,
    now() - INTERVAL '3 hours', now() - INTERVAL '2 hours', 0
  )
  RETURNING case_id INTO v_case_sched;

  INSERT INTO case_assignments (case_id, doctor_id, assigned_at)
  VALUES (v_case_sched, v_doc_nour_id, now() - INTERVAL '2 hours');

  INSERT INTO appointments (
    case_id, session_no, doctor_id, patient_id, department_id,
    path, appointment_date, period_id, planned_start_at,
    status, session_notes, created_by
  )
  VALUES (
    v_case_sched, 1, v_doc_nour_id, v_pat_mahmoud, v_dept_rest,
    'SCHEDULED', CURRENT_DATE + 1, v_period_morn,
    ((CURRENT_DATE + 1) + TIME '10:00:00') AT TIME ZONE 'Africa/Cairo',
    'SCHEDULED', 'Shade matching and composite build-up on #11.', v_doc_nour_id
  )
  RETURNING appointment_id INTO v_appt_sched;

  INSERT INTO bed_tickets (
    ticket_code, ticket_type, status, bed_id, department_id,
    appointment_id, case_id, doctor_id, patient_id,
    service_date, period_id, planned_start_at, reserved_at, created_by
  )
  VALUES (
    'BT-' || to_char(CURRENT_DATE + 1, 'YYYYMMDD') || '-C1B02-MOR-' || v_appt_sched::TEXT,
    'SCHEDULED', 'RESERVED', v_bed_c1_b02, v_dept_rest,
    v_appt_sched, v_case_sched, v_doc_nour_id, v_pat_mahmoud,
    CURRENT_DATE + 1, v_period_morn,
    ((CURRENT_DATE + 1) + TIME '10:00:00') AT TIME ZONE 'Africa/Cairo',
    now() - INTERVAL '90 minutes', v_doc_nour_id
  );

  INSERT INTO chat_conversations (case_id, patient_id, doctor_id, status, opened_at)
  VALUES (v_case_sched, v_pat_mahmoud, v_doc_nour_id, 'OPEN', now() - INTERVAL '2 hours')
  RETURNING conversation_id INTO v_conv_sched;

  INSERT INTO chat_messages (conversation_id, sender_id, message_type, body, created_at)
  VALUES
    (v_conv_sched, NULL, 'SYSTEM', 'Dr. Nourhan Tarek has accepted your case.', now() - INTERVAL '2 hours'),
    (v_conv_sched, v_doc_nour_id, 'TEXT', 'أهلاً بحضرتك أستاذ محمود، تم حجز تذكرة موعدك غداً الساعة 10:00 صباحاً في عيادة C1 سرير C1-B02.', now() - INTERVAL '90 minutes');

  SELECT MAX(message_id) INTO v_msg_id FROM chat_messages WHERE conversation_id = v_conv_sched;

  UPDATE chat_conversations
  SET last_message_id = v_msg_id, last_message_at = now() - INTERVAL '90 minutes'
  WHERE conversation_id = v_conv_sched;

  -- ===========================================================================
  -- CASE 7: Fatma Ali — FINISHED Case with Completion Report, Rating & Portfolio Post
  -- ===========================================================================
  INSERT INTO cases (
    patient_id, routed_by_supervisor_id, department_id, service_id,
    tooth_numbers, tooth_type, procedure_details, triage_notes,
    priority, status, assigned_doctor_id,
    broadcasted_at, claimed_at, finished_at, total_sessions
  )
  VALUES (
    v_pat_fatma_id, v_sup_hany_id, v_dept_rest, v_svc_fill_ant,
    ARRAY[21]::SMALLINT[], 'INCISOR',
    'Anterior aesthetic Class III composite restoration on upper left central incisor (#21).',
    'No systemic conditions.',
    'ROUTINE', 'FINISHED', v_doc_omar_id,
    now() - INTERVAL '1 day', now() - INTERVAL '22 hours', now() - INTERVAL '19 hours', 1
  )
  RETURNING case_id INTO v_case_fin;

  INSERT INTO case_assignments (case_id, doctor_id, assigned_at)
  VALUES (v_case_fin, v_doc_omar_id, now() - INTERVAL '22 hours');

  INSERT INTO appointments (
    case_id, session_no, doctor_id, patient_id, department_id,
    path, appointment_date, period_id, planned_start_at,
    status, checked_in_at, started_at, ended_at, outcome,
    procedure_performed, session_notes, created_by
  )
  VALUES (
    v_case_fin, 1, v_doc_omar_id, v_pat_fatma_id, v_dept_rest,
    'LIVE_BED', CURRENT_DATE, v_period_morn, now() - INTERVAL '4 hours',
    'COMPLETED', now() - INTERVAL '4 hours', now() - INTERVAL '4 hours', now() - INTERVAL '3 hours',
    'FINISHED',
    'Rubber dam isolation, caries removal, selective enamel etching, and layered nano-hybrid composite restoration (Shade A2) on #21.',
    'Excellent aesthetic contour and polish achieved in a single visit.',
    v_doc_omar_id
  )
  RETURNING appointment_id INTO v_appt_fin;

  INSERT INTO bed_tickets (
    ticket_code, ticket_type, status, bed_id, department_id,
    appointment_id, case_id, doctor_id, patient_id,
    service_date, period_id, planned_start_at,
    occupied_at, freed_at, freed_by, free_reason, created_by
  )
  VALUES (
    'BT-' || to_char(CURRENT_DATE, 'YYYYMMDD') || '-C1B01-L' || v_appt_fin::TEXT,
    'LIVE', 'FREED', v_bed_c1_b01, v_dept_rest,
    v_appt_fin, v_case_fin, v_doc_omar_id, v_pat_fatma_id,
    CURRENT_DATE, v_period_morn, now() - INTERVAL '4 hours',
    now() - INTERVAL '4 hours', now() - INTERVAL '3 hours', v_doc_omar_id, 'DOCTOR_FINISHED', v_doc_omar_id
  );

  INSERT INTO completion_reports (
    case_id, doctor_id, final_diagnosis, procedure_summary,
    materials_used, result, total_sessions, post_care_instructions,
    review_status, reviewer_supervisor_id, reviewed_at
  )
  VALUES (
    v_case_fin, v_doc_omar_id,
    'Class III mesial carious lesion on #21',
    'Minimally invasive cavity preparation under rubber dam isolation and layered A2 nano-hybrid composite restoration.',
    '37% Phosphoric Acid, Single Bond Universal, 3M Filtek Supreme Ultra (A2 Body & Enamel), Sof-Lex finishing discs',
    'Full anatomical, functional, and aesthetic restoration',
    1,
    'Avoid staining beverages (coffee/tea) for 24 hours.',
    'APPROVED', v_sup_hany_id, now() - INTERVAL '2 hours'
  )
  RETURNING report_id INTO v_rep_fin;

  INSERT INTO ratings (
    case_id, patient_id, doctor_id, score, communication_score, punctuality_score, comment
  )
  VALUES (
    v_case_fin, v_pat_fatma_id, v_doc_omar_id,
    5, 5, 5,
    'دكتور عمر ممتاز جداً ويده خفيفة والحشو التجميلي شكله طبيعي تماماً. شكراً لمستشفى جامعة 6 أكتوبر!'
  );

  INSERT INTO student_posts (
    doctor_id, case_id, description, is_published, published_at, approved_by_supervisor
  )
  VALUES (
    v_doc_omar_id, v_case_fin,
    'Direct Class III aesthetic composite restoration on upper left central incisor (#21) using multi-shade layering technique under rubber dam isolation.',
    TRUE, now() - INTERVAL '2 hours', v_sup_hany_id
  );

  INSERT INTO chat_conversations (case_id, patient_id, doctor_id, status, opened_at, read_only_at)
  VALUES (v_case_fin, v_pat_fatma_id, v_doc_omar_id, 'READ_ONLY', now() - INTERVAL '22 hours', now() - INTERVAL '3 hours')
  RETURNING conversation_id INTO v_conv_fin;

  INSERT INTO chat_messages (conversation_id, sender_id, message_type, body, created_at)
  VALUES
    (v_conv_fin, NULL, 'SYSTEM', 'Case treatment completed. Chat is now in read-only mode.', now() - INTERVAL '3 hours')
  RETURNING message_id INTO v_msg_id;

  UPDATE chat_conversations
  SET last_message_id = v_msg_id, last_message_at = now() - INTERVAL '3 hours'
  WHERE conversation_id = v_conv_fin;

  -- Sample in-app notifications
  INSERT INTO notifications (user_id, type, title, body, data, case_id, is_read, created_at)
  VALUES
    (
      v_pat_sara_id, 'BED_OCCUPIED',
      'تم إشغال الكرسي وبدء جلستك العلاجية',
      'قام د. عمر خالد ببدء الجلسة على الكرسي C2-B01 بعيادة 2. يرجى التوجه لغرفة الكشف.',
      '{"bedLabel":"C2-B01","clinicNumber":"C2"}'::jsonb, v_case_live, FALSE, now() - INTERVAL '40 minutes'
    ),
    (
      v_pat_sara_id, 'EXAM_BOOKED',
      'تأكيد حجز الكشف المبدئي',
      'تم تأكيد حجز الكشف المبدئي الخاص بك بمستشفى جامعة 6 أكتوبر بنجاح.',
      '{}'::jsonb, NULL, TRUE, now() - INTERVAL '3 hours'
    ),
    (
      v_doc_omar_id, 'CASE_CLAIMED',
      'تم سحب الحالة بنجاح',
      'لقد قمت بسحب حالة المريضة سارة أحمد حسن (#TL-0001004) وتفعيل المحادثة الطبية.',
      '{"caseId":5}'::jsonb, v_case_live, TRUE, now() - INTERVAL '50 minutes'
    ),
    (
      v_sup_hany_id, 'PATIENT_CHECKED_IN',
      'حضور مريض لعيادة الكشف المبدئي',
      'المريضة فاطمة علي إبراهيم متواجدة الآن بقاعة الانتظار وجاهزة للفرز الإكلينيكي.',
      '{"bookingId":1}'::jsonb, NULL, FALSE, now() - INTERVAL '15 minutes'
    ),
    (
      1, 'ACCOUNT_PENDING_APPROVAL',
      'طلب تسجيل طبيب جديد بانتظار الاعتماد',
      'قام د. كريم مصطفى (سنة رابعة) بتقديم طلب انضمام لقسم العلاج التحفظي وبانتظار موافقتك.',
      '{"candidateId":6}'::jsonb, NULL, FALSE, now() - INTERVAL '2 hours'
    );

END $$;

COMMIT;
