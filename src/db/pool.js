import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { PGlite } from '@electric-sql/pglite';
import { citext } from '@electric-sql/pglite/contrib/citext';
import dotenv from 'dotenv';
import { AppError } from '../utils/errors.js';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT_DIR = path.resolve(__dirname, '../..');

const { Pool, types } = pg;

// Parse PostgreSQL INT8 (BIGINT, OID 20) into JavaScript Number when within safe integer bounds
types.setTypeParser(20, (val) => {
  if (val === null) return null;
  const num = Number(val);
  return Number.isSafeInteger(num) ? num : val;
});

// Parse PostgreSQL NUMERIC (OID 1700) into JavaScript Number
types.setTypeParser(1700, (val) => {
  if (val === null) return null;
  return Number(val);
});

/**
 * Recursively normalizes BigInt values returned by PGlite into safe JS Numbers
 * so behavior matches our `pg.types.setTypeParser(20, ...)` configuration.
 */
function normalizeRowValues(value) {
  if (typeof value === 'bigint') {
    const num = Number(value);
    return Number.isSafeInteger(num) ? num : value.toString();
  }
  if (value instanceof Date) {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(normalizeRowValues);
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeRowValues(v);
    }
    return out;
  }
  return value;
}

/**
 * Ensures the sample prescription PDF exists on disk for demo Patient Sara Ahmed Hassan.
 */
function ensureDemoUploadedFiles() {
  try {
    const uploadBase = path.resolve(ROOT_DIR, process.env.UPLOAD_STORAGE_DIR || './uploads');
    const demoPdfPath = path.join(uploadBase, 'medical', '2026', '11', 'demo-sara-prescription.pdf');
    fs.mkdirSync(path.dirname(demoPdfPath), { recursive: true });
    if (!fs.existsSync(demoPdfPath)) {
      const minimalPdf = `%PDF-1.4
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj
4 0 obj << /Length 198 >> stream
BT
/F1 16 Tf
50 720 Td
(TeethLink Dental Hospital - Medical Clearance & Prescription) Tj
/F1 12 Tf
0 -30 Td
(Patient: Sara Ahmed Hassan | Condition: Type 2 Diabetes + Hypertension) Tj
0 -22 Td
(Medications: Metformin 500mg, Concor 5mg | HbA1c: 6.8% - Cleared for Endo) Tj
ET
endstream endobj
5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj
xref
0 6
0000000000 65535 f 
0000000009 00000 n 
0000000058 00000 n 
0000000115 00000 n 
0000000241 00000 n 
0000000491 00000 n 
trailer << /Size 6 /Root 1 0 R >>
startxref
559
%%EOF`;
      fs.writeFileSync(demoPdfPath, minimalPdf, 'utf8');
    }
  } catch (err) {
    console.warn('[DB Init] Could not create demo prescription file:', err.message);
  }
}

/**
 * Creates an embedded PostgreSQL 16 (PGlite) pool-compatible adapter that automatically
 * runs `001_schema.sql`, `002_seed.sql`, and `003_demo_data.sql` on first boot.
 */
function createPGlitePool() {
  let dbInstance = null;
  let initPromise = null;

  // Mutex queue so concurrent transactions (`pool.connect()`) never interleave on the single PGlite connection
  let txChain = Promise.resolve();

  async function ensureInitialized() {
    if (dbInstance) return dbInstance;
    if (initPromise) return initPromise;

    initPromise = (async () => {
      const dataDir = process.env.PGLITE_DATA_DIR
        ? path.resolve(ROOT_DIR, process.env.PGLITE_DATA_DIR)
        : undefined;

      if (dataDir) {
        fs.mkdirSync(dataDir, { recursive: true });
        const pidFile = path.join(dataDir, 'postmaster.pid');
        if (fs.existsSync(pidFile)) {
          try { fs.unlinkSync(pidFile); } catch {}
        }
        try {
          const lockFiles = fs.readdirSync(dataDir).filter(f => f.includes('lock'));
          for (const lf of lockFiles) {
            try { fs.unlinkSync(path.join(dataDir, lf)); } catch {}
          }
        } catch {}
      }

      console.log(
        `[DB Pool] Starting embedded PostgreSQL 16 engine (PGlite) ${
          dataDir ? `at ${dataDir}` : 'in-memory'
        }...`
      );

      const db = await PGlite.create({
        dataDir,
        extensions: { citext },
      });

      const checkRes = await db.query(
        `SELECT to_regclass('public.users') AS users_table`
      );
      const hasSchema = Boolean(checkRes.rows?.[0]?.users_table);

      if (!hasSchema) {
        console.log('[DB Pool] Applying sql/001_schema.sql...');
        const schemaSql = fs.readFileSync(path.join(ROOT_DIR, 'sql', '001_schema.sql'), 'utf8');
        await db.exec(schemaSql);

        console.log('[DB Pool] Applying sql/002_seed.sql...');
        const seedSql = fs.readFileSync(path.join(ROOT_DIR, 'sql', '002_seed.sql'), 'utf8');
        await db.exec(seedSql);
      }

      const demoCheck = await db.query(`SELECT COUNT(*)::INT AS cnt FROM cases`);
      if (Number(demoCheck.rows?.[0]?.cnt || 0) === 0) {
        const demoPath = path.join(ROOT_DIR, 'sql', '003_demo_data.sql');
        if (fs.existsSync(demoPath)) {
          console.log('[DB Pool] Applying sql/003_demo_data.sql (Rich Demo Dataset)...');
          const demoSql = fs.readFileSync(demoPath, 'utf8');
          await db.exec(demoSql);
        }
      }

      ensureDemoUploadedFiles();
      dbInstance = db;
      return db;
    })();

    return initPromise;
  }

  async function executeRawQuery(text, params = []) {
    const db = await ensureInitialized();
    const res = await db.query(text, params);
    const rows = (res.rows || []).map(normalizeRowValues);
    const rowCount =
      typeof res.affectedRows === 'number' ? res.affectedRows : rows.length;
    return {
      rows,
      rowCount,
      fields: res.fields || [],
    };
  }

  return {
    isEmbeddedPGlite: true,
    async query(text, params = []) {
      return executeRawQuery(text, params);
    },
    async connect() {
      await ensureInitialized();
      let releaseLock;
      const prev = txChain;
      txChain = new Promise((resolve) => {
        releaseLock = resolve;
      });
      await prev;

      let released = false;
      return {
        async query(text, params = []) {
          return executeRawQuery(text, params);
        },
        release() {
          if (!released) {
            released = true;
            releaseLock();
          }
        },
      };
    },
    async end() {
      if (dbInstance) {
        await dbInstance.close();
        dbInstance = null;
        initPromise = null;
      }
    },
    on() {
      // No-op for EventEmitter compatibility
    },
  };
}

const usePGlite = String(process.env.USE_PGLITE ?? 'true').toLowerCase() !== 'false';

export const pool = usePGlite
  ? createPGlitePool()
  : new Pool({
      connectionString: process.env.DATABASE_URL,
      min: Number(process.env.DB_POOL_MIN || 2),
      max: Number(process.env.DB_POOL_MAX || 20),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
      connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS || 5000),
    });

pool.on('error', (err) => {
  console.error('[DB Pool] Unexpected error on idle PostgreSQL client:', err);
});

/**
 * Constraint-to-AppError lookup table for PostgreSQL SQLSTATE 23505 (unique_violation)
 * and 23514 (check_violation) defined in §3.4.4 of BACKEND_SYSTEM_PLAN.md.
 */
const UNIQUE_CONSTRAINT_MAP = {
  uq_exam_booking_slot_active: {
    statusCode: 409,
    code: 'SLOT_UNAVAILABLE',
    message: 'This examination slot has already been booked by another patient.',
  },
  uq_exam_booking_patient_active: {
    statusCode: 409,
    code: 'PATIENT_ALREADY_HAS_ACTIVE_EXAM',
    message: 'Patient already holds an active examination booking.',
  },
  uq_slot_one_hold_per_patient: {
    statusCode: 409,
    code: 'PATIENT_ALREADY_HOLDING_SLOT',
    message: 'Patient already holds a temporary slot lock.',
  },
  uq_case_active_assignment: {
    statusCode: 409,
    code: 'CASE_ALREADY_CLAIMED',
    message: 'This case has already been claimed by another doctor.',
  },
  uq_bt_bed_occupied: {
    statusCode: 409,
    code: 'BED_ALREADY_OCCUPIED',
    message: 'This dental chair/bed is currently occupied by another active session.',
  },
  uq_bt_bed_period_reserved: {
    statusCode: 409,
    code: 'BED_ALREADY_RESERVED_FOR_PERIOD',
    message: 'This bed is already reserved for the selected date and shift period.',
  },
  uq_bt_doctor_occupied: {
    statusCode: 409,
    code: 'DOCTOR_ALREADY_IN_ACTIVE_SESSION',
    message: 'Doctor is already occupying a bed in another active session.',
  },
  uq_bt_doctor_planned_start: {
    statusCode: 409,
    code: 'DOCTOR_SCHEDULE_CONFLICT',
    message: 'Doctor already has a reserved bed ticket at this exact planned start time.',
  },
  uq_bt_patient_occupied: {
    statusCode: 409,
    code: 'PATIENT_ALREADY_IN_ACTIVE_SESSION',
    message: 'Patient is already checked into an active bed session.',
  },
  uq_bt_patient_planned_start: {
    statusCode: 409,
    code: 'PATIENT_SCHEDULE_CONFLICT',
    message: 'Patient already has a reserved bed ticket at this exact planned start time.',
  },
  uq_bt_case_active: {
    statusCode: 409,
    code: 'CASE_ALREADY_HAS_OPEN_TICKET',
    message: 'This case already has an active or reserved bed ticket.',
  },
  uq_bt_appt_active: {
    statusCode: 409,
    code: 'APPOINTMENT_ALREADY_HAS_OPEN_TICKET',
    message: 'This appointment already has an active or reserved bed ticket.',
  },
  uq_appt_one_open_per_case: {
    statusCode: 409,
    code: 'CASE_ALREADY_HAS_OPEN_SESSION',
    message: 'This case already has an open treatment session.',
  },
  uq_users_phone: {
    statusCode: 409,
    code: 'PHONE_ALREADY_REGISTERED',
    message: 'A user account with this phone number is already registered.',
  },
  uq_users_email: {
    statusCode: 409,
    code: 'EMAIL_ALREADY_REGISTERED',
    message: 'A user account with this email address is already registered.',
  },
  student_doctor_profiles_university_id_number_key: {
    statusCode: 409,
    code: 'UNIVERSITY_ID_ALREADY_EXISTS',
    message: 'A doctor profile with this university ID number already exists.',
  },
  supervisor_profiles_employee_code_key: {
    statusCode: 409,
    code: 'EMPLOYEE_CODE_ALREADY_EXISTS',
    message: 'A supervisor profile with this employee code already exists.',
  },
  uq_doc_perm_active: {
    statusCode: 409,
    code: 'PERMISSION_ALREADY_EXISTS',
    message: 'Doctor already has a permission record for this service.',
  },
  uq_chat_conv_case_doctor: {
    statusCode: 409,
    code: 'CONVERSATION_ALREADY_EXISTS',
    message: 'A chat conversation for this case and doctor already exists.',
  },
};

/**
 * Maps native PostgreSQL `pg` / `PGlite` driver errors (SQLSTATE codes) into structured `AppError` instances
 * per §3.4.4 of BACKEND_SYSTEM_PLAN.md.
 *
 * @param {any} err - Error thrown during database query or transaction
 * @param {string} [lockContext] - Optional hint ('SLOT' | 'CASE' | 'BED' | 'APPOINTMENT')
 * @returns {AppError | Error}
 */
export function mapPgError(err, lockContext = undefined) {
  if (!err || err instanceof AppError) {
    return err;
  }

  const sqlState = err.code;

  // 1. 55P03: lock_not_available (FOR UPDATE NOWAIT or lock_timeout exceeded)
  if (sqlState === '55P03') {
    const tableHint = (err.table || lockContext || '').toLowerCase();
    if (tableHint.includes('initial_exam_slots') || tableHint === 'slot') {
      return new AppError(
        409,
        'SLOT_UNAVAILABLE',
        'This examination slot is currently being booked by another patient. Please select another slot.',
        { sqlState, table: err.table || 'initial_exam_slots' }
      );
    }
    if (tableHint.includes('cases') || tableHint === 'case') {
      return new AppError(
        409,
        'CASE_ALREADY_CLAIMED',
        'This case is currently being claimed by another doctor.',
        { sqlState, table: err.table || 'cases' }
      );
    }
    if (tableHint.includes('clinic_beds') || tableHint.includes('bed_tickets') || tableHint === 'bed') {
      return new AppError(
        409,
        'BED_ALREADY_OCCUPIED',
        'This bed is currently being reserved or occupied by another doctor.',
        { sqlState, table: err.table || 'clinic_beds' }
      );
    }
    return new AppError(
      409,
      'RESOURCE_CONTENTION',
      'The requested resource is currently locked by another concurrent operation. Please retry.',
      { sqlState, table: err.table || null }
    );
  }

  // 2. 23505: unique_violation
  if (sqlState === '23505') {
    const constraint = err.constraint || '';
    const mapped = UNIQUE_CONSTRAINT_MAP[constraint];
    if (mapped) {
      return new AppError(mapped.statusCode, mapped.code, mapped.message, {
        sqlState,
        constraint,
      });
    }
    return new AppError(
      409,
      'DUPLICATE_RESOURCE',
      'A record with the same unique identifier already exists.',
      { sqlState, constraint: constraint || null, detail: err.detail || null }
    );
  }

  // 3. 40P01: deadlock_detected
  if (sqlState === '40P01') {
    return new AppError(
      409,
      'CONCURRENT_MODIFICATION_RETRY',
      'A concurrent database deadlock occurred. Please retry the request.',
      { sqlState }
    );
  }

  // 4. P0001: PL/pgSQL RAISE EXCEPTION (triggers: trg_cases_valid_transition, trg_audit_immutable)
  if (sqlState === 'P0001') {
    const msg = String(err.message || '');
    if (msg.includes('AUDIT_LOG_IMMUTABLE')) {
      return new AppError(403, 'AUDIT_LOG_IMMUTABLE', msg, { sqlState });
    }
    if (msg.includes('ILLEGAL_CASE_TRANSITION')) {
      return new AppError(409, 'ILLEGAL_CASE_TRANSITION', msg, { sqlState });
    }
    return new AppError(409, 'DOMAIN_RULE_VIOLATION', msg, { sqlState });
  }

  // 5. 23503: foreign_key_violation
  if (sqlState === '23503') {
    return new AppError(
      422,
      'INVALID_REFERENCE',
      'One or more referenced identifiers do not exist.',
      { sqlState, constraint: err.constraint || null, detail: err.detail || null }
    );
  }

  // 6. 23514: check_violation
  if (sqlState === '23514') {
    return new AppError(
      422,
      'CONSTRAINT_VIOLATION',
      `Database check constraint violated (${err.constraint || 'unknown_constraint'}).`,
      { sqlState, constraint: err.constraint || null, detail: err.detail || null }
    );
  }

  // 7. 57014: query_canceled (statement_timeout exceeded)
  if (sqlState === '57014') {
    return new AppError(
      504,
      'DATABASE_STATEMENT_TIMEOUT',
      'The database operation timed out. Please retry.',
      { sqlState }
    );
  }

  return err;
}

/**
 * Executes a single parameterized SQL query against the shared connection pool,
 * mapping any PostgreSQL error via `mapPgError`.
 *
 * @param {string} text - SQL query string
 * @param {Array<any>} [params=[]] - Query parameters
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(text, params = []) {
  try {
    return await pool.query(text, params);
  } catch (err) {
    throw mapPgError(err);
  }
}

/**
 * Executes `fn(client, afterCommit)` inside a `READ COMMITTED` PostgreSQL transaction
 * with `SET LOCAL lock_timeout = '2s'` and `SET LOCAL statement_timeout = '5s'` (§3.4.0).
 *
 * - Callbacks registered via `afterCommit(cb)` are queued in memory while the transaction
 *   is open and only executed AFTER `COMMIT` succeeds.
 * - If the transaction rolls back, all queued `afterCommit` callbacks are discarded so
 *   Socket.io never emits phantom events for rolled-back changes.
 * - Automatically retries once on SQLSTATE `40P01` (`deadlock_detected`).
 *
 * @template T
 * @param {(client: import('pg').PoolClient, afterCommit: (cb: () => Promise<void> | void) => void) => Promise<T>} fn
 * @param {{ maxRetries?: number, lockContext?: string }} [options]
 * @returns {Promise<T>}
 */
export async function withTransaction(fn, options = {}) {
  const maxRetries = typeof options.maxRetries === 'number' ? options.maxRetries : 1;
  const lockContext = options.lockContext;

  let attempt = 0;

  while (true) {
    const client = await pool.connect();
    /** @type {Array<() => Promise<void> | void>} */
    const postCommitCallbacks = [];

    const afterCommit = (callback) => {
      if (typeof callback === 'function') {
        postCommitCallbacks.push(callback);
      }
    };

    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");

      const result = await fn(client, afterCommit);

      await client.query('COMMIT');

      // Execute all post-commit callbacks (Socket.io broadcasts, notifications) safely
      if (postCommitCallbacks.length > 0) {
        const outcomes = await Promise.allSettled(
          postCommitCallbacks.map((cb) => Promise.resolve().then(() => cb()))
        );
        for (const outcome of outcomes) {
          if (outcome.status === 'rejected') {
            console.error('[withTransaction.afterCommit] Post-commit callback failed:', outcome.reason);
          }
        }
      }

      return result;
    } catch (err) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackErr) {
        console.error('[withTransaction] Failed to ROLLBACK transaction:', rollbackErr);
      }

      // Discard postCommitCallbacks on rollback
      postCommitCallbacks.length = 0;

      // Retry once on deadlock_detected (40P01)
      if (err && err.code === '40P01' && attempt < maxRetries) {
        attempt += 1;
        continue;
      }

      throw mapPgError(err, lockContext);
    } finally {
      client.release();
    }
  }
}
