-- =============================================================================
-- TeethLink — Complete Seed Data (sql/002_seed.sql)
-- Strictly aligned with BACKEND_SYSTEM_PLAN_2.md
-- =============================================================================

BEGIN;

-- -----------------------------------------------------------------------------
-- 1. Allowed Case Status Transitions (§6.2)
-- -----------------------------------------------------------------------------
INSERT INTO case_status_transitions (from_status, to_status) VALUES
  ('EXAM_BOOKED',        'EXAM_CHECKED_IN'),
  ('EXAM_BOOKED',        'EXAM_NO_SHOW'),
  ('EXAM_BOOKED',        'CANCELLED'),
  ('EXAM_CHECKED_IN',    'WAITING_FOR_DOCTOR'),
  ('EXAM_CHECKED_IN',    'TRIAGE_CLOSED'),
  ('EXAM_CHECKED_IN',    'CANCELLED'),
  ('WAITING_FOR_DOCTOR', 'CLAIMED'),
  ('WAITING_FOR_DOCTOR', 'CANCELLED'),
  ('CLAIMED',            'IN_TREATMENT'),
  ('CLAIMED',            'SCHEDULED'),
  ('CLAIMED',            'WAITING_FOR_DOCTOR'),
  ('CLAIMED',            'CANCELLED'),
  ('SCHEDULED',          'IN_TREATMENT'),
  ('SCHEDULED',          'CLAIMED'),
  ('SCHEDULED',          'WAITING_FOR_DOCTOR'),
  ('SCHEDULED',          'CANCELLED'),
  ('IN_TREATMENT',       'AWAITING_OUTCOME'),
  ('IN_TREATMENT',       'NEEDS_FOLLOW_UP'),
  ('IN_TREATMENT',       'FINISHED'),
  ('AWAITING_OUTCOME',   'NEEDS_FOLLOW_UP'),
  ('AWAITING_OUTCOME',   'FINISHED'),
  ('NEEDS_FOLLOW_UP',    'IN_TREATMENT'),
  ('NEEDS_FOLLOW_UP',    'SCHEDULED'),
  ('NEEDS_FOLLOW_UP',    'FINISHED'),
  ('NEEDS_FOLLOW_UP',    'WAITING_FOR_DOCTOR'),
  ('NEEDS_FOLLOW_UP',    'CANCELLED')
ON CONFLICT (from_status, to_status) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 2. Runtime System Settings (§6.1)
-- -----------------------------------------------------------------------------
INSERT INTO system_settings (key, value, description) VALUES
  ('hospital_timezone',                     '"Africa/Cairo"'::jsonb, 'Hospital local timezone used for dates and times'),
  ('exam_slot_duration_minutes',            '10'::jsonb,             'Duration of each Initial Examination slot in minutes'),
  ('exam_booking_window_days',              '2'::jsonb,              'How many days ahead a patient can book an Initial Exam slot'),
  ('exam_cancel_cutoff_minutes',            '60'::jsonb,             'Minimum minutes before slot start for a patient to cancel/reschedule'),
  ('exam_no_show_grace_minutes',            '15'::jsonb,             'Grace minutes after slot end before marking EXAM_NO_SHOW'),
  ('max_patient_no_shows',                  '3'::jsonb,              'No-show count that triggers a temporary booking cooldown'),
  ('bed_reservation_grace_minutes',         '30'::jsonb,             'Grace minutes after planned_start_at before a RESERVED bed ticket is released as NO_SHOW'),
  ('reservation_protection_mode',           '"WINDOW"'::jsonb,       'WINDOW (default: reserved bed blocks live occupancy only within reservation_protect_minutes) or STRICT'),
  ('reservation_protect_minutes',           '30'::jsonb,             'Minutes before planned_start_at at which a RESERVED ticket blocks Path A live occupancy'),
  ('bed_stale_occupancy_alert_minutes',     '180'::jsonb,            'Minutes of continuous live occupancy before nudging the doctor to free the bed'),
  ('auto_free_beds_at_end_of_day',          'true'::jsonb,           'Automatically free forgotten occupied beds at clinic closing (21:00)'),
  ('unscheduled_claim_timeout_hours',       '12'::jsonb,             'Hours a doctor can hold a CLAIMED case without occupying/scheduling a bed before auto-release'),
  ('require_before_after_photos_on_finish', 'false'::jsonb,          'Whether outcome=FINISHED requires at least 1 BEFORE and 1 AFTER photo'),
  ('require_supervisor_report_review',      'false'::jsonb,          'Whether completion_reports require supervisor approval before portfolio publication'),
  ('require_phone_otp',                     'false'::jsonb,          'Whether patient phone verification via SMS OTP is required before booking')
ON CONFLICT (key) DO UPDATE
  SET value = EXCLUDED.value,
      description = EXCLUDED.description;


-- -----------------------------------------------------------------------------
-- 3. Rule-Based Risk Flags (§2.3)
-- -----------------------------------------------------------------------------
INSERT INTO risk_flags (code, name_en, name_ar, severity, rule_description, is_active) VALUES
  ('DIABETES',            'Diabetes Mellitus',            'مرض السكري',                 'CAUTION', 'Delayed healing and infection risk; check blood glucose & HbA1c.', TRUE),
  ('HYPERTENSION',        'Hypertension',                 'ضغط الدم المرتفع',           'CAUTION', 'Monitor blood pressure; limit vasoconstrictor (epinephrine) dose.', TRUE),
  ('CARDIAC',             'Cardiovascular Disease',       'أمراض القلب والشرايين',      'HIGH',    'Check infective endocarditis prophylaxis and cardiology clearance.', TRUE),
  ('ANTICOAGULANT',       'Blood Thinners / Bleeding',    'سيولة الدم واضطرابات النزف',  'HIGH',    'High bleeding risk on extraction/surgery; verify INR & anticoagulant regimen.', TRUE),
  ('PREGNANCY',           'Pregnancy / Lactation',        'الحمل أو الرضاعة',           'CAUTION', 'Avoid routine radiographs and teratogenic medications.', TRUE),
  ('RENAL_HEPATIC',       'Kidney / Liver Disease',       'أمراض الكلى أو الكبد',        'HIGH',    'Adjust drug dosages and avoid nephrotoxic/hepatotoxic analgesics.', TRUE),
  ('RESPIRATORY_NEURO',   'Asthma / Epilepsy',            'الربو أو الصرع',             'CAUTION', 'Avoid NSAIDs in aspirin-sensitive asthma; keep emergency inhaler/protocol ready.', TRUE),
  ('THYROID',             'Thyroid Disorder',             'اضطراب الغدة الدرقية',        'CAUTION', 'Avoid epinephrine in uncontrolled hyperthyroidism.', TRUE),
  ('INFECTIOUS_DISEASE',  'Blood-Borne Infectious Risk',  'أمراض معدية (التهاب كبدي/مناعي)', 'HIGH', 'Apply enhanced infection control and sterilization precautions.', TRUE),
  ('BONE_RADIATION',      'Bisphosphonates / Radiation',  'علاج العظام أو الإشعاع',      'HIGH',    'Risk of MRONJ / osteoradionecrosis after extractions.', TRUE),
  ('PENICILLIN_ALLERGY',  'Penicillin Allergy',           'حساسية البنسلين',            'HIGH',    'Contraindication to Penicillins/Amoxicillin.', TRUE),
  ('ANESTHETIC_ALLERGY',  'Local Anaesthetic Allergy',    'حساسية المخدر الموضعي',      'HIGH',    'Verify ester vs amide anaesthetic allergy before injection.', TRUE),
  ('LATEX_ALLERGY',       'Latex Allergy',                'حساسية اللاتكس',             'CAUTION', 'Use nitrile/latex-free gloves and dental dams.', TRUE),
  ('NSAID_ALLERGY',       'Aspirin / NSAID Allergy',      'حساسية المسكنات والأسبرين',   'HIGH',    'Avoid Ibuprofen, Ketorolac, Diclofenac, and Aspirin.', TRUE),
  ('IODINE_ALLERGY',      'Iodine Allergy',               'حساسية اليود',               'CAUTION', 'Avoid povidone-iodine antiseptics.', TRUE),
  ('METAL_ALLERGY',       'Nickel / Metal Allergy',       'حساسية المعادن والنيكل',      'INFO',    'Use nickel-free orthodontic/prosthetic alloys.', TRUE)
ON CONFLICT (code) DO UPDATE
  SET name_en = EXCLUDED.name_en,
      name_ar = EXCLUDED.name_ar,
      severity = EXCLUDED.severity,
      rule_description = EXCLUDED.rule_description;


-- -----------------------------------------------------------------------------
-- 4. Medical Questionnaire Conditions (5 Critical + 5 Additional)
-- -----------------------------------------------------------------------------
INSERT INTO medical_conditions (
  code, category, name_en, name_ar, question_text_en, question_text_ar,
  is_critical, requires_document_if_yes, checklist_options, risk_flag_id,
  is_sensitive, applies_to_gender, display_order, is_active
) VALUES
  (
    'DIABETES', 'Endocrine & Metabolic',
    'Diabetes Mellitus', 'مرض السكري',
    'Do you have Diabetes (Type 1 or Type 2)?', 'هل تعاني من مرض السكري (النوع الأول أو الثاني)؟',
    TRUE, TRUE,
    '[
      {"code":"TYPE_1","en":"Type 1 Diabetes","ar":"النوع الأول"},
      {"code":"TYPE_2","en":"Type 2 Diabetes","ar":"النوع الثاني"},
      {"code":"CONTROLLED","en":"Controlled on treatment","ar":"منتظم على العلاج"},
      {"code":"UNCONTROLLED","en":"Uncontrolled / Irregular","ar":"غير منتظم"}
    ]'::jsonb,
    (SELECT risk_flag_id FROM risk_flags WHERE code = 'DIABETES'),
    FALSE, NULL, 1, TRUE
  ),
  (
    'HYPERTENSION', 'Cardiovascular',
    'Hypertension', 'ارتفاع ضغط الدم',
    'Do you suffer from high blood pressure (Hypertension)?', 'هل تعاني من ارتفاع ضغط الدم؟',
    TRUE, TRUE,
    '[
      {"code":"CONTROLLED","en":"Controlled on medication","ar":"منتظم بالأدوية"},
      {"code":"UNCONTROLLED","en":"Uncontrolled (>140/90)","ar":"غير منتظم"}
    ]'::jsonb,
    (SELECT risk_flag_id FROM risk_flags WHERE code = 'HYPERTENSION'),
    FALSE, NULL, 2, TRUE
  ),
  (
    'HEART_DISEASE', 'Cardiovascular',
    'Cardiovascular / Heart Disease', 'أمراض القلب والشرايين',
    'Do you have any heart condition (angina, previous MI, coronary stents, prosthetic valve, rheumatic fever)?',
    'هل تعاني من أي أمراض بالقلب (ذبحة صدرية، جلطة سابقة، دعامات، صمام صناعي، حمى روماتيزمية)؟',
    TRUE, TRUE,
    '[
      {"code":"ANGINA_MI","en":"Angina / Previous Heart Attack","ar":"ذبحة صدرية / جلطة سابقة"},
      {"code":"STENT","en":"Coronary Stents","ar":"دعامات بالقلب"},
      {"code":"PROSTHETIC_VALVE","en":"Prosthetic Heart Valve","ar":"صمام قلب صناعي"},
      {"code":"RHEUMATIC_FEVER","en":"Rheumatic Heart Disease","ar":"حمى روماتيزمية"},
      {"code":"HEART_FAILURE","en":"Heart Failure","ar":"قصور في عضلة القلب"}
    ]'::jsonb,
    (SELECT risk_flag_id FROM risk_flags WHERE code = 'CARDIAC'),
    FALSE, NULL, 3, TRUE
  ),
  (
    'ANTICOAGULANT_BLEEDING', 'Hematologic',
    'Blood Thinners / Bleeding Disorder', 'أدوية السيولة واضطرابات النزف',
    'Do you take blood thinners (Warfarin, Aspirin, Clopidogrel) or have a bleeding/coagulation disorder?',
    'هل تتناول أدوية سيولة الدم (وارفارين، أسبرين، كلوبيدوجريل) أو تعاني من اضطراب نزف أو سيولة؟',
    TRUE, TRUE,
    '[
      {"code":"WARFARIN","en":"Warfarin (Marevan)","ar":"وارفارين (ماريفان)"},
      {"code":"ANTIPLATELET","en":"Aspirin / Clopidogrel (Plavix)","ar":"أسبرين / بلافيكس"},
      {"code":"DOAC","en":"Rivaroxaban / Apixaban","ar":"ريفاروكسابان / أبيكسابان"},
      {"code":"HEMOPHILIA","en":"Hemophilia / Coagulation Disorder","ar":"هيموفيليا / اضطراب تجلط الدم"}
    ]'::jsonb,
    (SELECT risk_flag_id FROM risk_flags WHERE code = 'ANTICOAGULANT'),
    FALSE, NULL, 4, TRUE
  ),
  (
    'KIDNEY_LIVER', 'Renal & Hepatic',
    'Kidney or Liver Disease', 'أمراض الكلى أو الكبد',
    'Do you have chronic kidney disease (or dialysis) or liver disease (hepatitis/cirrhosis)?',
    'هل تعاني من قصور كلوي (أو غسيل كلوي) أو أمراض مزمنة بالكبد؟',
    TRUE, TRUE,
    '[
      {"code":"RENAL_FAILURE","en":"Renal Impairment / Dialysis","ar":"قصور كلوي / غسيل كلوي"},
      {"code":"LIVER_CIRRHOSIS","en":"Hepatic Impairment / Cirrhosis","ar":"تليف أو التهاب كبدي"}
    ]'::jsonb,
    (SELECT risk_flag_id FROM risk_flags WHERE code = 'RENAL_HEPATIC'),
    FALSE, NULL, 5, TRUE
  ),
  (
    'ASTHMA_EPILEPSY', 'Respiratory & Neurological',
    'Asthma or Epilepsy / Seizures', 'الربو أو الصرع والتشنجات',
    'Do you have bronchial asthma or epilepsy/seizures?',
    'هل تعاني من حساسية الصدر (الربو) أو نوبات صرع وتشنجات؟',
    FALSE, FALSE,
    '[
      {"code":"ASTHMA","en":"Bronchial Asthma","ar":"ربو شعبي / حساسية صدر"},
      {"code":"EPILEPSY","en":"Epilepsy / Seizures","ar":"صرع / تشنجات"}
    ]'::jsonb,
    (SELECT risk_flag_id FROM risk_flags WHERE code = 'RESPIRATORY_NEURO'),
    FALSE, NULL, 6, TRUE
  ),
  (
    'THYROID', 'Endocrine & Metabolic',
    'Thyroid Disorder', 'اضطرابات الغدة الدرقية',
    'Do you have hyperthyroidism or hypothyroidism?',
    'هل تعاني من فرط نشاط أو خمول في الغدة الدرقية؟',
    FALSE, FALSE,
    '[
      {"code":"HYPERTHYROID","en":"Hyperthyroidism","ar":"نشاط زائد بالغدة الدرقية"},
      {"code":"HYPOTHYROID","en":"Hypothyroidism","ar":"خمول بالغدة الدرقية"}
    ]'::jsonb,
    (SELECT risk_flag_id FROM risk_flags WHERE code = 'THYROID'),
    FALSE, NULL, 7, TRUE
  ),
  (
    'PREGNANCY_LACTATION', 'Obstetric',
    'Pregnancy or Breastfeeding', 'الحمل والرضاعة',
    'Are you currently pregnant or breastfeeding?',
    'هل أنتِ حامل حاليًا أو مرضعة؟',
    FALSE, FALSE,
    '[
      {"code":"TRIMESTER_1","en":"Pregnant — 1st Trimester","ar":"حامل — الثلث الأول"},
      {"code":"TRIMESTER_2","en":"Pregnant — 2nd Trimester","ar":"حامل — الثلث الثاني"},
      {"code":"TRIMESTER_3","en":"Pregnant — 3rd Trimester","ar":"حامل — الثلث الثالث"},
      {"code":"BREASTFEEDING","en":"Breastfeeding","ar":"مرضعة"}
    ]'::jsonb,
    (SELECT risk_flag_id FROM risk_flags WHERE code = 'PREGNANCY'),
    FALSE, 'FEMALE', 8, TRUE
  ),
  (
    'INFECTIOUS_DISEASE', 'Infectious',
    'Hepatitis B / C or HIV', 'أمراض معدية (التهاب كبدي B أو C أو HIV)',
    'Have you been diagnosed with Hepatitis B, Hepatitis C, or HIV? (Confidential)',
    'هل تم تشخيصك بالتهاب الكبد B أو C أو فيروس نقص المناعة؟ (يُعامل بسرية تامة)',
    FALSE, FALSE,
    '[
      {"code":"HBV","en":"Hepatitis B (HBV)","ar":"التهاب كبدي B"},
      {"code":"HCV","en":"Hepatitis C (HCV)","ar":"التهاب كبدي C"},
      {"code":"HIV","en":"HIV","ar":"فيروس نقص المناعة"}
    ]'::jsonb,
    (SELECT risk_flag_id FROM risk_flags WHERE code = 'INFECTIOUS_DISEASE'),
    TRUE, NULL, 9, TRUE
  ),
  (
    'BONE_RADIOTHERAPY', 'Oncology & Bone',
    'Bisphosphonates / Head & Neck Radiotherapy', 'أدوية هشاشة العظام أو العلاج الإشعاعي والكيماوي',
    'Have you received bisphosphonates (osteoporosis therapy), chemotherapy, or head & neck radiation?',
    'هل تتلقى أدوية هشاشة العظام (بيسفوسفونات) أو علاجًا إشعاعيًا/كيماويًا؟',
    FALSE, FALSE,
    '[
      {"code":"BISPHOSPHONATES","en":"Bisphosphonates","ar":"بيسفوسفونات (هشاشة العظام)"},
      {"code":"RADIOTHERAPY","en":"Head & Neck Radiotherapy","ar":"علاج إشعاعي للرأس والرقبة"},
      {"code":"CHEMOTHERAPY","en":"Chemotherapy","ar":"علاج كيماوي"}
    ]'::jsonb,
    (SELECT risk_flag_id FROM risk_flags WHERE code = 'BONE_RADIATION'),
    FALSE, NULL, 10, TRUE
  )
ON CONFLICT (code) DO UPDATE
  SET name_en = EXCLUDED.name_en,
      name_ar = EXCLUDED.name_ar,
      question_text_en = EXCLUDED.question_text_en,
      question_text_ar = EXCLUDED.question_text_ar,
      is_critical = EXCLUDED.is_critical,
      requires_document_if_yes = EXCLUDED.requires_document_if_yes,
      checklist_options = EXCLUDED.checklist_options,
      risk_flag_id = EXCLUDED.risk_flag_id;


-- -----------------------------------------------------------------------------
-- 5. Allergies Catalog
-- -----------------------------------------------------------------------------
INSERT INTO allergies (code, name_en, name_ar, risk_flag_id, is_active) VALUES
  ('PENICILLIN',       'Penicillin / Amoxicillin Antibiotics', 'البنسلين أو الأموكسيسيلين والمضادات الحيوية', (SELECT risk_flag_id FROM risk_flags WHERE code = 'PENICILLIN_ALLERGY'), TRUE),
  ('LOCAL_ANESTHETIC', 'Local Anaesthetic',                    'المخدر الموضعي للأسنان',                    (SELECT risk_flag_id FROM risk_flags WHERE code = 'ANESTHETIC_ALLERGY'), TRUE),
  ('LATEX',            'Latex (Gloves / Dental Dam)',          'اللاتكس (القفازات الطبية)',                 (SELECT risk_flag_id FROM risk_flags WHERE code = 'LATEX_ALLERGY'),      TRUE),
  ('NSAIDS',           'Aspirin / NSAIDs (Ibuprofen, etc.)',   'الأسبرين والمسكنات المضادة للالتهاب',        (SELECT risk_flag_id FROM risk_flags WHERE code = 'NSAID_ALLERGY'),      TRUE),
  ('IODINE',           'Iodine / Antiseptics',                 'اليود والمطهرات',                          (SELECT risk_flag_id FROM risk_flags WHERE code = 'IODINE_ALLERGY'),     TRUE),
  ('NICKEL_METALS',    'Nickel / Dental Alloys',               'النيكل والمعادن',                          (SELECT risk_flag_id FROM risk_flags WHERE code = 'METAL_ALLERGY'),      TRUE)
ON CONFLICT (code) DO UPDATE
  SET name_en = EXCLUDED.name_en,
      name_ar = EXCLUDED.name_ar,
      risk_flag_id = EXCLUDED.risk_flag_id;


-- -----------------------------------------------------------------------------
-- 6. Specialized Hospital Departments & Services (Sub-Procedures)
-- -----------------------------------------------------------------------------
INSERT INTO departments (code, name_en, name_ar, description, is_active, display_order) VALUES
  ('RESTORATIVE', 'Restorative & Operative Dentistry (Filling)', 'قسم العلاج التحفظي والحشو',       'Caries management, amalgam/composite fillings, aesthetic restorations', TRUE, 1),
  ('ENDO',        'Endodontics (Root Canal)',                    'قسم علاج الجذور والأعصاب',        'Root canal therapy for anterior, premolar, and molar teeth',           TRUE, 2),
  ('PERIO',       'Periodontics (Gum & Scaling)',                'قسم طب وجراحة اللثة والتنظيف',    'Supragingival/subgingival scaling, root planing, periodontal care',     TRUE, 3),
  ('SURGERY',     'Oral & Maxillofacial Surgery (Extraction)',   'قسم جراحة الفم والوجه والفكين',   'Simple and surgical tooth extractions, impacted third molars',         TRUE, 4),
  ('PROSTHO',     'Prosthodontics (Crowns & Dentures)',          'قسم الاستعاضة الصناعية والتركيبات','Fixed crowns/bridges, removable partial and complete dentures',         TRUE, 5),
  ('PEDO',        'Pediatric Dentistry (Pedodontics)',           'قسم طب أسنان الأطفال',           'Restorative, pulp therapy, and preventive care for children',          TRUE, 6),
  ('ORTHO',       'Orthodontics',                                'قسم تقويم الأسنان',              'Orthodontic assessment, removable and fixed appliances',               TRUE, 7)
ON CONFLICT (code) DO UPDATE
  SET name_en = EXCLUDED.name_en,
      name_ar = EXCLUDED.name_ar,
      description = EXCLUDED.description,
      display_order = EXCLUDED.display_order;

INSERT INTO services (department_id, code, name_en, name_ar, description, requires_permission, min_academic_year, typical_sessions, is_active) VALUES
  -- Restorative
  ((SELECT department_id FROM departments WHERE code = 'RESTORATIVE'), 'FILLING_CLASS_I_II',  'Posterior Composite / Amalgam Filling (Class I/II)', 'حشو خلفي (ضروس وضواحك)',       'Posterior occlusal/proximal cavity restoration', FALSE, 4, 1, TRUE),
  ((SELECT department_id FROM departments WHERE code = 'RESTORATIVE'), 'FILLING_ANTERIOR',    'Anterior Aesthetic Composite Restoration (Class III/IV/V)', 'حشو تجميلي أمامي',      'Anterior aesthetic tooth-colored restoration',   FALSE, 4, 1, TRUE),
  ((SELECT department_id FROM departments WHERE code = 'RESTORATIVE'), 'DEEP_CARIES_PULP_CAP','Deep Caries Management & Pulp Capping',              'علاج تسوس عميق وتغطية اللب',   'Indirect/direct pulp capping and base',          FALSE, 5, 1, TRUE),
  -- Endodontics
  ((SELECT department_id FROM departments WHERE code = 'ENDO'),        'RCT_ANTERIOR',        'Root Canal — Anterior Tooth (Single Canal)',         'علاج عصب — أسنان أمامية',      'Single-canal endodontic therapy',                FALSE, 4, 2, TRUE),
  ((SELECT department_id FROM departments WHERE code = 'ENDO'),        'RCT_PREMOLAR',        'Root Canal — Premolar',                              'علاج عصب — ضواحك',             'One or two canal premolar endodontic therapy',   FALSE, 4, 2, TRUE),
  ((SELECT department_id FROM departments WHERE code = 'ENDO'),        'RCT_MOLAR',           'Root Canal — Molar (Multi-Canal)',                   'علاج عصب — ضروس خلفية',        'Multi-canal molar endodontic therapy',           FALSE, 5, 3, TRUE),
  ((SELECT department_id FROM departments WHERE code = 'ENDO'),        'RCT_RETREATMENT',     'Endodontic Retreatment',                             'إعادة علاج العصب',             'Non-surgical root canal retreatment',            TRUE,  5, 3, TRUE),
  -- Periodontics
  ((SELECT department_id FROM departments WHERE code = 'PERIO'),       'SCALING_POLISHING',   'Ultrasonic Scaling & Polishing',                     'تنظيف الجير وتلميع الأسنان',   'Full-mouth supragingival scaling and polishing', FALSE, 3, 1, TRUE),
  ((SELECT department_id FROM departments WHERE code = 'PERIO'),       'ROOT_PLANING',        'Deep Subgingival Scaling & Root Planing',            'كحت الجذور وعلاج الجيوب اللثوية','Quadrant root planing for periodontal pockets', FALSE, 4, 2, TRUE),
  -- Oral Surgery
  ((SELECT department_id FROM departments WHERE code = 'SURGERY'),     'SIMPLE_EXTRACTION',   'Simple Tooth Extraction',                            'خلع عادي غير جراحي',           'Forceps/elevator extraction of erupted tooth',   FALSE, 4, 1, TRUE),
  ((SELECT department_id FROM departments WHERE code = 'SURGERY'),     'SURGICAL_EXTRACTION', 'Surgical / Impacted Tooth Extraction',               'خلع جراحي / ضرس العقل المدفون','Flap & bone removal surgical extraction',        TRUE,  5, 1, TRUE),
  -- Prosthodontics
  ((SELECT department_id FROM departments WHERE code = 'PROSTHO'),     'SINGLE_CROWN_BRIDGE', 'Fixed Crown or Short-Span Bridge',                   'طربوش ثابت أو كوبري',          'Tooth preparation, impression, and cementation', FALSE, 5, 3, TRUE),
  ((SELECT department_id FROM departments WHERE code = 'PROSTHO'),     'REMOVABLE_DENTURE',   'Complete or Partial Removable Denture',              'طقم أسنان متحرك (كلي أو جزئي)','Removable prosthodontic rehabilitation',         FALSE, 4, 4, TRUE),
  -- Pediatric
  ((SELECT department_id FROM departments WHERE code = 'PEDO'),        'PEDO_PULPOTOMY_SSC',  'Pediatric Pulpotomy & Stainless Steel Crown',        'علاج عصب أطفال وطربوش معدني',  'Primary molar pulp therapy and SSC',             FALSE, 4, 2, TRUE),
  ((SELECT department_id FROM departments WHERE code = 'PEDO'),        'PEDO_FILLING_EXTR',   'Pediatric Filling or Primary Tooth Extraction',      'حشو أو خلع أسنان لبنية للأطفال','Routine pediatric restorative or extraction',   FALSE, 4, 1, TRUE),
  -- Orthodontics
  ((SELECT department_id FROM departments WHERE code = 'ORTHO'),       'ORTHO_CONSULT_APPL',  'Orthodontic Assessment & Appliance Follow-up',       'فحص ومتابعة تقويم الأسنان',    'Diagnostic records and orthodontic appliance',   TRUE,  5, 4, TRUE)
ON CONFLICT (code) DO UPDATE
  SET name_en = EXCLUDED.name_en,
      name_ar = EXCLUDED.name_ar,
      requires_permission = EXCLUDED.requires_permission,
      min_academic_year = EXCLUDED.min_academic_year,
      typical_sessions = EXCLUDED.typical_sessions;


-- -----------------------------------------------------------------------------
-- 7. Bed Ticket Periods, Clinics & 20 Physical Dental Beds
-- -----------------------------------------------------------------------------
INSERT INTO bed_ticket_periods (code, name_en, name_ar, start_time, end_time, display_order, is_active) VALUES
  ('MORNING',   'Morning Shift (08:00 AM – 12:00 PM)',   'الفترة الصباحية (08:00 ص – 12:00 م)', '08:00:00', '12:00:00', 1, TRUE),
  ('AFTERNOON', 'Afternoon Shift (12:00 PM – 04:00 PM)', 'الفترة المسائية (12:00 م – 04:00 م)', '12:00:00', '16:00:00', 2, TRUE)
ON CONFLICT (code) DO UPDATE
  SET name_en = EXCLUDED.name_en,
      name_ar = EXCLUDED.name_ar,
      start_time = EXCLUDED.start_time,
      end_time = EXCLUDED.end_time;

INSERT INTO clinics (department_id, clinic_number, name, building, floor, is_active) VALUES
  ((SELECT department_id FROM departments WHERE code = 'RESTORATIVE'), 'C1', 'Restorative & Filling Clinic A', 'Main Dental Hospital', '1st Floor', TRUE),
  ((SELECT department_id FROM departments WHERE code = 'ENDO'),        'C2', 'Endodontics Clinic B',           'Main Dental Hospital', '2nd Floor', TRUE),
  ((SELECT department_id FROM departments WHERE code = 'PERIO'),       'C3', 'Periodontics & Scaling Clinic',  'Main Dental Hospital', '1st Floor', TRUE),
  ((SELECT department_id FROM departments WHERE code = 'SURGERY'),     'C4', 'Oral Surgery Clinic',            'Main Dental Hospital', 'Ground',    TRUE),
  ((SELECT department_id FROM departments WHERE code = 'PROSTHO'),     'C5', 'Prosthodontics Clinic',          'Main Dental Hospital', '3rd Floor', TRUE),
  ((SELECT department_id FROM departments WHERE code = 'PEDO'),        'C6', 'Pediatric Dentistry Clinic',     'Main Dental Hospital', '2nd Floor', TRUE),
  ((SELECT department_id FROM departments WHERE code = 'ORTHO'),       'C7', 'Orthodontics Clinic',            'Main Dental Hospital', '3rd Floor', TRUE)
ON CONFLICT (clinic_number) DO UPDATE
  SET name = EXCLUDED.name,
      building = EXCLUDED.building,
      floor = EXCLUDED.floor;

-- Seed 20 physical dental chairs/beds across the clinics (20 beds = 20 tickets per period)
INSERT INTO clinic_beds (clinic_id, bed_number, label, operational_status, is_reservable) VALUES
  -- C1 (Restorative): 4 beds
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C1'), 1, 'C1-B01', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C1'), 2, 'C1-B02', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C1'), 3, 'C1-B03', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C1'), 4, 'C1-B04', 'ACTIVE', TRUE),
  -- C2 (Endodontics): 4 beds
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C2'), 1, 'C2-B01', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C2'), 2, 'C2-B02', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C2'), 3, 'C2-B03', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C2'), 4, 'C2-B04', 'ACTIVE', TRUE),
  -- C3 (Periodontics): 3 beds
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C3'), 1, 'C3-B01', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C3'), 2, 'C3-B02', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C3'), 3, 'C3-B03', 'ACTIVE', TRUE),
  -- C4 (Oral Surgery): 3 beds
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C4'), 1, 'C4-B01', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C4'), 2, 'C4-B02', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C4'), 3, 'C4-B03', 'ACTIVE', TRUE),
  -- C5 (Prosthodontics): 2 beds
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C5'), 1, 'C5-B01', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C5'), 2, 'C5-B02', 'ACTIVE', TRUE),
  -- C6 (Pediatric): 2 beds
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C6'), 1, 'C6-B01', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C6'), 2, 'C6-B02', 'ACTIVE', TRUE),
  -- C7 (Orthodontics): 2 beds
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C7'), 1, 'C7-B01', 'ACTIVE', TRUE),
  ((SELECT clinic_id FROM clinics WHERE clinic_number = 'C7'), 2, 'C7-B02', 'ACTIVE', TRUE)
ON CONFLICT (label) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 8. Default Admin & Triage Supervisor Users
--    Admin:      phone = +201000000001  | password = Admin@12345
--    Supervisor: phone = +201000000002  | password = Supervisor@12345 (code SUP-0001)
-- -----------------------------------------------------------------------------
INSERT INTO users (
  role, full_name, phone, email, password_hash,
  account_status, approved_at, phone_verified_at, preferred_language
) VALUES
  (
    'ADMIN',
    'TeethLink Hospital Administration',
    '+201000000001',
    'admin@teethlink.edu.eg',
    '$2a$10$t9DHuS2VoK6qNHvDXtr6d.t./pP.SQHPVDqd5FiJKKBjLoS/wsjQu',
    'ACTIVE',
    now(),
    now(),
    'ar'
  ),
  (
    'SUPERVISOR',
    'Dr. Hany Mahmoud (Chief Triage Supervisor)',
    '+201000000002',
    'hany.mahmoud@teethlink.edu.eg',
    '$2a$10$1j8VvpUpWLipx.ZEwlHlEu19VLOEghnHHC1jRMw4cX5JPHbHTcdXK',
    'ACTIVE',
    now(),
    now(),
    'ar'
  )
ON CONFLICT (phone) DO UPDATE
  SET password_hash = EXCLUDED.password_hash,
      account_status = 'ACTIVE';

INSERT INTO supervisor_profiles (
  supervisor_id, supervisor_code, department_id, title, specialty, is_triage_examiner
)
SELECT
  u.user_id,
  'SUP-0001',
  (SELECT department_id FROM departments WHERE code = 'RESTORATIVE'),
  'Assoc. Prof. Dr.',
  'Oral Diagnosis & Restorative Dentistry',
  TRUE
FROM users u
WHERE u.phone = '+201000000002'
ON CONFLICT (supervisor_id) DO NOTHING;


-- -----------------------------------------------------------------------------
-- 9. Initial Exam Schedule Templates (Sun–Thu, 08:00–16:00, 10-Min Slots, 2 Stations)
--    ISO day_of_week: 7=Sun, 1=Mon, 2=Tue, 3=Wed, 4=Thu
-- -----------------------------------------------------------------------------
INSERT INTO exam_schedule_templates (
  day_of_week, start_time, end_time, slot_minutes, stations, effective_from, is_active, created_by
)
SELECT
  dow,
  TIME '08:00:00',
  TIME '16:00:00',
  10,
  2,
  CURRENT_DATE,
  TRUE,
  (SELECT user_id FROM users WHERE phone = '+201000000001')
FROM unnest(ARRAY[1, 2, 3, 4, 5, 6, 7]::SMALLINT[]) AS dow
WHERE NOT EXISTS (
  SELECT 1 FROM exam_schedule_templates est WHERE est.day_of_week = dow AND est.is_active = TRUE
);

-- Pre-materialize 10-minute Initial Exam slots for CURRENT_DATE .. CURRENT_DATE + 3 days
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
 AND d::DATE >= est.effective_from
 AND (est.effective_to IS NULL OR d::DATE <= est.effective_to)
CROSS JOIN LATERAL generate_series(
  d::DATE + est.start_time,
  d::DATE + est.end_time - (est.slot_minutes || ' minutes')::INTERVAL,
  (est.slot_minutes || ' minutes')::INTERVAL
) AS slot_ts
CROSS JOIN LATERAL generate_series(1, est.stations) AS st_no
WHERE NOT EXISTS (
  SELECT 1
  FROM calendar_exceptions ce
  WHERE ce.exception_date = d::DATE
    AND ce.scope IN ('HOSPITAL', 'EXAM_CLINIC')
    AND ce.is_closed = TRUE
)
ON CONFLICT (exam_date, start_time, station_no) DO NOTHING;

COMMIT;
