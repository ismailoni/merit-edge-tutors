import { randomBytes, scryptSync, timingSafeEqual, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 3000);
const DB_PATH = process.env.MERIT_DB_PATH || join(__dirname, 'data', 'merit-edge.sqlite');
const DEFAULT_FORM_ID = process.env.MERIT_DEFAULT_FORM_ID || 'ican-registration';
const DEFAULT_ADMIN_PASSWORD = process.env.MERIT_ADMIN_PASSWORD || 'admin';
const ALLOWED_ORIGIN = process.env.MERIT_ALLOWED_ORIGIN || '*';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const DEFAULT_COURSES = {
  Foundation: ['Business Environment', 'Financial Accounting', 'Management Accounting', 'Corporate and Business Law'],
  Skills: ['Financial Reporting', 'Audit, Assurance and Forensics', 'Taxation', 'Financial Management', 'Performance Management', 'Public Sector Accounting and Finance'],
  Professional: ['Strategic Business Reporting', 'Advanced Audit and Assurance and Forensics', 'Strategic Financial Management', 'Advanced Taxation', 'Case Study'],
};

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  CREATE TABLE IF NOT EXISTS admin_credentials (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    password_hash TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS admin_sessions (
    token_hash TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS form_configs (
    form_id TEXT PRIMARY KEY,
    form_name TEXT NOT NULL DEFAULT 'ICAN Student Registration',
    form_status TEXT NOT NULL CHECK (form_status IN ('open', 'closed')) DEFAULT 'open',
    closed_message TEXT NOT NULL,
    courses_json TEXT NOT NULL,
    admin_email TEXT NOT NULL DEFAULT '',
    google_sheet_id TEXT NOT NULL DEFAULT '',
    apps_script_url TEXT NOT NULL DEFAULT '',
    deployment_id TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS submissions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    form_id TEXT NOT NULL,
    submitted_at TEXT NOT NULL,
    full_name TEXT NOT NULL,
    exam_number TEXT NOT NULL,
    exam_year TEXT NOT NULL,
    level TEXT NOT NULL,
    courses_json TEXT NOT NULL,
    email TEXT NOT NULL,
    phone TEXT NOT NULL,
    integration_status TEXT NOT NULL DEFAULT 'pending',
    integration_error TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL,
    FOREIGN KEY (form_id) REFERENCES form_configs(form_id)
  );
`);

function nowIso() { return new Date().toISOString(); }
function hashToken(token) { return createHash('sha256').update(token).digest('hex'); }
function hashPassword(password, salt = randomBytes(16).toString('hex')) {
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(password, stored) {
  const [salt, expectedHex] = String(stored || '').split(':');
  if (!salt || !expectedHex) return false;
  const actual = Buffer.from(scryptSync(password, salt, 64).toString('hex'), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

if (!db.prepare('SELECT id FROM admin_credentials WHERE id = 1').get()) {
  db.prepare('INSERT INTO admin_credentials (id, password_hash, updated_at) VALUES (1, ?, ?)').run(hashPassword(DEFAULT_ADMIN_PASSWORD), nowIso());
}
if (!db.prepare('SELECT form_id FROM form_configs WHERE form_id = ?').get(DEFAULT_FORM_ID)) {
  db.prepare(`INSERT INTO form_configs
    (form_id, closed_message, courses_json, admin_email, updated_at)
    VALUES (?, ?, ?, ?, ?)`)
    .run(DEFAULT_FORM_ID, 'Registration is currently closed. Please check back soon or contact Merit Edge Tutors for the next available intake.', JSON.stringify(DEFAULT_COURSES), 'meritedgetutors@gmail.com', nowIso());
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.xml': 'application/xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, OPTIONS',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Max-Age': '86400',
    ...(ALLOWED_ORIGIN === '*' ? {} : { Vary: 'Origin' }),
  };
}

function send(res, status, body, headers = {}) {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}
async function readJson(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  if (!body) return {};
  try { return JSON.parse(body); } catch { throw Object.assign(new Error('Invalid JSON body.'), { status: 400 }); }
}
function requireString(value, name, max = 500) {
  const text = String(value || '').trim();
  if (!text) throw Object.assign(new Error(`${name} is required.`), { status: 400 });
  if (text.length > max) throw Object.assign(new Error(`${name} is too long.`), { status: 400 });
  return text;
}
function optionalUrl(value, name) {
  const text = String(value || '').trim();
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); } catch { throw Object.assign(new Error(`${name} must be a valid URL.`), { status: 400 }); }
  if (parsed.protocol !== 'https:') throw Object.assign(new Error(`${name} must use HTTPS.`), { status: 400 });
  return parsed.toString();
}
function validateCourses(courses) {
  if (!courses || typeof courses !== 'object' || Array.isArray(courses)) throw Object.assign(new Error('courses must be an object.'), { status: 400 });
  const clean = {};
  for (const level of ['Foundation', 'Skills', 'Professional']) {
    const list = Array.isArray(courses[level]) ? courses[level] : [];
    clean[level] = [...new Set(list.map((s) => String(s || '').trim()).filter(Boolean))].slice(0, 50);
  }
  return clean;
}
function getConfig(formId = DEFAULT_FORM_ID) {
  return db.prepare('SELECT * FROM form_configs WHERE form_id = ?').get(formId);
}
function publicConfig(row) {
  return {
    formId: row.form_id,
    formName: row.form_name,
    formStatus: row.form_status,
    closedMessage: row.closed_message,
    courses: JSON.parse(row.courses_json),
    contactEmail: row.admin_email,
    appsScriptUrl: row.apps_script_url,
    updatedAt: row.updated_at,
  };
}
function adminConfig(row) {
  return { ...publicConfig(row), adminEmail: row.admin_email, googleSheetId: row.google_sheet_id, appsScriptUrl: row.apps_script_url, deploymentId: row.deployment_id };
}
function authToken(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : '';
}
function requireAdmin(req) {
  const token = authToken(req);
  if (!token) throw Object.assign(new Error('Authentication required.'), { status: 401 });
  db.prepare('DELETE FROM admin_sessions WHERE expires_at < ?').run(Date.now());
  const session = db.prepare('SELECT token_hash FROM admin_sessions WHERE token_hash = ? AND expires_at >= ?').get(hashToken(token), Date.now());
  if (!session) throw Object.assign(new Error('Invalid or expired session.'), { status: 401 });
}
async function syncAppsScript(row, submission) {
  if (!row.apps_script_url) return { status: 'stored', error: '' };
  try {
    const response = await fetch(row.apps_script_url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(submission) });
    if (!response.ok) throw new Error(`Apps Script responded with HTTP ${response.status}`);
    return { status: 'synced', error: '' };
  } catch (error) {
    return { status: 'sync_failed', error: error.message.slice(0, 500) };
  }
}
const SUBMISSION_HEADER = ['Timestamp', 'Name', 'Exam Number', 'Level', 'Courses', 'Email', 'Phone'];
function rowToArray(row) {
  return [row.submitted_at, row.full_name, row.exam_number, row.level, JSON.parse(row.courses_json).join(', '), row.email, row.phone];
}

function normalizeAppsScriptRows(data) {
  const list = Array.isArray(data) ? data
    : Array.isArray(data?.rows) ? data.rows
    : Array.isArray(data?.data) ? data.data
    : Array.isArray(data?.submissions) ? data.submissions
    : null;
  if (!list) throw new Error('Unexpected Apps Script response shape.');
  const body = list.map((item) => {
    if (Array.isArray(item)) return item.map((cell) => (cell == null ? '' : cell));
    const courses = Array.isArray(item.Courses) ? item.Courses.join(', ') : (item.Courses ?? item.courses ?? '');
    return [
      item.Timestamp ?? item.timestamp ?? '',
      item.Name ?? item.name ?? '',
      item.ExamNumber ?? item['Exam Number'] ?? '',
      item.Level ?? item.level ?? '',
      courses,
      item.Email ?? item.email ?? '',
      item.Phone ?? item.phone ?? '',
    ];
  }).filter((r) => Array.isArray(r) && r.length);
  // Drop a leading header row if the sheet returned one.
  if (body.length && String(body[0][0]).trim().toLowerCase() === 'timestamp') body.shift();
  return [SUBMISSION_HEADER, ...body];
}
async function fetchAppsScriptSubmissions(row) {
  const response = await fetch(row.apps_script_url, { method: 'GET', headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Apps Script responded with HTTP ${response.status}`);
  const text = await response.text();
  return normalizeAppsScriptRows(text ? JSON.parse(text) : null);
}

async function handleApi(req, res, url) {
  if (req.method === 'POST' && url.pathname === '/api/admin/login') {
    const { password } = await readJson(req);
    const cred = db.prepare('SELECT password_hash FROM admin_credentials WHERE id = 1').get();
    if (!verifyPassword(String(password || ''), cred.password_hash)) return send(res, 401, { error: 'Invalid password.' });
    const token = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO admin_sessions (token_hash, expires_at, created_at) VALUES (?, ?, ?)').run(hashToken(token), Date.now() + SESSION_TTL_MS, nowIso());
    return send(res, 200, { token, expiresInSeconds: SESSION_TTL_MS / 1000 });
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    const token = authToken(req); if (token) db.prepare('DELETE FROM admin_sessions WHERE token_hash = ?').run(hashToken(token));
    return send(res, 204, '');
  }
  if (req.method === 'POST' && url.pathname === '/api/admin/change-password') {
    requireAdmin(req);
    const { currentPassword, newPassword } = await readJson(req);
    if (!String(newPassword || '').trim() || String(newPassword).length < 8) return send(res, 400, { error: 'New password must be at least 8 characters.' });
    const cred = db.prepare('SELECT password_hash FROM admin_credentials WHERE id = 1').get();
    if (!verifyPassword(String(currentPassword || ''), cred.password_hash)) return send(res, 400, { error: 'Current password is incorrect.' });
    db.prepare('UPDATE admin_credentials SET password_hash = ?, updated_at = ? WHERE id = 1').run(hashPassword(String(newPassword)), nowIso());
    db.prepare('DELETE FROM admin_sessions').run();
    return send(res, 200, { ok: true });
  }
  const publicCfg = url.pathname.match(/^\/api\/forms\/([^/]+)\/config$/);
  if (req.method === 'GET' && publicCfg) {
    const row = getConfig(publicCfg[1]);
    if (!row) return send(res, 404, { error: 'Form not found.' });
    return send(res, 200, publicConfig(row));
  }
  const submitMatch = url.pathname.match(/^\/api\/forms\/([^/]+)\/submissions$/);
  if (req.method === 'POST' && submitMatch) {
    const row = getConfig(submitMatch[1]);
    if (!row) return send(res, 404, { error: 'Form not found.' });
    if (row.form_status !== 'open') return send(res, 409, { error: row.closed_message });
    const body = await readJson(req);
    const selectedCourses = Array.isArray(body.Courses) ? body.Courses : String(body.Courses || '').split(',').map((s) => s.trim()).filter(Boolean);
    const submission = {
      Timestamp: nowIso(),
      Name: requireString(body.Name, 'Full name', 120),
      ExamNumber: requireString(body.ExamNumber, 'Exam number', 80),
      ExamYear: requireString(body.ExamYear, 'Exam year', 4),
      Level: requireString(body.Level, 'Level', 40),
      Courses: selectedCourses,
      Email: requireString(body.Email, 'Email', 160),
      Phone: requireString(body.Phone, 'Phone', 40),
    };
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(submission.Email)) return send(res, 400, { error: 'Email must be valid.' });
    if (!JSON.parse(row.courses_json)[submission.Level]) return send(res, 400, { error: 'Level is not valid.' });
    const sync = await syncAppsScript(row, submission);
    db.prepare(`INSERT INTO submissions
      (form_id, submitted_at, full_name, exam_number, exam_year, level, courses_json, email, phone, integration_status, integration_error, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(row.form_id, submission.Timestamp, submission.Name, submission.ExamNumber, submission.ExamYear, submission.Level, JSON.stringify(submission.Courses), submission.Email, submission.Phone, sync.status, sync.error, JSON.stringify(submission));
    return send(res, 201, { ok: true, integrationStatus: sync.status });
  }
  const adminSettings = url.pathname.match(/^\/api\/admin\/forms\/([^/]+)\/settings$/);
  if (adminSettings) {
    requireAdmin(req);
    const formId = adminSettings[1];
    if (req.method === 'GET') {
      const row = getConfig(formId);
      if (!row) return send(res, 404, { error: 'Form not found.' });
      return send(res, 200, adminConfig(row));
    }
    if (req.method === 'PUT') {
      const body = await readJson(req);
      const formStatus = ['open', 'closed'].includes(body.formStatus) ? body.formStatus : 'open';
      const closedMessage = requireString(body.closedMessage || 'Registration is currently closed. Please check back soon.', 'Closed message', 1000);
      const courses = validateCourses(body.courses || DEFAULT_COURSES);
      const appsScriptUrl = optionalUrl(body.appsScriptUrl || body.sheetUrl, 'Apps Script URL');
      const googleSheetId = String(body.googleSheetId || '').trim();
      const deploymentId = String(body.deploymentId || '').trim();
      const adminEmail = String(body.adminEmail || '').trim();
      if (adminEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(adminEmail)) return send(res, 400, { error: 'Admin email must be valid.' });
      db.prepare(`INSERT INTO form_configs
        (form_id, form_name, form_status, closed_message, courses_json, admin_email, google_sheet_id, apps_script_url, deployment_id, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(form_id) DO UPDATE SET
          form_status = excluded.form_status, closed_message = excluded.closed_message, courses_json = excluded.courses_json,
          admin_email = excluded.admin_email, google_sheet_id = excluded.google_sheet_id, apps_script_url = excluded.apps_script_url,
          deployment_id = excluded.deployment_id, updated_at = excluded.updated_at`)
        .run(formId, body.formName || 'ICAN Student Registration', formStatus, closedMessage, JSON.stringify(courses), adminEmail, googleSheetId, appsScriptUrl, deploymentId, nowIso());
      return send(res, 200, adminConfig(getConfig(formId)));
    }
  }
  const adminSubs = url.pathname.match(/^\/api\/admin\/forms\/([^/]+)\/submissions$/);
  if (req.method === 'GET' && adminSubs) {
    requireAdmin(req);
    const cfg = getConfig(adminSubs[1]);
    if (cfg?.apps_script_url) {
      try {
        return send(res, 200, { rows: await fetchAppsScriptSubmissions(cfg), source: 'apps_script' });
      } catch (error) {
        console.warn('Apps Script submissions fetch failed, falling back to local store:', error.message);
      }
    }
    const rows = db.prepare('SELECT * FROM submissions WHERE form_id = ? ORDER BY id DESC').all(adminSubs[1]);
    
    return send(res, 200, { rows: [SUBMISSION_HEADER, ...rows.map(rowToArray)], source: 'local' });
  }
  return send(res, 404, { error: 'API route not found.' });
}

function serveStatic(req, res, url) {
  const requested = url.pathname === '/' ? '/index.html' : url.pathname.endsWith('/') ? `${url.pathname}index.html` : url.pathname;
  const decodedPath = decodeURIComponent(requested);
  if (decodedPath.split(/[\\/]/).includes('..')) return send(res, 404, 'Not found');
  let normalizedPath = normalize(decodedPath);
  while (normalizedPath.startsWith('/') || normalizedPath.startsWith('\\')) normalizedPath = normalizedPath.slice(1);
  if (normalizedPath.split(/[\\/]/).includes('..')) return send(res, 404, 'Not found');
  let filePath = join(__dirname, normalizedPath);
  if (!filePath.startsWith(__dirname) || !existsSync(filePath)) return send(res, 404, 'Not found');
  if (statSync(filePath).isDirectory()) filePath = join(filePath, 'index.html');
  if (!filePath.startsWith(__dirname) || !existsSync(filePath)) return send(res, 404, 'Not found');
  const type = mime[extname(filePath)] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type });
  res.end(readFileSync(filePath));
}


export const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const [key, value] of Object.entries(corsHeaders())) res.setHeader(key, value);
      if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
      return await handleApi(req, res, url);
    }
    return serveStatic(req, res, url);
  } catch (error) {
    const status = error.status || 500;
    if (status >= 500) console.error(error);
    return send(res, status, { error: error.message || 'Internal server error.' });
  }
});

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  server.listen(PORT, () => console.log(`Merit Edge Tutors server listening on http://localhost:${PORT}`));
}
