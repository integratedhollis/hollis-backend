/**
 * Hollis Backend Phase 2 - Standalone E2E Test Suite
 * 
 * Target: Cloudflare Workers Local Dev Server (default: http://127.0.0.1:8787)
 * Runtime: Pure Node.js (v18/20/22/24+ native fetch, zero external dependencies)
 * Coverage: Complete verification of Task Lifecycle, Session Management, History & Replay APIs
 * 
 * Usage:
 *   node test_phase2.js
 *   node test_phase2.js --url http://127.0.0.1:8787
 */

'use strict';

let baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8787';

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--url=')) {
    baseUrl = arg.substring(6);
  } else if (arg === '--url' && i + 1 < process.argv.length) {
    baseUrl = process.argv[++i];
  } else if (arg.startsWith('http://') || arg.startsWith('https://')) {
    baseUrl = arg;
  }
}

baseUrl = baseUrl.replace(/\/+$/, '');

const isColorSupported = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.TERM);
const colors = {
  reset: isColorSupported ? '\x1b[0m' : '',
  bold: isColorSupported ? '\x1b[1m' : '',
  dim: isColorSupported ? '\x1b[2m' : '',
  red: isColorSupported ? '\x1b[31m' : '',
  green: isColorSupported ? '\x1b[32m' : '',
  yellow: isColorSupported ? '\x1b[33m' : '',
  cyan: isColorSupported ? '\x1b[36m' : '',
};

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;
const failures = [];

async function runTest(name, fn) {
  totalTests++;
  process.stdout.write(`  [TEST ${totalTests}] ${name} ... `);
  try {
    await fn();
    passedTests++;
    console.log(`${colors.green}PASS${colors.reset}`);
  } catch (err) {
    failedTests++;
    console.log(`${colors.red}FAIL${colors.reset}`);
    console.error(`    ${colors.red}Error: ${err.message}${colors.reset}`);
    failures.push({ name, error: err.message });
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

async function request(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  let json = null;
  const text = await res.text();
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, body: json, rawText: text };
}

async function main() {
  console.log(`\n${colors.bold}${colors.cyan}======================================================${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}   Hollis Backend Phase 2 Test Suite (Tasks & History)${colors.reset}`);
  console.log(`${colors.bold}${colors.cyan}======================================================${colors.reset}`);
  console.log(`Target Base URL: ${baseUrl}\n`);

  // Setup: Create 2 distinct test users
  const unique = Date.now().toString(36) + Math.random().toString(36).substring(2, 6);
  const userA = { username: `user_a_${unique}`, email: `user_a_${unique}@example.com`, password: 'PasswordA123!' };
  const userB = { username: `user_b_${unique}`, email: `user_b_${unique}@example.com`, password: 'PasswordB123!' };

  let tokenA = '';
  let tokenB = '';

  await runTest('T01: Health check endpoint returns Phase 2 status', async () => {
    const res = await request('/health');
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.status === 'ok', 'Expected status: ok');
    assert(res.body.phase >= 2, `Expected phase >= 2, got ${res.body.phase}`);
  });

  await runTest('T02: Register User A and retrieve access token', async () => {
    const res = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(userA),
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.body.access_token, 'Missing access_token');
    tokenA = res.body.access_token;
  });

  await runTest('T03: Register User B and retrieve access token (isolation check)', async () => {
    const res = await request('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(userB),
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.body.access_token, 'Missing access_token');
    tokenB = res.body.access_token;
  });

  // Task Creation Tests
  await runTest('T04: POST /api/tasks/start rejects unauthenticated requests', async () => {
    const res = await request('/api/tasks/start', {
      method: 'POST',
      body: JSON.stringify({ instruction: 'Open Telegram and send message' }),
    });
    assert(res.status === 401, `Expected 401, got ${res.status}`);
  });

  await runTest('T05: POST /api/tasks/start rejects missing instruction', async () => {
    const res = await request('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({}),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await runTest('T06: POST /api/tasks/start rejects empty whitespace instruction', async () => {
    const res = await request('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ instruction: '   ' }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  let task1Id = '';
  await runTest('T07: POST /api/tasks/start creates task session for User A', async () => {
    const res = await request('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ instruction: 'Open LINE and message Bob hello' }),
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    assert(res.body.session_id, 'Missing session_id in response');
    assert(res.body.status === 'running', `Expected status running, got ${res.body.status}`);
    task1Id = res.body.session_id;
  });

  // Status Polling Fallback Tests
  await runTest('T08: GET /api/tasks/:id/status returns running status and current_step', async () => {
    const res = await request(`/api/tasks/${task1Id}/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.session_id === task1Id, 'Session ID mismatch');
    assert(res.body.status === 'running', `Expected status running, got ${res.body.status}`);
    assert(typeof res.body.current_step === 'number', 'current_step should be a number');
  });

  await runTest('T09: GET /api/tasks/:id/status blocks User B from reading User A task (Isolation)', async () => {
    const res = await request(`/api/tasks/${task1Id}/status`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(res.status === 404, `Expected 404 for unauthorized session access, got ${res.status}`);
  });

  await runTest('T10: GET /api/tasks/:id/status returns 404 for non-existent session', async () => {
    const res = await request('/api/tasks/00000000-0000-0000-0000-000000000000/status', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // Task Summary Tests
  await runTest('T11: GET /api/tasks/:id returns full session summary with duration', async () => {
    const res = await request(`/api/tasks/${task1Id}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.session_id === task1Id, 'Session ID mismatch');
    assert(res.body.instruction === 'Open LINE and message Bob hello', 'Instruction mismatch');
    assert(res.body.status === 'running', 'Status should be running');
    assert(typeof res.body.duration === 'number' && res.body.duration >= 0, 'Invalid duration');
    assert(res.body.created_at, 'Missing created_at');
  });

  // Task Cancellation Tests
  await runTest('T12: POST /api/tasks/:id/cancel cancels active task session', async () => {
    const res = await request(`/api/tasks/${task1Id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.status === 'cancelled', `Expected status cancelled, got ${res.body.status}`);
  });

  await runTest('T13: POST /api/tasks/:id/cancel returns gracefully on already cancelled task', async () => {
    const res = await request(`/api/tasks/${task1Id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.status === 'cancelled', 'Expected status cancelled');
  });

  await runTest('T14: POST /api/tasks/:id/cancel rejects User B cancelling User A task', async () => {
    const res = await request(`/api/tasks/${task1Id}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // Task Confirmation Tests
  await runTest('T15: POST /api/tasks/:id/confirm validates approved boolean input', async () => {
    const res = await request(`/api/tasks/${task1Id}/confirm`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ approved: 'yes' }),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  await runTest('T16: POST /api/tasks/:id/confirm accepts valid approved parameter', async () => {
    const res = await request(`/api/tasks/${task1Id}/confirm`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ approved: true }),
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.status === 'ok', 'Expected status ok');
    assert(res.body.approved === true, 'Expected approved: true');
  });

  // Task History and Filtering Tests
  let task2Id = '';
  let task3Id = '';

  await runTest('T17: Create additional tasks for User A for history queries', async () => {
    const res2 = await request('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ instruction: 'Check weather in Bangkok today' }),
    });
    assert(res2.status === 201);
    task2Id = res2.body.session_id;

    const res3 = await request('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` },
      body: JSON.stringify({ instruction: 'Send email to manager about report' }),
    });
    assert(res3.status === 201);
    task3Id = res3.body.session_id;
  });

  await runTest('T18: GET /api/tasks lists all tasks for User A ordered by started_at DESC', async () => {
    const res = await request('/api/tasks', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(Array.isArray(res.body.tasks), 'tasks should be an array');
    assert(res.body.total >= 3, `Expected at least 3 tasks, got ${res.body.total}`);
    // Check descending order
    assert(res.body.tasks[0].session_id === task3Id, 'Most recent task should be first');
  });

  await runTest('T19: GET /api/tasks?status=cancelled filters by status', async () => {
    const res = await request('/api/tasks?status=cancelled', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.tasks.length >= 1, 'Expected at least 1 cancelled task');
    assert(res.body.tasks.every(t => t.status === 'cancelled'), 'All filtered tasks must be cancelled');
  });

  await runTest('T20: GET /api/tasks?q=Bangkok searches by keyword in instruction', async () => {
    const res = await request('/api/tasks?q=Bangkok', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.tasks.length === 1, `Expected 1 match for Bangkok, got ${res.body.tasks.length}`);
    assert(res.body.tasks[0].session_id === task2Id, 'Matched task ID mismatch');
  });

  await runTest('T21: GET /api/tasks pagination with limit & offset', async () => {
    const res = await request('/api/tasks?limit=1&offset=0', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.tasks.length === 1, `Expected 1 task with limit=1, got ${res.body.tasks.length}`);
    assert(res.body.limit === 1, 'limit mismatch');
    assert(res.body.offset === 0, 'offset mismatch');
  });

  await runTest('T22: User B history does not contain any of User A tasks (User Isolation)', async () => {
    const res = await request('/api/tasks', {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.total === 0, `Expected 0 tasks for User B, got ${res.body.total}`);
  });

  // Task Logs Replay Tests
  await runTest('T23: GET /api/tasks/:id/logs returns step logs array', async () => {
    const res = await request(`/api/tasks/${task1Id}/logs`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` },
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    assert(res.body.session_id === task1Id, 'Session ID mismatch');
    assert(Array.isArray(res.body.logs), 'logs should be an array');
  });

  await runTest('T24: GET /api/tasks/:id/logs returns 404 for User B accessing User A logs', async () => {
    const res = await request(`/api/tasks/${task1Id}/logs`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenB}` },
    });
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  // Summary Report
  console.log(`\n${colors.bold}======================================================${colors.reset}`);
  console.log(`${colors.bold}Test Execution Summary:${colors.reset}`);
  console.log(`  Total:  ${totalTests}`);
  console.log(`  Passed: ${colors.green}${passedTests}${colors.reset}`);
  console.log(`  Failed: ${failedTests > 0 ? colors.red : colors.dim}${failedTests}${colors.reset}`);
  console.log(`${colors.bold}======================================================${colors.reset}\n`);

  if (failedTests > 0) {
    console.error(`${colors.red}${colors.bold}Failed Tests:${colors.reset}`);
    failures.forEach((f) => console.error(`  - ${f.name}: ${f.error}`));
    process.exit(1);
  } else {
    console.log(`${colors.green}${colors.bold}ALL 24 PHASE 2 TESTS PASSED SUCCESSFULLY!${colors.reset}\n`);
    process.exit(0);
  }
}

main().catch((err) => {
  console.error('Fatal test suite runner error:', err);
  process.exit(1);
});
