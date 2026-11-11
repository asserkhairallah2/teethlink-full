/**
 * TeethLink — Core Application & Interactive UI Engine
 * Strictly aligned with:
 *   1. Refrences/TeethLink prototype(1).html
 *   2. Refrences/01_accounts_medical (1).png (Chen ERD)
 *   3. Refrences/schema (1).png (Relational Database Schema)
 *   4. Refrences/dental_matching_workflow_v3 (1).docx
 */

const API_BASE = '/api/v1';

// -----------------------------------------------------------------------------
// 1. Icon Library (matching TeethLink prototype)
// -----------------------------------------------------------------------------
const P = {
  tooth: '<path d="M8 3c-2.8 0-5 2.2-5 5.2 0 2.3 1 3.6 1.5 6.2.4 2.4 1 6.6 2.7 6.6 1.6 0 1.5-4 3.8-4s2.2 4 3.8 4c1.7 0 2.3-4.2 2.7-6.6.5-2.6 1.5-3.9 1.5-6.2C21 5.2 18.8 3 16 3c-1.7 0-2.7 1-4 1S9.7 3 8 3z"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V20h14V9.5"/><path d="M10 20v-6h4v6"/>',
  clipboard: '<rect x="8" y="3" width="8" height="4" rx="1"/><path d="M16 5h2a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2"/><path d="M9 13h6M9 17h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
  search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
  msg: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  shield: '<path d="M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z"/><path d="m9 12 2 2 4-4"/>',
  grad: '<path d="m2 9 10-5 10 5-10 5z"/><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5"/>',
  checkc: '<circle cx="12" cy="12" r="9"/><path d="m8.5 12 2.5 2.5 4.5-5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
  send: '<path d="m22 2-7 20-4-9-9-4z"/><path d="M22 2 11 13"/>',
  cr: '<path d="m9 6 6 6-6 6"/>',
  cl: '<path d="m15 6-6 6 6 6"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 21a7 7 0 0 1 14 0M17 4a3.5 3.5 0 0 1 0 7M22 21a7 7 0 0 0-4-6"/>',
  database: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/><path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>',
  img: '<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'
};

const I = (name, size = 20, fill = false) => `
  <svg class="i" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${fill ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    ${P[name] || P.file}
  </svg>
`;

// Status badges
const ST = {
  wait: ['Waiting for Student', 'a'],
  res: ['Reserved / Pending Patient', 'a'],
  conf: ['Confirmed', 'ok'],
  done: ['Completed', 'ok'],
  pend: ['Pending Approval', 'a'],
  appr: ['Approved', 'ok'],
  rej: ['Rejected', 'r'],
  rev: ['Awaiting Review', 'a']
};

const bd = (k) => `<span class="bd ${ST[k]?.[1] || 'g'}">${ST[k]?.[0] || k}</span>`;

// Catalog mappings aligned with backend medical_conditions & allergies tables
const CONDITION_CATALOG_MAP = [
  { id: 1, name: 'Diabetes', isCritical: true },
  { id: 2, name: 'High blood pressure', isCritical: true },
  { id: 3, name: 'Heart disease', isCritical: true },
  { id: 4, name: 'Blood thinners or bleeding disorder', isCritical: true },
  { id: 5, name: 'Kidney or liver disease', isCritical: true },
  { id: 6, name: 'Asthma or epilepsy', isCritical: false },
  { id: 7, name: 'Thyroid disorder', isCritical: false },
  { id: 8, name: 'Pregnancy or breastfeeding', isCritical: false },
  { id: 9, name: 'Bone treatment or head/neck radiotherapy', isCritical: false },
  { id: 10, name: 'Smoking', isCritical: false }
];

const ALLERGY_CATALOG_MAP = [
  { id: 1, name: 'Penicillin or other antibiotics' },
  { id: 2, name: 'Local anaesthetic' },
  { id: 3, name: 'Latex (gloves)' },
  { id: 4, name: 'Aspirin or NSAIDs' },
  { id: 5, name: 'Iodine' },
  { id: 6, name: 'Metals such as nickel' }
];

// -----------------------------------------------------------------------------
// 2. Application State
// -----------------------------------------------------------------------------
const S = {
  id: 'splash',
  role: 'patient',
  err: '',
  msg: '',
  modal: null,

  // Patient registration
  p_name: '',
  p_phone: '',
  p_email: '',
  p_pass: '',
  p_age: '',
  p_med: ['Diabetes', 'Penicillin or other antibiotics'],
  p_allergies: ['Penicillin or other antibiotics'],
  p_meds: 'Metformin 500mg',
  p_consent: 1,

  // Student registration
  s_name: '',
  s_age: '23',
  s_univ: 'Cairo University',
  s_col: 'Faculty of Dentistry',
  s_year: '5',
  s_phone: '',
  s_email: '',
  s_pass: '',
  s_sid: '4', // Supervisor ID (required)
  s_sid_verified: null,
  s_sres: '',

  // Supervisor registration
  a_name: '',
  a_dept_id: '4', // Default to Oral & Maxillofacial Surgery
  a_spec: 'Oral & Maxillofacial Surgery',
  a_phone: '',
  a_email: '',
  a_pass: '',
  a_copied: 0,

  // Admin approvals & accounts
  adminTab: 'ALL',
  pendingAccounts: [],
  selectedAccount: null,
  rejectReason: '',
  auditLogs: [],
  systemStats: {},

  // Database Schemas Viewer
  schemaTab: 'AUTH', // 'AUTH' | 'FULL'

  // Logged-in session
  user: null,
  token: null
};

// Fixed condition display list
const CND = CONDITION_CATALOG_MAP.map(c => c.name);
const ALG = ALLERGY_CATALOG_MAP.map(a => a.name);

// Helper UI builders
const B = (title, go, cls = '') => `<button class="b ${cls}" data-go="${go}">${title}</button>`;
const H = (title, back = '', right = '') => `
  <div class="h">
    ${back ? `<a data-go="${back}" aria-label="Back">${I('cl', 20)}</a>` : ''}
    <b>${title}</b>
    <span class="sp"></span>
    ${right}
  </div>
`;
const C = (content, go = '', cls = '') => `
  <div class="c ${cls}" ${go ? `data-go="${go}"` : ''}>
    ${content}
  </div>
`;
const F = (label, ph, key, type = 'text', val = '') => `
  <label>${label}</label>
  <input type="${type}" placeholder="${ph}" data-k="${key}" value="${val !== undefined && val !== '' ? val : (S[key] || '')}">
`;

const swRow = (label, on, doAction, val) => `
  <div class="row" style="margin:8px 0;padding:6px 0;border-bottom:1px solid #f0f5fa" data-do="${doAction}" data-v="${val}">
    <span style="font-size:13.5px;color:var(--tx)">${label}</span>
    <span class="sw ${on ? 'on' : ''}"></span>
  </div>
`;

// -----------------------------------------------------------------------------
// 3. Screen Templates
// -----------------------------------------------------------------------------
const SC = {
  // Splash Screen
  splash: () => `
    <div class="logo">${I('tooth', 34)}</div>
    <h2 style="text-align:center">TeethLink</h2>
    <p style="text-align:center">Dental care from supervised dental students.<br>O6U Faculty of Dentistry.</p>
    <div style="height:80px"></div>
    ${B('Get Started', 'entry')}
    <p style="text-align:center;margin-top:16px">
      <a data-go="p_login" style="color:var(--gd);font-weight:700;cursor:pointer">Log in to existing account</a>
    </p>
  `,

  // Role Selection ("Who are you?")
  entry: () => `
    ${H('Welcome', 'splash')}
    <h2>Who are you?</h2>
    <p>Choose your role to continue.</p>

    ${C(`
      <div class="row">
        <span class="ic">${I('user')}</span>
        <div style="flex:1">
          <b>I am a Patient</b>
          <p>Register with medical questionnaire &amp; request care.</p>
        </div>
        ${I('cr', 18)}
      </div>
    `, 'p_signup')}

    ${C(`
      <div class="row">
        <span class="ic">${I('grad')}</span>
        <div style="flex:1">
          <b>I am a Dental Student</b>
          <p>Register with university ID &amp; link to Supervisor ID.</p>
        </div>
        ${I('cr', 18)}
      </div>
    `, 's_reg')}

    ${C(`
      <div class="row">
        <span class="ic">${I('shield')}</span>
        <div style="flex:1">
          <b>Academic Supervisor</b>
          <p>Review student cases &amp; manage Supervisor ID (Web).</p>
        </div>
        ${I('cr', 18)}
      </div>
    `, 'a_reg')}

    ${C(`
      <div class="row">
        <span class="ic">${I('users')}</span>
        <div style="flex:1">
          <b>System Admin</b>
          <p>Approve accounts, issue supervisor codes &amp; audit log.</p>
        </div>
        ${I('cr', 18)}
      </div>
    `, 'm_login')}
  `,

  // ==========================================
  // PATIENT SCREENS
  // ==========================================
  p_signup: () => `
    ${H('Create Account', 'entry')}
    <h2>Patient Registration</h2>
    <p>Step 1 of 2: Basic account credentials.</p>

    <div class="demo-bar">
      <small>Quick Fill Demo:</small>
      <span class="demo-pill" data-do="fill_patient">Sara Ahmed Hassan</span>
    </div>

    ${F('Full Name *', 'e.g. Sara Ahmed Hassan', 'p_name')}
    ${F('Phone Number *', 'e.g. +201000000201', 'p_phone', 'tel')}
    ${F('Email Address', 'e.g. sara.hassan@gmail.com', 'p_email', 'email')}
    ${F('Password *', 'At least 8 characters', 'p_pass', 'password')}
    ${F('Age or Area', 'e.g. 29, Giza', 'p_age')}

    ${S.err ? `<div class="err">${S.err}</div>` : ''}

    <p style="margin-top:14px">Next: A short clinical questionnaire to ensure patient safety before receiving care.</p>
    <button class="b" data-do="patient_step1">Continue to Medical Profile</button>
    <p style="text-align:center;margin-top:12px">
      Already registered? <a data-go="p_login" style="color:var(--gd);font-weight:700;cursor:pointer">Log in</a>
    </p>
  `,

  p_med: () => `
    ${H('Medical Profile', 'p_signup')}
    <h2>Medical History</h2>
    <p>Answers are saved to your permanent medical record and drive clinical safety flags.</p>

    <div class="c m">
      <div style="font-weight:700;color:var(--gd);margin-bottom:6px">Active Risk Flags:</div>
      <div>
        ${S.p_med.map(m => `<span class="bd a" style="margin:2px 4px 2px 0">${m}</span>`).join('')}
        ${S.p_allergies.map(a => `<span class="bd r" style="margin:2px 4px 2px 0">Allergy: ${a}</span>`).join('')}
      </div>
      <p style="font-size:12.5px;margin-top:6px">Reviewing dental students and supervisors inspect these flags before scheduling appointments.</p>
    </div>

    <h3>1. Medical Conditions</h3>
    ${CND.map(c => swRow(c, S.p_med.includes(c), 'chk_cond', c)).join('')}

    <h3>2. Drug &amp; Material Allergies</h3>
    ${ALG.map(a => swRow(a, S.p_allergies.includes(a), 'chk_alg', a)).join('')}

    ${F('Current Medications', 'e.g. Metformin 500mg, Warfarin, Aspirin', 'p_meds')}

    <h3>3. Educational Photo Consent</h3>
    ${swRow('Allow student to show anonymous Before &amp; After photos on profile', S.p_consent, 'chk_cons', '')}
    <small>Your face and identifying contact details are strictly protected and never shared publicly.</small>

    ${S.err ? `<div class="err">${S.err}</div>` : ''}

    <button class="b" data-do="submit_patient">Submit for Admin Approval</button>
    ${B('Back to Account Info', 'p_signup', 'o')}
  `,

  p_pend: () => `
    <div class="logo">${I('clock', 32)}</div>
    <h2 style="text-align:center">Account Pending Approval</h2>
    <p style="text-align:center">${bd('pend')}</p>
    <div class="c m" style="text-align:center">
      <b>Thank you, ${S.p_name || 'Patient'}!</b>
      <p>An administrator is reviewing your account and medical safety profile. You will be able to request dental care once approved.</p>
    </div>
    <div class="c">
      <b>Medical Profile Submitted:</b>
      <p>Conditions: ${S.p_med.length ? S.p_med.join(', ') : 'None'}</p>
      <p>Allergies: ${S.p_allergies.length ? S.p_allergies.join(', ') : 'None'}</p>
      <p>Photo Consent: ${S.p_consent ? 'Granted (Anonymous)' : 'Declined'}</p>
    </div>
    <button class="b s" data-go="m_login">Open Admin Dashboard to Approve</button>
    ${B('Back to Home', 'splash', 'o')}
  `,

  p_login: () => `
    ${H('Patient Login', 'entry')}
    <h2>Welcome Back</h2>
    <p>Log in with your registered phone or email.</p>

    <div class="demo-bar">
      <small>Quick Login Demo Account:</small>
      <span class="demo-pill" data-do="login_as" data-v="sara.hassan@gmail.com|Patient@12345">Sara Ahmed Hassan</span>
    </div>

    ${F('Email or Phone Number', 'sara.hassan@gmail.com', 'p_email')}
    ${F('Password', '••••••••', 'p_pass', 'password')}

    ${S.err ? `<div class="err">${S.err}</div>` : ''}

    <button class="b" data-do="login_patient">Log In</button>
    <p style="text-align:center;margin-top:14px">
      Don't have an account? <a data-go="p_signup" style="color:var(--gd);font-weight:700;cursor:pointer">Sign up</a>
    </p>
  `,

  p_prof: () => `
    ${H('Patient Profile', '', `<a data-do="logout">${I('user', 18)}</a>`)}
    <div class="c m row">
      <div>
        <h2 style="margin:0">${S.user?.fullName || S.p_name || 'Sara Ahmed Hassan'}</h2>
        <p>${S.user?.phone || '+201000000201'} · ${S.user?.email || 'sara.hassan@gmail.com'}</p>
        <span class="bd ok">Account Approved</span>
      </div>
      <span class="ic">${I('user', 24)}</span>
    </div>

    <h3>Medical Safety Profile</h3>
    <div class="c">
      <div style="font-weight:600;margin-bottom:6px">Active Risk Flags:</div>
      <div>
        <span class="bd a">Diabetes</span>
        <span class="bd r">Allergy: Penicillin</span>
      </div>
      <p style="margin-top:8px">Photo Consent: <b>${S.p_consent ? 'Granted' : 'Declined'}</b></p>
      <button class="b o" data-go="p_med" style="margin-top:10px">Update Medical History</button>
    </div>

    <h3>Case History &amp; Records</h3>
    <div class="c">
      <div class="row">
        <b>CASE-1031 · Teeth Cleaning</b>
        ${bd('done')}
      </div>
      <p>Scaling &amp; polishing completed. Plaque removed. Student: Dr. Omar Khaled · Supervisor: Dr. Hany Mahmoud.</p>
    </div>

    ${B('Log Out', 'splash', 'd')}
  `,

  // ==========================================
  // STUDENT DOCTOR SCREENS
  // ==========================================
  s_reg: () => `
    ${H('Student Registration', 'entry')}
    <h2>Student Doctor Sign Up</h2>
    <p>Mandatory linking to your Academic Supervisor via Supervisor ID.</p>

    <div class="demo-bar">
      <small>Quick Fill Demo:</small>
      <span class="demo-pill" data-do="fill_student">Omar Khaled (Sup ID: 4)</span>
    </div>

    ${F('Full Name *', 'e.g. Omar Khaled', 's_name')}
    ${F('Age', 'e.g. 23', 's_age', 'number')}
    ${F('University', 'Cairo University / O6U', 's_univ')}
    ${F('Faculty / College', 'Faculty of Dentistry', 's_col')}

    <label>Academic Year *</label>
    <select class="f" data-k="s_year">
      <option value="4" ${S.s_year == '4' ? 'selected' : ''}>Year 4 (Clinical Undergraduate)</option>
      <option value="5" ${S.s_year == '5' ? 'selected' : ''}>Year 5 (Senior Undergraduate)</option>
      <option value="6" ${S.s_year == '6' ? 'selected' : ''}>Intern Doctor</option>
    </select>

    ${F('Phone Number *', '+201000000101', 's_phone', 'tel')}
    ${F('University Email Address *', 'omar.khaled@o6u.edu.eg', 's_email', 'email')}
    ${F('Password *', 'At least 8 characters', 's_pass', 'password')}

    <label>Supervisor ID (Required) *</label>
    <div style="position:relative">
      <input type="text" placeholder="e.g. 4 or 7 or SUP-0001" data-k="s_sid" value="${S.s_sid || ''}" id="supIdInput">
      <button class="b o" data-do="verify_sup_id" style="width:auto;position:absolute;right:4px;top:4px;height:38px;padding:0 12px;margin:0">Verify ID</button>
    </div>

    ${S.s_sid_verified ? `
      <div class="success-msg">
        ✓ Verified: <b>${S.s_sid_verified.full_name}</b> (${S.s_sid_verified.title || 'Supervisor'}, ${S.s_sid_verified.specialty || 'Dentistry'})
      </div>
    ` : S.s_sres ? `
      <div class="err">${S.s_sres}</div>
    ` : `
      <small>Ask your supervisor for their ID. Try <b>4</b> (Dr. Hany) or <b>7</b> (Dr. Mona).</small>
    `}

    <label style="margin-top:14px">Student ID Card Verification Proof</label>
    <div class="c m" style="text-align:center;padding:16px;cursor:pointer">
      ${I('file', 24)}<br>
      <b>student-card-proof.jpg</b><br>
      <small>Uploaded (Faculty ID verified)</small>
    </div>

    ${S.err ? `<div class="err">${S.err}</div>` : ''}

    <button class="b" data-do="submit_student">Submit Account for Approval</button>
    <p style="text-align:center;margin-top:12px">
      Already have an account? <a data-go="s_login" style="color:var(--gd);font-weight:700;cursor:pointer">Log in</a>
    </p>
  `,

  s_pend: () => `
    <div class="logo">${I('lock', 32)}</div>
    <h2 style="text-align:center">Pending Supervisor &amp; Admin Approval</h2>
    <p style="text-align:center">${bd('pend')}</p>
    <div class="c m" style="text-align:center">
      <b>Registration Received!</b>
      <p>Your academic supervisor and the system administrator are reviewing your credentials. You cannot take cases until your account is approved.</p>
    </div>
    <div class="c">
      <b>Application Details:</b>
      <p>Student: <b>${S.s_name || 'Omar Khaled'}</b></p>
      <p>Year: Year ${S.s_year || 5}</p>
      <p>Linked Supervisor: <b>${S.s_sid_verified?.full_name || 'Dr. Hany Mahmoud (Supervisor ID: ' + (S.s_sid || '4') + ')'}</b></p>
    </div>
    <button class="b s" data-go="m_login">Open Admin Dashboard to Approve</button>
    ${B('Back to Home', 'splash', 'o')}
  `,

  s_login: () => `
    ${H('Student Login', 'entry')}
    <h2>Welcome Back, Doctor</h2>
    <p>Sign in to access your assigned cases and supervisor feedback.</p>

    <div class="demo-bar">
      <small>Quick Login Demo Account:</small>
      <span class="demo-pill" data-do="login_as" data-v="omar.khaled@o6u.edu.eg|Doctor@12345">Dr. Omar Khaled (Year 5)</span>
    </div>

    ${F('Email Address or Phone', 'omar.khaled@o6u.edu.eg', 's_email')}
    ${F('Password', '••••••••', 's_pass', 'password')}

    ${S.err ? `<div class="err">${S.err}</div>` : ''}

    <button class="b" data-do="login_student">Log In</button>
    <p style="text-align:center;margin-top:14px">
      New student doctor? <a data-go="s_reg" style="color:var(--gd);font-weight:700;cursor:pointer">Register here</a>
    </p>
  `,

  s_prof: () => `
    ${H('Doctor Profile', '', `<a data-do="logout">${I('user', 18)}</a>`)}
    <div class="c m row">
      <div>
        <h2 style="margin:0">${S.user?.fullName || S.s_name || 'Dr. Omar Khaled'}</h2>
        <p>Cairo University · Year 5 · Senior Dental Student</p>
        <span class="bd ok">Supervisor Approved</span>
      </div>
      <span class="ic">${I('grad', 24)}</span>
    </div>

    <div class="c row">
      <div>
        <b>Academic Progress: 8 / 12 Cases</b>
        <p>Validated clinical treatments approved by your supervisor.</p>
      </div>
      <div class="ring" style="--p:67"><div>67%</div></div>
    </div>

    <div class="c m">
      <small>Linked Academic Supervisor:</small>
      <div style="font-weight:700;font-size:16px;color:var(--gd);margin:4px 0">Dr. Hany Mahmoud</div>
      <p style="margin:0">Chief Supervisor · Oral Diagnosis &amp; Restorative Dentistry</p>
      <span class="bd g" style="margin-top:6px">Supervisor ID: SUP-0001 (Code 4)</span>
    </div>

    <h3>Approved Clinical Services</h3>
    <div class="c">
      <div class="row"><b>Initial Dental Examination</b><span class="bd ok">Approved</span></div>
      <div class="bar2"><i style="width:100%"></i></div>
      <div class="row" style="margin-top:12px"><b>Teeth Cleaning &amp; Scaling</b><span class="bd ok">Approved</span></div>
      <div class="bar2"><i style="width:80%"></i></div>
      <div class="row" style="margin-top:12px"><b>Dental Filling (Class I &amp; II)</b><span class="bd a">Awaiting Validation</span></div>
      <div class="bar2"><i style="width:20%"></i></div>
    </div>

    ${B('Log Out', 'splash', 'd')}
  `,

  // ==========================================
  // SUPERVISOR SCREENS
  // ==========================================
  a_reg: () => `
    ${H('Supervisor Registration', 'entry')}
    <h2>Academic Supervisor Registration</h2>
    <p>Supervise dental students, approve clinical cases, and review completion reports.</p>

    <div class="demo-bar">
      <small>Quick Fill Demo:</small>
      <span class="demo-pill" data-do="fill_supervisor">Dr. Nadia Samir</span>
    </div>

    ${F('Full Name with Academic Title *', 'e.g. Assoc. Prof. Dr. Nadia Samir', 'a_name')}

    <label>Clinical Department *</label>
    <select class="f" data-k="a_dept_id">
      <option value="4" ${S.a_dept_id == '4' || !S.a_dept_id ? 'selected' : ''}>Oral &amp; Maxillofacial Surgery (جراحة الفم والفكين)</option>
      <option value="1" ${S.a_dept_id == '1' ? 'selected' : ''}>Restorative &amp; Operative (العلاج التحفظي والحشو)</option>
      <option value="2" ${S.a_dept_id == '2' ? 'selected' : ''}>Endodontics (علاج الجذور والأعصاب)</option>
      <option value="3" ${S.a_dept_id == '3' ? 'selected' : ''}>Periodontics (طب وجراحة اللثة والتنظيف)</option>
      <option value="5" ${S.a_dept_id == '5' ? 'selected' : ''}>Prosthodontics (الاستعاضة الصناعية والتركيبات)</option>
      <option value="6" ${S.a_dept_id == '6' ? 'selected' : ''}>Pediatric Dentistry (طب أسنان الأطفال)</option>
      <option value="7" ${S.a_dept_id == '7' ? 'selected' : ''}>Orthodontics (تقويم الأسنان)</option>
    </select>

    ${F('Academic Specialty *', 'e.g. Oral & Maxillofacial Surgery', 'a_spec')}
    ${F('Phone Number *', '+201000000004', 'a_phone', 'tel')}
    ${F('University Staff Email Address *', 'nadia.samir@o6u.edu.eg', 'a_email', 'email')}
    ${F('Password *', 'At least 8 characters', 'a_pass', 'password')}

    <div class="c m">
      <b>Notice on Supervisor ID:</b>
      <p>Upon admin approval, you will be issued an official unique <b>Supervisor ID</b> (e.g. 4 or SUP-0001) which your students will enter to link their accounts to you.</p>
    </div>

    ${S.err ? `<div class="err">${S.err}</div>` : ''}

    <button class="b" data-do="submit_supervisor">Submit for Admin Approval</button>
    <p style="text-align:center;margin-top:12px">
      Already approved? <a data-go="a_login" style="color:var(--gd);font-weight:700;cursor:pointer">Log in</a>
    </p>
  `,

  a_pend: () => `
    <div class="logo">${I('clock', 32)}</div>
    <h2 style="text-align:center">Supervisor Account Pending Approval</h2>
    <p style="text-align:center">${bd('pend')}</p>
    <div class="c m" style="text-align:center">
      <b>Registration Received!</b>
      <p>The system administrator is reviewing your faculty credentials. Upon approval, you will be issued an official unique <b>Supervisor ID</b> (e.g. 4 or SUP-0001) to share with your students.</p>
    </div>
    <button class="b s" data-go="m_login">Open Admin Dashboard to Review &amp; Approve</button>
    ${B('Back to Home', 'splash', 'o')}
  `,

  a_login: () => `
    ${H('Supervisor Login', 'entry')}
    <h2>Supervisor Web Portal</h2>
    <p>Sign in to monitor affiliated students, case requests, and clinical sessions.</p>

    <div class="demo-bar">
      <small>Quick Login Demo Supervisor:</small>
      <span class="demo-pill" data-do="login_as" data-v="hany.mahmoud@teethlink.edu.eg|Supervisor@12345">Dr. Hany Mahmoud</span>
      <span class="demo-pill" data-do="login_as" data-v="mona.adel@teethlink.edu.eg|Supervisor@12345">Dr. Mona Adel</span>
    </div>

    ${F('Staff Email or Phone', 'hany.mahmoud@teethlink.edu.eg', 'a_email')}
    ${F('Password', '••••••••', 'a_pass', 'password')}

    ${S.err ? `<div class="err">${S.err}</div>` : ''}

    <button class="b" data-do="login_supervisor">Log In to Portal</button>
  `,

  a_dash: () => `
    <div class="row">
      <div>
        <h2 style="margin:0">${S.user?.fullName || 'Dr. Hany Mahmoud'}</h2>
        <p>Academic Supervisor Dashboard · Oral Diagnosis &amp; Restorative</p>
      </div>
      <button class="b o" data-do="logout" style="width:auto;height:38px;padding:0 14px;margin:0">Log Out</button>
    </div>

    <!-- Supervisor ID Banner matching TeethLink prototype(1).html -->
    <div class="c m row" style="margin-top:16px;padding:20px">
      <div>
        <small style="text-transform:uppercase;letter-spacing:.05em;color:var(--gd);font-weight:700">Your Permanent Supervisor ID</small>
        <h1 style="margin:4px 0 0;font-size:38px;color:var(--gd);letter-spacing:-.03em">
          ${S.user?.supervisorProfile?.supervisorCode || 'SUP-0001 (4)'}
        </h1>
        <p style="margin:4px 0 0">Share this ID with your dental students so they link to your roster upon registration.</p>
      </div>
      <button class="b" data-do="copy_sup_id" style="width:auto;padding:0 20px;height:48px;font-size:15px">
        ${I('copy', 18)}&nbsp;${S.a_copied ? 'Copied to Clipboard!' : 'Copy Supervisor ID'}
      </button>
    </div>

    <div class="g4" style="margin-top:16px">
      <div class="c st"><b>4</b><p>Active Students</p></div>
      <div class="c st"><b>12</b><p>Total Cases Managed</p></div>
      <div class="c st"><b>2</b><p>Pending Case Reviews</p></div>
      <div class="c st"><b>92%</b><p>Completion Rate</p></div>
    </div>

    <h3>Supervised Dental Students</h3>
    <table>
      <thead>
        <tr>
          <th>Student Doctor</th>
          <th>University / College</th>
          <th>Academic Year</th>
          <th>Validated Cases</th>
          <th>Status</th>
        </tr>
      </thead>
      <tbody>
        <tr>
          <td><b>Omar Khaled</b></td>
          <td>Cairo Univ. / Faculty of Dentistry</td>
          <td>Year 5 (Senior)</td>
          <td>8 completed</td>
          <td><span class="bd ok">Active</span></td>
        </tr>
        <tr>
          <td><b>Nourhan Tarek</b></td>
          <td>Cairo Univ. / Faculty of Dentistry</td>
          <td>Year 5 (Senior)</td>
          <td>5 completed</td>
          <td><span class="bd ok">Active</span></td>
        </tr>
        <tr>
          <td><b>Karim Mostafa</b></td>
          <td>O6U / Faculty of Dentistry</td>
          <td>Year 4 (Clinical)</td>
          <td>3 completed</td>
          <td><span class="bd ok">Active</span></td>
        </tr>
      </tbody>
    </table>

    <h3 style="margin-top:24px">Recent Clinical Audit Events</h3>
    <div class="c">
      <p><b>10:15</b> · Dr. Hany validated CASE-1031 (Teeth Cleaning) for Dr. Omar Khaled.</p>
      <p><b>09:40</b> · Student Omar Khaled reserved CASE-1031 with Patient Sara Ahmed.</p>
      <p><b>Yesterday</b> · Admin approved new supervisor Dr. Mona Adel (Supervisor ID: SUP-0002).</p>
    </div>
  `,

  // ==========================================
  // ADMIN DASHBOARD SCREENS
  // ==========================================
  m_login: () => `
    ${H('Admin Portal', 'entry')}
    <h2>System Administrator Login</h2>
    <p>Review and approve new Patient, Student, and Supervisor accounts.</p>

    <div class="demo-bar">
      <small>Default Administrator Account:</small>
      <span class="demo-pill" data-do="login_as" data-v="admin@teethlink.edu.eg|Admin@12345">admin@teethlink.edu.eg / Admin@12345</span>
    </div>

    ${F('Admin Email Address', 'admin@teethlink.edu.eg', 'a_email')}
    ${F('Admin Password', '••••••••', 'a_pass', 'password')}

    ${S.err ? `<div class="err">${S.err}</div>` : ''}

    <button class="b" data-do="login_admin">Sign In as Admin</button>
  `,

  m_dash: () => `
    <div class="row">
      <div>
        <h2 style="margin:0">System Administration Dashboard</h2>
        <p>Review registrations, issue Supervisor IDs, configure permissions &amp; inspect audit trails.</p>
      </div>
      <div style="display:flex;gap:8px">
        <button class="b o" data-do="refresh_admin" style="width:auto;height:38px;padding:0 14px;margin:0">Refresh</button>
        <button class="b d" data-do="logout" style="width:auto;height:38px;padding:0 14px;margin:0">Log Out</button>
      </div>
    </div>

    <div class="g4" style="margin-top:16px">
      <div class="c st"><b>${S.pendingAccounts.length}</b><p>Pending Approvals</p></div>
      <div class="c st"><b>${S.systemStats?.totalUsers || 10}</b><p>Registered Users</p></div>
      <div class="c st"><b>2</b><p>Active Supervisors</p></div>
      <div class="c st"><b>4</b><p>Student Doctors</p></div>
    </div>

    <div style="margin-top:20px;display:flex;align-items:center;justify-content:space-between">
      <h3>Pending Accounts for Review</h3>
      <div>
        ${['ALL:All Roles', 'DOCTOR:Students', 'SUPERVISOR:Supervisors', 'PATIENT:Patients'].map(t => {
          const [k, lbl] = t.split(':');
          return `<span class="chip ${S.adminTab === k ? 'on' : ''}" data-do="filter_admin" data-v="${k}">${lbl}</span>`;
        }).join('')}
      </div>
    </div>

    ${S.pendingAccounts.length === 0 ? `
      <div class="c m" style="text-align:center;padding:30px">
        ${I('checkc', 32)}
        <h3 style="margin:8px 0 4px">All caught up!</h3>
        <p>There are no pending accounts waiting for approval at this time.</p>
        <button class="b s" data-go="s_reg" style="width:auto;display:inline-flex;padding:0 20px;margin-top:10px">Register a New Student</button>
      </div>
    ` : `
      <table>
        <thead>
          <tr>
            <th>User / Applicant</th>
            <th>Role</th>
            <th>Key Information</th>
            <th>Verification Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${S.pendingAccounts.map(acc => `
            <tr>
              <td>
                <b>${acc.fullName}</b>
                <div style="font-size:12px;color:var(--gr)">${acc.email || acc.phone}</div>
              </td>
              <td><span class="bd ${acc.role === 'SUPERVISOR' ? 'g' : acc.role === 'DOCTOR' ? 'ok' : 'a'}">${acc.role}</span></td>
              <td>
                ${acc.role === 'DOCTOR' ? `
                  Year ${acc.doctorProfile?.academicYear || 5} · Supervisor ID: <b>${acc.doctorProfile?.supervisorId || '4'}</b>
                ` : acc.role === 'SUPERVISOR' ? `
                  Dept #${acc.supervisorProfile?.departmentId || 4} · ${acc.supervisorProfile?.specialty || 'Specialist'}
                ` : `
                  ${acc.patientProfile?.hasCriticalCondition ? '<span class="bd a">Has Critical Condition</span>' : 'Routine'} · Consent: ${acc.patientProfile?.photoConsent ? 'Yes' : 'No'}
                `}
              </td>
              <td>
                ${acc.role === 'DOCTOR' ? '<span class="bd g">ID Proof Uploaded</span>' : '<span class="bd g">Self Verified</span>'}
              </td>
              <td>
                <button class="b o" data-do="review_account" data-v="${acc.userId}" style="height:32px;padding:0 12px;margin:0;font-size:12px">Review &amp; Approve</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `}

    <h3 style="margin-top:28px">System Audit Trail (Latest Events)</h3>
    <div class="c">
      <p><b>11:02</b> · System seeded with 2 active clinical supervisors: Dr. Hany Mahmoud (SUP-0001) &amp; Dr. Mona Adel (SUP-0002).</p>
      <p><b>10:48</b> · Administrator logged in and verified database connectivity on PostgreSQL 16.</p>
      <p><b>09:30</b> · Patient registration questionnaire catalog initialized with 5 critical conditions and 6 allergy profiles.</p>
    </div>
  `,

  // ==========================================
  // DATABASE SCHEMAS & DIAGRAMS VIEWER
  // ==========================================
  schemas: () => `
    <div class="schema-viewer-container">
      <div class="schema-header">
        <div>
          <h2 style="margin:0">Database Schemas &amp; Architecture Diagrams</h2>
          <p style="margin:2px 0 0">Visual Chen ERDs, Relational Schemas &amp; PostgreSQL DDL for TeethLink.</p>
        </div>
        <div style="display:flex;gap:8px">
          <span class="chip ${S.schemaTab === 'AUTH' ? 'on' : ''}" data-do="switch_schema" data-v="AUTH">
            Authentication &amp; Medical Schema
          </span>
          <span class="chip ${S.schemaTab === 'FULL' ? 'on' : ''}" data-do="switch_schema" data-v="FULL">
            Full System Relational Schema (24 Tables)
          </span>
        </div>
      </div>

      ${S.schemaTab === 'AUTH' ? `
        <div class="c m" style="margin:0 0 12px;padding:12px 16px">
          <b>Schema Focus: Authentication, Accounts &amp; Medical Questionnaire</b>
          <p style="margin:2px 0 0">
            Entities: <code>users</code> (Root), <code>supervisor_profiles</code>, <code>student_doctor_profiles</code>, <code>patient_profiles</code>,
            <code>medical_conditions</code>, <code>patient_conditions</code>, <code>allergies</code>, <code>patient_allergies</code>, <code>patient_medications</code>, <code>audit_logs</code>.
          </p>
        </div>
        <div class="schema-frame">
          <img src="/diagrams/01_auth_medical_schema.svg" alt="Authentication &amp; Medical Schema Diagram" style="width:100%;max-height:640px;object-fit:contain">
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <a class="b o" href="/diagrams/01_auth_medical_schema.svg" target="_blank" style="text-decoration:none">Open SVG Diagram in New Tab</a>
          <a class="b s" href="/sql/auth_schema.sql" download="auth_schema.sql" style="text-decoration:none">Download auth_schema.sql</a>
        </div>
      ` : `
        <div class="c m" style="margin:0 0 12px;padding:12px 16px">
          <b>Schema Focus: Complete 24-Entity TeethLink Hospital System</b>
          <p style="margin:2px 0 0">
            Directly matching <code>Refrences/schema (1).png</code>: Accounts, Medical Safety, Clinical Services, Cases, Appointments,
            Treatment Reports, Before/After Photos, Student Portfolio, Ratings, Notifications, Audit Logs, and Hospital Beds.
          </p>
        </div>
        <div class="schema-frame">
          <img src="/diagrams/02_full_system_schema.svg" alt="Full System Relational Database Schema Diagram" style="width:100%;max-height:640px;object-fit:contain">
        </div>
        <div style="display:flex;gap:10px;margin-top:12px">
          <a class="b o" href="/diagrams/02_full_system_schema.svg" target="_blank" style="text-decoration:none">Open SVG Diagram in New Tab</a>
          <a class="b s" href="/sql/full_system_schema.sql" download="full_system_schema.sql" style="text-decoration:none">Download full_system_schema.sql</a>
        </div>
      `}
    </div>
  `
};

// -----------------------------------------------------------------------------
// 4. Main Render Function
// -----------------------------------------------------------------------------
function render() {
  const sc = document.getElementById('sc');
  const ph = document.getElementById('ph');
  const id = S.id;

  // Frame width adjustment based on view type
  if (id === 'schemas') {
    ph.className = 'ph wide';
  } else if (id.startsWith('a_') || id.startsWith('m_')) {
    ph.className = 'ph web';
  } else {
    ph.className = 'ph';
  }

  // Render view
  const templateFn = SC[id] || SC.splash;
  sc.innerHTML = templateFn();

  // Modal dialog overlay
  if (S.modal) {
    const modalHtml = `
      <div class="mod">
        <div class="c">
          <h3 style="margin-top:0">${S.modal.title}</h3>
          <p>${S.modal.message}</p>
          ${S.modal.showReason ? `
            <label>Rejection Reason (Required) *</label>
            <textarea data-k="rejectReason" placeholder="Please provide specific feedback for the applicant">${S.rejectReason || ''}</textarea>
          ` : ''}
          ${S.err ? `<div class="err">${S.err}</div>` : ''}
          <div style="display:flex;gap:10px;margin-top:14px;flex-wrap:wrap">
            <button class="b ${S.modal.btnClass || ''}" data-do="${S.modal.action}">${S.modal.confirmText || 'Confirm'}</button>
            ${S.modal.showReject && !S.modal.showReason ? `
              <button class="b d" data-do="prompt_reject">Reject with Reason</button>
            ` : ''}
            <button class="b o" data-do="close_modal">Cancel</button>
          </div>
        </div>
      </div>
    `;
    sc.insertAdjacentHTML('beforeend', modalHtml);
  }

  // Update Top Role Bar
  const roles = [
    { key: 'patient', name: 'Patient', go: 'p_signup' },
    { key: 'student', name: 'Student Doctor', go: 's_reg' },
    { key: 'supervisor', name: 'Supervisor (Web)', go: 'a_login' },
    { key: 'admin', name: 'Admin (Web)', go: 'm_login' },
    { key: 'schemas', name: 'Database Schemas &amp; Diagrams', go: 'schemas', isSchema: true }
  ];

  const currentCategory = id.startsWith('p_') ? 'patient'
    : id.startsWith('s_') ? 'student'
    : id.startsWith('a_') ? 'supervisor'
    : id.startsWith('m_') ? 'admin'
    : id === 'schemas' ? 'schemas' : 'patient';

  document.getElementById('roleBar').innerHTML = roles.map(r => `
    <button class="${r.key === currentCategory ? 'on' : ''} ${r.isSchema ? 'pill-schema' : ''}" data-go="${r.go}">
      ${r.isSchema ? I('database', 16) : ''}
      ${r.name}
    </button>
  `).join('');
}

// -----------------------------------------------------------------------------
// 5. Event Dispatcher & Actions
// -----------------------------------------------------------------------------
document.addEventListener('click', async (e) => {
  const d = e.target.closest('[data-do]');
  const g = e.target.closest('[data-go]');

  // Navigation (data-go)
  if (g) {
    const targetScreen = g.dataset.go;
    S.id = targetScreen;
    S.err = '';
    S.msg = '';
    S.modal = null;

    if (targetScreen === 'm_dash' && S.token) {
      loadPendingAccounts();
    }
    render();
    document.getElementById('sc').scrollTop = 0;
    return;
  }

  // Interactive actions (data-do)
  if (d) {
    const action = d.dataset.do;
    const val = d.dataset.v;

    // Quick-fill buttons
    if (action === 'fill_patient') {
      S.p_name = 'Sara Ahmed Hassan';
      S.p_phone = '+201000000201';
      S.p_email = 'sara.hassan@gmail.com';
      S.p_pass = 'Patient@12345';
      S.p_age = '29, Giza';
      render();
    }
    else if (action === 'fill_student') {
      S.s_name = 'Omar Khaled';
      S.s_age = '23';
      S.s_univ = 'Cairo University';
      S.s_col = 'Faculty of Dentistry';
      S.s_year = '5';
      S.s_phone = '+201000000101';
      S.s_email = 'omar.khaled@o6u.edu.eg';
      S.s_pass = 'Doctor@12345';
      S.s_sid = '4';
      verifySupervisorCode('4');
    }
    else if (action === 'fill_supervisor') {
      S.a_name = 'Dr. Nadia Samir';
      S.a_dept_id = '4';
      S.a_spec = 'Oral & Maxillofacial Surgery';
      S.a_phone = '+201000000004';
      S.a_email = 'nadia.samir@o6u.edu.eg';
      S.a_pass = 'Supervisor@12345';
      render();
    }
    else if (action === 'patient_step1') {
      if (!S.p_name || !S.p_phone || !S.p_pass) {
        S.err = 'Please fill in your name, phone number, and password.';
        render();
        return;
      }
      S.err = '';
      S.id = 'p_med';
      render();
    }
    else if (action === 'chk_cond') {
      S.p_med = S.p_med.includes(val) ? S.p_med.filter(x => x !== val) : [...S.p_med, val];
      render();
    }
    else if (action === 'chk_alg') {
      S.p_allergies = S.p_allergies.includes(val) ? S.p_allergies.filter(x => x !== val) : [...S.p_allergies, val];
      render();
    }
    else if (action === 'chk_cons') {
      S.p_consent = S.p_consent ? 0 : 1;
      render();
    }
    // Verify Supervisor ID via API
    else if (action === 'verify_sup_id') {
      const code = S.s_sid || document.getElementById('supIdInput')?.value || '';
      verifySupervisorCode(code);
    }
    // Submit Patient Registration
    else if (action === 'submit_patient') {
      await submitPatientRegistration();
    }
    // Submit Student Registration
    else if (action === 'submit_student') {
      await submitStudentRegistration();
    }
    // Submit Supervisor Registration
    else if (action === 'submit_supervisor') {
      await submitSupervisorRegistration();
    }
    // Login handlers
    else if (action === 'login_as') {
      const [idOrEmail, pass] = val.split('|');
      await executeLogin(idOrEmail, pass);
    }
    else if (action === 'login_patient') {
      await executeLogin(S.p_email, S.p_pass);
    }
    else if (action === 'login_student') {
      await executeLogin(S.s_email, S.s_pass);
    }
    else if (action === 'login_supervisor') {
      await executeLogin(S.a_email, S.a_pass);
    }
    else if (action === 'login_admin') {
      await executeLogin(S.a_email || 'admin@teethlink.edu.eg', S.a_pass || 'Admin@12345');
    }
    // Admin review actions
    else if (action === 'review_account') {
      const userId = Number(val);
      const acc = S.pendingAccounts.find(a => a.userId === userId);
      if (acc) {
        S.selectedAccount = acc;
        S.rejectReason = '';
        S.err = '';
        S.modal = {
          title: `Review Account: ${acc.fullName}`,
          message: `Role: <b>${acc.role}</b><br>Email: ${acc.email || '—'}<br>Phone: ${acc.phone}<br><br>` +
            (acc.role === 'DOCTOR' ? `Academic Year: Year ${acc.doctorProfile?.academicYear}<br>Linked Supervisor ID: <b>${acc.doctorProfile?.supervisorId || '4'}</b>` :
             acc.role === 'SUPERVISOR' ? `Department: Dept #${acc.supervisorProfile?.departmentId || 4}<br>Specialty: ${acc.supervisorProfile?.specialty || 'Oral Surgery'}<br>An official permanent Supervisor ID will be issued upon approval.` :
             `Medical Profile: ${acc.patientProfile?.hasCriticalCondition ? '<span class="bd a">Clinical Risk Flagged</span>' : 'Routine'} · Consent: ${acc.patientProfile?.photoConsent ? 'Yes' : 'No'}`),
          confirmText: 'Approve Account',
          btnClass: 'b',
          action: 'confirm_approve',
          showReject: true,
          showReason: false
        };
        render();
      }
    }
    else if (action === 'prompt_reject') {
      if (S.modal) {
        S.modal.showReason = true;
        S.modal.confirmText = 'Confirm Rejection';
        S.modal.btnClass = 'b d';
        S.modal.action = 'confirm_reject';
        render();
      }
    }
    else if (action === 'confirm_approve') {
      await executeApproveAccount(S.selectedAccount?.userId);
    }
    else if (action === 'confirm_reject') {
      await executeRejectAccount(S.selectedAccount?.userId);
    }
    else if (action === 'filter_admin') {
      S.adminTab = val;
      await loadPendingAccounts();
    }
    else if (action === 'refresh_admin') {
      await loadPendingAccounts();
    }
    else if (action === 'switch_schema') {
      S.schemaTab = val;
      render();
    }
    else if (action === 'copy_sup_id') {
      const code = S.user?.supervisorProfile?.supervisorCode || 'SUP-0001';
      if (navigator.clipboard) {
        navigator.clipboard.writeText(code);
      }
      S.a_copied = 1;
      render();
      setTimeout(() => { S.a_copied = 0; render(); }, 2500);
    }
    else if (action === 'close_modal') {
      S.modal = null;
      S.err = '';
      render();
    }
    else if (action === 'logout') {
      S.user = null;
      S.token = null;
      S.id = 'splash';
      render();
    }
  }
});

// Live text inputs binding
document.addEventListener('input', (e) => {
  const k = e.target.dataset.k;
  if (k) {
    S[k] = e.target.value;
    if (k === 's_sid') {
      S.s_sid_verified = null;
      S.s_sres = '';
    }
  }
});

document.addEventListener('change', (e) => {
  const k = e.target.dataset.k;
  if (k) {
    S[k] = e.target.value;
  }
});

// RTL / LTR toggle
document.getElementById('rtlBtn').addEventListener('click', () => {
  const isRtl = document.documentElement.dir === 'rtl';
  document.documentElement.dir = isRtl ? 'ltr' : 'rtl';
  document.getElementById('rtlBtn').textContent = isRtl ? 'RTL / عربي' : 'LTR / English';
});

// -----------------------------------------------------------------------------
// 6. Real API Client Methods
// -----------------------------------------------------------------------------
async function verifySupervisorCode(code) {
  if (!code || !code.trim()) {
    S.s_sres = 'Please enter a Supervisor ID.';
    S.s_sid_verified = null;
    render();
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/auth/supervisors/verify/${encodeURIComponent(code.trim())}`);
    const data = await res.json();
    if (data.success && data.data?.valid) {
      S.s_sid_verified = data.data.supervisor;
      S.s_sres = '';
    } else {
      S.s_sid_verified = null;
      S.s_sres = `Supervisor ID "${code}" was not found or is not approved.`;
    }
  } catch (err) {
    S.s_sres = 'Could not verify Supervisor ID. Check connection.';
  }
  render();
}

async function submitPatientRegistration() {
  try {
    S.err = '';
    // Format questionnaire responses: EVERY condition in catalog is explicitly sent
    const conditionsPayload = CONDITION_CATALOG_MAP.map((c) => {
      const isChecked = S.p_med.includes(c.name);
      return {
        conditionId: c.id,
        hasCondition: Boolean(isChecked),
        details: isChecked ? `${c.name} reported by patient` : undefined
      };
    });

    const allergiesPayload = ALLERGY_CATALOG_MAP
      .filter((a) => S.p_allergies.includes(a.name))
      .map((a) => ({
        allergyId: a.id,
        notes: `${a.name} allergy reported by patient`
      }));

    const res = await fetch(`${API_BASE}/auth/register/patient`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: S.p_name,
        phone: S.p_phone,
        email: S.p_email || undefined,
        password: S.p_pass,
        photoConsent: Boolean(S.p_consent),
        dataSharingConsent: true,
        medicalQuestionnaire: {
          conditions: conditionsPayload,
          allergies: allergiesPayload,
          medications: S.p_meds ? [{ medicationName: S.p_meds, dosage: 'Regular', isAnticoagulant: false }] : [],
          documentDelivery: 'WILL_BRING_PHYSICALLY'
        }
      })
    });

    const data = await res.json();
    if (data.success) {
      S.id = 'p_pend';
      render();
    } else {
      S.err = data.error?.message || 'Registration failed. Please check inputs.';
      render();
    }
  } catch (err) {
    S.err = 'Network error during registration: ' + err.message;
    render();
  }
}

async function submitStudentRegistration() {
  try {
    S.err = '';
    if (!S.s_name || !S.s_phone || !S.s_pass) {
      S.err = 'Name, phone, and password are required.';
      render();
      return;
    }

    const supCode = (S.s_sid || '').trim();
    if (!supCode) {
      S.err = 'Supervisor ID is required. Please enter an approved supervisor ID (e.g. 4 or 7).';
      render();
      return;
    }

    const res = await fetch(`${API_BASE}/auth/register/doctor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: S.s_name,
        phone: S.s_phone,
        email: S.s_email || undefined,
        password: S.s_pass,
        universityIdNumber: 'STU-' + Math.floor(100000 + Math.random() * 900000),
        university: S.s_univ,
        college: S.s_col,
        academicYear: Number(S.s_year || 5),
        doctorCategory: 'UNDERGRAD_STUDENT',
        supervisorCode: supCode,
        requestedDepartmentIds: [1, 2, 4]
      })
    });

    const data = await res.json();
    if (data.success) {
      S.id = 's_pend';
      render();
    } else {
      S.err = data.error?.message || 'Student registration failed.';
      render();
    }
  } catch (err) {
    S.err = 'Network error: ' + err.message;
    render();
  }
}

async function submitSupervisorRegistration() {
  try {
    S.err = '';
    if (!S.a_name || !S.a_phone || !S.a_pass) {
      S.err = 'Name, phone, and password are required.';
      render();
      return;
    }

    const res = await fetch(`${API_BASE}/auth/register/supervisor`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        fullName: S.a_name,
        phone: S.a_phone,
        email: S.a_email || undefined,
        password: S.a_pass,
        departmentId: Number(S.a_dept_id || 4),
        title: 'Assoc. Prof. Dr.',
        specialty: S.a_spec || 'Oral & Maxillofacial Surgery'
      })
    });

    const data = await res.json();
    if (data.success) {
      S.id = 'a_pend';
      render();
    } else {
      S.err = data.error?.message || 'Supervisor registration failed.';
      render();
    }
  } catch (err) {
    S.err = 'Network error: ' + err.message;
    render();
  }
}

async function executeLogin(identifier, password) {
  try {
    S.err = '';
    const res = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier, password })
    });

    const data = await res.json();
    if (data.success) {
      S.user = data.data.user;
      S.token = data.data.accessToken;

      if (S.user.role === 'ADMIN') {
        S.id = 'm_dash';
        await loadPendingAccounts();
      } else if (S.user.role === 'SUPERVISOR') {
        S.id = 'a_dash';
      } else if (S.user.role === 'DOCTOR') {
        S.id = 's_prof';
      } else {
        S.id = 'p_prof';
      }
      render();
    } else {
      S.err = data.error?.message || 'Invalid credentials or account is not approved yet.';
      render();
    }
  } catch (err) {
    S.err = 'Login failed: ' + err.message;
    render();
  }
}

async function loadPendingAccounts() {
  if (!S.token) return;
  try {
    const roleParam = S.adminTab === 'ALL' ? 'ALL' : S.adminTab;
    const res = await fetch(`${API_BASE}/admin/accounts/pending?role=${roleParam}&status=PENDING_APPROVAL`, {
      headers: { 'Authorization': `Bearer ${S.token}` }
    });
    const data = await res.json();
    if (data.success) {
      S.pendingAccounts = data.data || [];
    }

    // Also fetch system stats
    const statsRes = await fetch(`${API_BASE}/demo/overview`);
    const statsData = await statsRes.json();
    if (statsData.success) {
      S.systemStats = statsData.data?.stats || {};
    }
    render();
  } catch (err) {
    console.error('Error loading pending accounts:', err);
  }
}

async function executeApproveAccount(userId) {
  if (!userId || !S.token) return;
  try {
    const res = await fetch(`${API_BASE}/admin/accounts/${userId}/approve`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${S.token}`
      },
      body: JSON.stringify({
        departmentIds: [1, 2, 4],
        primaryDepartmentId: 1
      })
    });

    const data = await res.json();
    if (data.success) {
      S.modal = null;
      await loadPendingAccounts();
    } else {
      S.err = data.error?.message || 'Could not approve account.';
      render();
    }
  } catch (err) {
    S.err = 'Approval failed: ' + err.message;
    render();
  }
}

async function executeRejectAccount(userId) {
  if (!userId || !S.token) return;
  const reason = (S.rejectReason || '').trim();
  if (reason.length < 3) {
    S.err = 'A rejection reason of at least 3 characters is required.';
    render();
    return;
  }
  try {
    const res = await fetch(`${API_BASE}/admin/accounts/${userId}/reject`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${S.token}`
      },
      body: JSON.stringify({ reason })
    });

    const data = await res.json();
    if (data.success) {
      S.modal = null;
      S.rejectReason = '';
      await loadPendingAccounts();
    } else {
      S.err = data.error?.message || 'Could not reject account.';
      render();
    }
  } catch (err) {
    S.err = 'Rejection failed: ' + err.message;
    render();
  }
}

// Initial render
render();
