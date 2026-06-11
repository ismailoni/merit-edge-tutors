import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'merit-edge-'));
process.env.MERIT_DB_PATH = join(dir, 'test.sqlite');
process.env.MERIT_ADMIN_PASSWORD = 'admin';

const { server } = await import('../server.mjs');
await new Promise((resolve) => server.listen(0, resolve));
const base = `http://127.0.0.1:${server.address().port}`;

async function request(path, options = {}) {
  const response = await fetch(`${base}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  return { response, data };
}

try {
  const publicBefore = await request('/api/forms/ican-registration/config');
  assert.equal(publicBefore.response.status, 200);
  assert.equal(publicBefore.data.formStatus, 'open');
  assert.equal(publicBefore.data.appsScriptUrl, undefined);

  const badSettings = await request('/api/admin/forms/ican-registration/settings');
  assert.equal(badSettings.response.status, 401);

  const login = await request('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: 'admin' }) });
  assert.equal(login.response.status, 200);
  assert.ok(login.data.token);
  const auth = { Authorization: `Bearer ${login.data.token}` };

  const saved = await request('/api/admin/forms/ican-registration/settings', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({
      formStatus: 'closed',
      closedMessage: 'Closed for testing',
      adminEmail: 'admin@example.com',
      deploymentId: 'AKfycbExampleDeployment',
      appsScriptUrl: 'https://script.google.com/macros/s/AKfycbExampleDeployment/exec',
      courses: { Foundation: ['Accounting'], Skills: ['Audit'], Professional: ['Case Study'] },
    }),
  });
  assert.equal(saved.response.status, 200);
  assert.equal(saved.data.appsScriptUrl, 'https://script.google.com/macros/s/AKfycbExampleDeployment/exec');

  const publicAfter = await request('/api/forms/ican-registration/config');
  assert.equal(publicAfter.response.status, 200);
  assert.equal(publicAfter.data.formStatus, 'closed');
  assert.equal(publicAfter.data.appsScriptUrl, undefined);
  assert.deepEqual(publicAfter.data.courses.Foundation, ['Accounting']);

  const blockedSubmit = await request('/api/forms/ican-registration/submissions', {
    method: 'POST',
    body: JSON.stringify({ Name: 'Jane Doe' }),
  });
  assert.equal(blockedSubmit.response.status, 409);

  await request('/api/admin/forms/ican-registration/settings', {
    method: 'PUT',
    headers: auth,
    body: JSON.stringify({
      formStatus: 'open',
      closedMessage: 'Closed',
      adminEmail: 'admin@example.com',
      courses: { Foundation: ['Accounting'], Skills: ['Audit'], Professional: ['Case Study'] },
    }),
  });

  const submit = await request('/api/forms/ican-registration/submissions', {
    method: 'POST',
    body: JSON.stringify({
      Name: 'Jane Doe',
      ExamNumber: 'ICAN123',
      ExamYear: '2026',
      Level: 'Foundation',
      Courses: ['Accounting'],
      Email: 'jane@example.com',
      Phone: '08012345678',
    }),
  });
  assert.equal(submit.response.status, 201);

  const submissions = await request('/api/admin/forms/ican-registration/submissions', { headers: auth });
  assert.equal(submissions.response.status, 200);
  assert.equal(submissions.data.rows.length, 2);
  assert.equal(submissions.data.rows[1][1], 'Jane Doe');
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dir, { recursive: true, force: true });
}
