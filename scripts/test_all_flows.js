// scripts/test_all_flows.js
// Exhaustive automated test suite for TeethLink Dental Hospital Backend & Frontend GUI

const BASE_URL = 'http://localhost:4000';
const API_URL = `${BASE_URL}/api/v1`;

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

function assert(condition, testName, details = '') {
  totalTests++;
  if (condition) {
    passedTests++;
    console.log(`  ✅ [PASS] ${testName}`);
  } else {
    failedTests++;
    console.error(`  ❌ [FAIL] ${testName} ${details ? '--> ' + details : ''}`);
  }
}

async function request(endpoint, options = {}) {
  const url = endpoint.startsWith('http') ? endpoint : `${API_URL}${endpoint}`;
  const res = await fetch(url, options);
  let json = null;
  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    json = await res.json();
  } else {
    json = await res.text();
  }
  return { status: res.status, headers: res.headers, data: json };
}

async function runAllTests() {
  console.log('\n============================================================');
  console.log('  TEETHLINK COMPLETE END-TO-END FLOW VERIFICATION');
  console.log('============================================================\n');

  const timestamp = Date.now().toString().slice(-6);

  // ---------------------------------------------------------------------------
  // SUITE 1: System Health & Static Assets (GUI, Schemas, Diagrams)
  // ---------------------------------------------------------------------------
  console.log('📋 SUITE 1: Static Assets & System Health');
  
  const healthRes = await request('/health');
  assert(healthRes.status === 200 && healthRes.data?.data?.database?.connected === true, 'Health check returns 200 & CONNECTED');

  const rootRes = await request(`${BASE_URL}/`);
  assert(rootRes.status === 200 && typeof rootRes.data === 'string' && rootRes.data.includes('TeethLink'), 'GET / serves TeethLink HTML GUI');

  const appJsRes = await request(`${BASE_URL}/app.js`);
  assert(appJsRes.status === 200 && typeof appJsRes.data === 'string' && appJsRes.data.includes('CONDITION_CATALOG_MAP'), 'GET /app.js serves frontend application script');

  const authSvgRes = await request(`${BASE_URL}/diagrams/01_auth_medical_schema.svg`);
  assert(authSvgRes.status === 200 && typeof authSvgRes.data === 'string' && authSvgRes.data.includes('<svg'), 'GET /diagrams/01_auth_medical_schema.svg serves Auth ERD');

  const fullSvgRes = await request(`${BASE_URL}/diagrams/02_full_system_schema.svg`);
  assert(fullSvgRes.status === 200 && typeof fullSvgRes.data === 'string' && fullSvgRes.data.includes('<svg'), 'GET /diagrams/02_full_system_schema.svg serves 24-Entity Full System ERD');

  const authSqlRes = await request(`${BASE_URL}/sql/auth_schema.sql`);
  assert(authSqlRes.status === 200 && typeof authSqlRes.data === 'string' && authSqlRes.data.includes('CREATE TABLE'), 'GET /sql/auth_schema.sql serves Auth Schema DDL');

  const fullSqlRes = await request(`${BASE_URL}/sql/full_system_schema.sql`);
  assert(fullSqlRes.status === 200 && typeof fullSqlRes.data === 'string' && fullSqlRes.data.includes('CREATE TABLE'), 'GET /sql/full_system_schema.sql serves Full System Schema DDL');

  // ---------------------------------------------------------------------------
  // SUITE 2: Medical Catalog & Questionnaire Endpoints
  // ---------------------------------------------------------------------------
  console.log('\n📋 SUITE 2: Medical Catalog & Questionnaire Endpoints');

  const catRes = await request('/medical-catalog/questionnaire');
  assert(catRes.status === 200 && Array.isArray(catRes.data?.data?.criticalQuestions), 'Medical questionnaire returns critical questions array');
  assert(catRes.data?.data?.criticalQuestions?.length >= 5, 'At least 5 critical questions present in catalog');

  // ---------------------------------------------------------------------------
  // SUITE 3: Supervisor ID Verification (Student registration helper)
  // ---------------------------------------------------------------------------
  console.log('\n📋 SUITE 3: Supervisor ID Verification');

  const sup4Res = await request('/auth/supervisors/verify/4');
  assert(sup4Res.status === 200 && sup4Res.data?.data?.valid === true, 'Verify Supervisor ID "4" returns valid=true');

  const supCodeRes = await request('/auth/supervisors/verify/SUP-0001');
  assert(supCodeRes.status === 200 && supCodeRes.data?.data?.valid === true, 'Verify Supervisor Code "SUP-0001" returns valid=true');

  const supInvalidRes = await request('/auth/supervisors/verify/99999');
  assert(supInvalidRes.status === 404 && supInvalidRes.data?.error?.code === 'SUPERVISOR_NOT_FOUND', 'Verify Invalid Supervisor ID returns 404 SUPERVISOR_NOT_FOUND gracefully');

  // ---------------------------------------------------------------------------
  // SUITE 4: Patient Registration Flow (Testing Critical Questions Fix)
  // ---------------------------------------------------------------------------
  console.log('\n📋 SUITE 4: Patient Registration Flow');

  // Case 4A: Normal patient registration with all conditions provided
  const patientPhoneA = `+201099${timestamp}1`;
  const regPatientA = await request('/auth/register/patient', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: `Test Patient A ${timestamp}`,
      phone: patientPhoneA,
      email: `patient.a.${timestamp}@test.com`,
      password: 'Patient@12345',
      photoConsent: true,
      dataSharingConsent: true,
      medicalQuestionnaire: {
        conditions: [
          { conditionId: 1, hasCondition: true, details: 'Type 2 Diabetes' },
          { conditionId: 2, hasCondition: false },
          { conditionId: 3, hasCondition: false },
          { conditionId: 4, hasCondition: false },
          { conditionId: 5, hasCondition: false },
          { conditionId: 6, hasCondition: false },
          { conditionId: 7, hasCondition: false },
          { conditionId: 8, hasCondition: false },
          { conditionId: 9, hasCondition: false },
          { conditionId: 10, hasCondition: false }
        ],
        allergies: [{ allergyId: 1, notes: 'Penicillin allergy' }],
        medications: [{ medicationName: 'Metformin', dosage: '500mg', isAnticoagulant: false }],
        documentDelivery: 'WILL_BRING_PHYSICALLY'
      }
    })
  });
  assert(regPatientA.status === 201 && regPatientA.data?.success === true, 'Patient Registration with full questionnaire succeeds (201)');
  assert(regPatientA.data?.data?.patientProfile?.hasCriticalCondition === true, 'Patient with Diabetes correctly flagged hasCriticalCondition=true');

  // Case 4B: Registration with PARTIAL or EMPTY conditions array (Verifying the fix: no CRITICAL_QUESTIONS_INCOMPLETE error)
  const patientPhoneB = `+201099${timestamp}2`;
  const regPatientB = await request('/auth/register/patient', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: `Test Patient B ${timestamp}`,
      phone: patientPhoneB,
      email: `patient.b.${timestamp}@test.com`,
      password: 'Patient@12345',
      photoConsent: false,
      dataSharingConsent: true,
      medicalQuestionnaire: {
        // Notice: Only condition 6 is sent, critical conditions are omitted
        conditions: [
          { conditionId: 6, hasCondition: false }
        ],
        documentDelivery: 'NOT_REQUIRED'
      }
    })
  });
  assert(regPatientB.status === 201 && regPatientB.data?.success === true, 'Patient Registration with omitted conditions defaults gracefully and succeeds without error (201)');

  // Case 4C: Patient Login
  const loginPatient = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: patientPhoneA, password: 'Patient@12345' })
  });
  assert(loginPatient.status === 200 && Boolean(loginPatient.data?.data?.accessToken), 'Newly registered patient logs in successfully with JWT token');

  // ---------------------------------------------------------------------------
  // SUITE 5: Student Doctor Registration Flow
  // ---------------------------------------------------------------------------
  console.log('\n📋 SUITE 5: Student Doctor Registration Flow');

  // Case 5A: Student registers linking to Supervisor ID 4
  const studentPhone = `+201099${timestamp}3`;
  const regStudent = await request('/auth/register/doctor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: `Dr. Student ${timestamp}`,
      phone: studentPhone,
      email: `student.${timestamp}@o6u.edu.eg`,
      password: 'Doctor@12345',
      universityIdNumber: `STU-${timestamp}`,
      university: 'O6U University',
      college: 'Faculty of Dentistry',
      academicYear: 5,
      doctorCategory: 'UNDERGRAD_STUDENT',
      supervisorCode: '4', // linking to supervisor 4
      requestedDepartmentIds: [1, 2, 4]
    })
  });
  assert(regStudent.status === 201 && regStudent.data?.success === true, 'Student Doctor registers successfully linking to Supervisor 4 (201)');
  assert(regStudent.data?.data?.accountStatus === 'PENDING_APPROVAL', 'Student Doctor account status is PENDING_APPROVAL');
  const studentUserId = regStudent.data?.data?.userId;

  // Case 5B: Student registers with non-existent supervisor code
  const regStudentInvalidSup = await request('/auth/register/doctor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: `Dr. Student Invalid ${timestamp}`,
      phone: `+201099${timestamp}9`,
      email: `student.invalid.${timestamp}@o6u.edu.eg`,
      password: 'Doctor@12345',
      universityIdNumber: `STU-INV-${timestamp}`,
      academicYear: 5,
      supervisorCode: '99999'
    })
  });
  assert(regStudentInvalidSup.status === 422 && regStudentInvalidSup.data?.error?.code === 'INVALID_SUPERVISOR_CODE', 'Student registration with invalid supervisor code returns 422 INVALID_SUPERVISOR_CODE');

  // ---------------------------------------------------------------------------
  // SUITE 6: Supervisor Registration Flow (Testing Department ID Fix)
  // ---------------------------------------------------------------------------
  console.log('\n📋 SUITE 6: Supervisor Registration Flow');

  // Case 6A: Register Supervisor with departmentId = 4
  const supervisorPhoneA = `+201099${timestamp}4`;
  const regSupA = await request('/auth/register/supervisor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: `Prof. Dr. Supervisor A ${timestamp}`,
      phone: supervisorPhoneA,
      email: `sup.a.${timestamp}@o6u.edu.eg`,
      password: 'Supervisor@12345',
      departmentId: 4,
      title: 'Assoc. Prof. Dr.',
      specialty: 'Oral Surgery',
      isTriageExaminer: true
    })
  });
  assert(regSupA.status === 201 && regSupA.data?.success === true, 'Supervisor registration with departmentId=4 succeeds without error (201)');
  const supUserIdA = regSupA.data?.data?.userId;

  // Case 6B: Register Supervisor with department name string "Restorative" (Verifying fuzzy resolver)
  const supervisorPhoneB = `+201099${timestamp}5`;
  const regSupB = await request('/auth/register/supervisor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      fullName: `Prof. Dr. Supervisor B ${timestamp}`,
      phone: supervisorPhoneB,
      email: `sup.b.${timestamp}@o6u.edu.eg`,
      password: 'Supervisor@12345',
      departmentId: 'Restorative',
      title: 'Professor',
      specialty: 'Operative Dentistry'
    })
  });
  assert(regSupB.status === 201 && regSupB.data?.success === true, 'Supervisor registration with text department "Restorative" resolves and succeeds (201)');
  const supUserIdB = regSupB.data?.data?.userId;

  // ---------------------------------------------------------------------------
  // SUITE 7: Admin Review, Approval & Rejection Flows
  // ---------------------------------------------------------------------------
  console.log('\n📋 SUITE 7: Admin Review, Approval & Rejection Flows');

  // Admin login
  const adminLogin = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: '+201000000001', password: 'Admin@12345' })
  });
  assert(adminLogin.status === 200 && Boolean(adminLogin.data?.data?.accessToken), 'Admin logs in successfully');
  const adminToken = adminLogin.data?.data?.accessToken;

  // Admin fetches pending accounts
  const pendingRes = await request('/admin/accounts/pending?role=ALL&status=PENDING_APPROVAL', {
    headers: { 'Authorization': `Bearer ${adminToken}` }
  });
  assert(pendingRes.status === 200 && Array.isArray(pendingRes.data?.data), 'Admin fetches list of pending accounts');
  const pendingIds = pendingRes.data?.data?.map(u => u.userId) || [];
  assert(pendingIds.includes(studentUserId), 'Pending accounts includes newly registered student doctor');
  assert(pendingIds.includes(supUserIdA), 'Pending accounts includes newly registered supervisor A');

  // Admin approves student doctor
  const approveStudent = await request(`/admin/accounts/${studentUserId}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      departmentIds: [1, 2, 4],
      primaryDepartmentId: 1
    })
  });
  assert(approveStudent.status === 200 && approveStudent.data?.success === true, 'Admin approves student doctor account');

  // Admin approves supervisor A
  const approveSup = await request(`/admin/accounts/${supUserIdA}/approve`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      supervisorCode: `SUP-${supUserIdA}`
    })
  });
  assert(approveSup.status === 200 && approveSup.data?.success === true, 'Admin approves supervisor account and issues code');

  // Admin rejects supervisor B with reason
  const rejectSup = await request(`/admin/accounts/${supUserIdB}/reject`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${adminToken}`
    },
    body: JSON.stringify({
      reason: 'Missing faculty verification documents. Please re-register with official credentials.'
    })
  });
  assert(rejectSup.status === 200 && rejectSup.data?.success === true, 'Admin rejects account with detailed reason');

  // ---------------------------------------------------------------------------
  // SUITE 8: Post-Approval & Post-Rejection Logins
  // ---------------------------------------------------------------------------
  console.log('\n📋 SUITE 8: Post-Approval & Post-Rejection Logins');

  // Student logs in after approval
  const approvedStudentLogin = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: studentPhone, password: 'Doctor@12345' })
  });
  assert(approvedStudentLogin.status === 200 && approvedStudentLogin.data?.data?.user?.accountStatus === 'ACTIVE', 'Approved student doctor logs in successfully with status ACTIVE');

  // Supervisor logs in after approval
  const approvedSupLogin = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: supervisorPhoneA, password: 'Supervisor@12345' })
  });
  assert(approvedSupLogin.status === 200 && approvedSupLogin.data?.data?.user?.accountStatus === 'ACTIVE', 'Approved supervisor logs in successfully with status ACTIVE');

  // Rejected user attempts to log in -> Expect 403 / unapproved error with rejection reason
  const rejectedLogin = await request('/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ identifier: supervisorPhoneB, password: 'Supervisor@12345' })
  });
  assert(rejectedLogin.status === 403, 'Rejected user login is blocked with status 403');
  assert(rejectedLogin.data?.error?.message?.includes('Missing faculty verification documents') || rejectedLogin.data?.error?.code === 'ACCOUNT_REJECTED', 'Rejection reason is delivered to user');

  // ---------------------------------------------------------------------------
  // SUMMARY
  // ---------------------------------------------------------------------------
  console.log('\n============================================================');
  console.log(`  TEST RESULTS: ${passedTests} PASSED / ${failedTests} FAILED (TOTAL: ${totalTests})`);
  console.log('============================================================\n');

  if (failedTests > 0) {
    process.exit(1);
  }
}

runAllTests().catch((err) => {
  console.error('Fatal test error:', err);
  process.exit(1);
});
