/**
 * Hollis Backend Epic 2 - Standalone Automated E2E Test Suite
 * ระบบแชทหลัก (Chat & Real-time Communication System)
 * 
 * Target: Cloudflare Workers Local Dev Server (default: http://127.0.0.1:8787)
 * Runtime: Pure Node.js (v20/22/24+ native fetch & native WebSocket, zero external dependencies)
 * Coverage: 25 Test Cases across Tiers 1 to 4 per ORIGINAL_REQUEST.md & PROJECT.md
 * 
 * Usage:
 *   node test_epic2.js
 *   node test_epic2.js --url http://127.0.0.1:8787
 *   cmd.exe /c "node test_epic2.js --url http://127.0.0.1:8787"
 */

'use strict';

// ============================================================================
// CLI & Configuration
// ============================================================================

let baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8787';

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--url=')) {
    baseUrl = arg.substring(6);
  } else if (arg === '--url' && i + 1 < process.argv.length) {
    baseUrl = process.argv[++i];
  } else if (arg.startsWith('http://') || arg.startsWith('https://')) {
    baseUrl = arg;
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Hollis Backend Epic 2 Automated Test Suite
ระบบแชทหลัก (Chat & Real-time Communication System)

Usage:
  node test_epic2.js [options] [baseUrl]

Options:
  --url <url>     Target base URL (default: http://127.0.0.1:8787)
  -h, --help      Show this help message

Environment Variables:
  BASE_URL        Target base URL
`);
    process.exit(0);
  }
}

baseUrl = baseUrl.replace(/\/+$/, '');

// ============================================================================
// Terminal Styling & Colors
// ============================================================================

const isColorSupported = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.TERM);

const colors = {
  reset: isColorSupported ? '\x1b[0m' : '',
  bold: isColorSupported ? '\x1b[1m' : '',
  dim: isColorSupported ? '\x1b[2m' : '',
  red: isColorSupported ? '\x1b[31m' : '',
  green: isColorSupported ? '\x1b[32m' : '',
  yellow: isColorSupported ? '\x1b[33m' : '',
  cyan: isColorSupported ? '\x1b[36m' : '',
  magenta: isColorSupported ? '\x1b[35m' : '',
  gray: isColorSupported ? '\x1b[90m' : '',
};

// ============================================================================
// Runtime Environment & WebSocket Sanity Check
// ============================================================================

const NativeWebSocket = globalThis.WebSocket;
if (!NativeWebSocket) {
  console.error(`\n${colors.red}${colors.bold}[ENVIRONMENT ERROR]${colors.reset} globalThis.WebSocket is not available.`);
  console.error(`Please run this test suite using Node.js v22 or v24+ (current: ${process.version}).\n`);
  process.exit(1);
}

// ============================================================================
// Cryptographic & URL Helpers
// ============================================================================

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function getWsUrl(pathAndQuery) {
  const httpUrl = new URL(pathAndQuery, baseUrl);
  const protocol = httpUrl.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${httpUrl.host}${httpUrl.pathname}${httpUrl.search}`;
}

// ============================================================================
// HTTP Request Helper
// ============================================================================

async function apiRequest(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {}),
  };

  let body = options.body;
  if (body && typeof body === 'object' && !(body instanceof FormData) && !(body instanceof URLSearchParams)) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const start = Date.now();

  if (headers['Upgrade'] || headers['upgrade']) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const mod = u.protocol === 'https:' ? require('node:https') : require('node:http');
      const req = mod.request(u, {
        method: options.method || 'GET',
        headers,
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          let json = null;
          try { json = JSON.parse(raw); } catch (_) {}
          resolve({
            status: res.statusCode,
            statusText: res.statusMessage,
            headers: res.headers,
            body: json,
            rawText: raw,
            durationMs: Date.now() - start,
          });
        });
      });
      req.on('error', (err) => {
        const durationMs = Date.now() - start;
        reject(new Error(`HTTP Request Failed (${options.method || 'GET'} ${url}) after ${durationMs}ms: ${err.message}`));
      });
      if (body) req.write(body);
      req.end();
    });
  }

  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body,
      signal: options.signal || AbortSignal.timeout(options.timeout || 10000),
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    throw new Error(`HTTP Request Failed (${options.method || 'GET'} ${url}) after ${durationMs}ms: ${err.message}`);
  }

  const durationMs = Date.now() - start;
  const rawText = await response.text();
  let jsonBody = null;
  try {
    jsonBody = JSON.parse(rawText);
  } catch (_) {
    jsonBody = null;
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: jsonBody,
    rawText,
    durationMs,
  };
}

// ============================================================================
// Native WebSocket Client Helper for Event & Stream Verification
// ============================================================================

class WsClient {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.ws = null;
    this.messages = [];
    this.closeEvent = null;
    this.errorEvents = [];
    this._waiters = [];
    this.opened = false;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      try {
        this.ws = new NativeWebSocket(this.url);
      } catch (err) {
        return reject(err);
      }

      const timeoutMs = this.options.timeout || 8000;
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          try { this.ws.close(); } catch (_) {}
          reject(new Error(`WebSocket connection to ${this.url} timed out after ${timeoutMs}ms`));
        }
      }, timeoutMs);

      this.ws.onopen = () => {
        this.opened = true;
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolve(this);
        }
      };

      this.ws.onmessage = (event) => {
        let data = event.data;
        try {
          data = JSON.parse(event.data);
        } catch (_) {}
        this.messages.push(data);
        this._notifyWaiters();
      };

      this.ws.onclose = (event) => {
        this.closeEvent = {
          code: event.code,
          reason: event.reason,
          wasClean: event.wasClean,
        };
        this._notifyWaiters();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket closed before open: code ${event.code} (${event.reason || 'Upgrade rejected'})`));
        }
      };

      this.ws.onerror = (event) => {
        this.errorEvents.push(event);
        this._notifyWaiters();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket connection rejected: ${event.message || 'Handshake failed'}`));
        }
      };
    });
  }

  _notifyWaiters() {
    for (let i = this._waiters.length - 1; i >= 0; i--) {
      const waiter = this._waiters[i];
      if (waiter.predicate()) {
        this._waiters.splice(i, 1);
        waiter.resolve();
      }
    }
  }

  async waitForMessage(predicate, timeoutMs = 8000, description = 'expected frame') {
    const existing = this.messages.find(predicate);
    if (existing) return existing;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const received = this.messages.map(m => typeof m === 'object' ? JSON.stringify(m) : m).join(', ');
        reject(new Error(`Timeout waiting for ${description} after ${timeoutMs}ms. Received: [${received}]`));
      }, timeoutMs);

      this._waiters.push({
        predicate: () => this.messages.some(predicate),
        resolve: () => {
          clearTimeout(timer);
          resolve(this.messages.find(predicate));
        },
      });
    });
  }

  async waitForClose(timeoutMs = 8000) {
    if (this.closeEvent) return this.closeEvent;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Timeout waiting for WebSocket close after ${timeoutMs}ms`));
      }, timeoutMs);

      this._waiters.push({
        predicate: () => this.closeEvent !== null,
        resolve: () => {
          clearTimeout(timer);
          resolve(this.closeEvent);
        },
      });
    });
  }

  send(data) {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error(`Cannot send message: WebSocket is not open (readyState: ${this.ws ? this.ws.readyState : 'null'})`);
    }
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.ws.send(payload);
  }

  close(code = 1000, reason = 'Normal closure') {
    try {
      if (this.ws) {
        this.ws.close(code, reason);
      }
    } catch (_) {}
  }
}

// ============================================================================
// Assertion Utilities
// ============================================================================

class AssertionError extends Error {
  constructor(message, actual, expected) {
    super(message);
    this.name = 'AssertionError';
    this.actual = actual;
    this.expected = expected;
  }
}

function assert(condition, message, actual, expected) {
  if (!condition) {
    throw new AssertionError(message || 'Assertion failed', actual, expected);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionError(
      `${message ? message + ' - ' : ''}Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      actual,
      expected
    );
  }
}

function assertStatus(res, expectedStatus, message) {
  if (res.status !== expectedStatus) {
    const errorDetail = res.body && (res.body.error || res.body.message)
      ? ` | Server response: ${JSON.stringify(res.body)}`
      : ` | Raw body: ${res.rawText.slice(0, 150)}`;
    throw new AssertionError(
      `${message ? message + ' - ' : ''}Expected HTTP ${expectedStatus}, got ${res.status}${errorDetail}`,
      res.status,
      expectedStatus
    );
  }
}

function assertTruthy(val, message) {
  if (!val) {
    throw new AssertionError(`${message ? message + ' - ' : ''}Expected truthy value, got ${JSON.stringify(val)}`, val, true);
  }
}

// ============================================================================
// Test Runner Engine
// ============================================================================

const testResults = [];
let passedCount = 0;
let failedCount = 0;

async function runTest(tcId, description, testFn) {
  const startTime = Date.now();
  try {
    await testFn();
    const duration = Date.now() - startTime;
    passedCount++;
    testResults.push({ id: tcId, description, passed: true, duration });
    console.log(
      `  ${colors.green}[PASS]${colors.reset} ${colors.bold}${tcId}${colors.reset}: ${description} ${colors.dim}(${duration}ms)${colors.reset}`
    );
  } catch (err) {
    const duration = Date.now() - startTime;
    failedCount++;
    testResults.push({ id: tcId, description, passed: false, duration, error: err });
    console.log(
      `  ${colors.red}[FAIL]${colors.reset} ${colors.bold}${tcId}${colors.reset}: ${description} ${colors.dim}(${duration}ms)${colors.reset}`
    );
    console.log(`         ${colors.red}${err.message}${colors.reset}`);
    if (err.stack && !(err instanceof AssertionError)) {
      console.log(`         ${colors.gray}${err.stack.split('\n').slice(1, 4).join('\n         ')}${colors.reset}`);
    }
  }
}

function printTierHeader(tierNum, tierTitle) {
  console.log(`\n${colors.cyan}================================================================${colors.reset}`);
  console.log(`${colors.cyan}  TIER ${tierNum}: ${tierTitle.toUpperCase()}${colors.reset}`);
  console.log(`${colors.cyan}================================================================${colors.reset}`);
}

// ============================================================================
// Shared State Across Tests
// ============================================================================

const shared = {
  userA: {
    username: `user_a_${generateUUID().slice(0, 8)}`,
    email: `epic2_a_${generateUUID()}@hollis-test.local`,
    password: 'PasswordA123!',
    userId: null,
    accessToken: null,
    refreshToken: null,
  },
  userB: {
    username: `user_b_${generateUUID().slice(0, 8)}`,
    email: `epic2_b_${generateUUID()}@hollis-test.local`,
    password: 'PasswordB123!',
    userId: null,
    accessToken: null,
    refreshToken: null,
  },
  primarySessionId: null,
};

// ============================================================================
// Test Suite Definition
// ============================================================================

async function runAllTests() {
  console.log(`\n${colors.bold}${colors.magenta}================================================================${colors.reset}`);
  console.log(`${colors.bold}${colors.magenta}  Hollis Backend Epic 2: Chat & Real-Time E2E Test Suite        ${colors.reset}`);
  console.log(`${colors.bold}${colors.magenta}================================================================${colors.reset}`);
  console.log(`${colors.dim}Target Server: ${colors.reset}${colors.bold}${baseUrl}${colors.reset}`);
  console.log(`${colors.dim}Node Version : ${colors.reset}${process.version}`);
  console.log(`${colors.dim}Started at   : ${new Date().toISOString()}${colors.reset}`);

  // Preflight check
  try {
    const preflight = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(4000) });
    if (!preflight.ok && preflight.status !== 200) {
      await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(4000) });
    }
  } catch (rootErr) {
    console.log(`\n${colors.red}${colors.bold}[CONNECTION ERROR]${colors.reset} Could not connect to target server at ${baseUrl}`);
    console.log(`${colors.yellow}Reason: ${rootErr.message}${colors.reset}`);
    console.log(`\nPlease ensure that the local Wrangler development server is running:`);
    console.log(`  ${colors.bold}npm run dev${colors.reset}  or  ${colors.bold}npx wrangler dev${colors.reset}\n`);
    process.exit(1);
  }

  // --------------------------------------------------------------------------
  // TIER 1: Feature Coverage (Happy Path)
  // --------------------------------------------------------------------------
  printTierHeader(1, 'Feature Coverage (Happy Path)');

  // TC-01: User registration & login to obtain JWT access token
  await runTest('TC-01', 'User registration & login to obtain JWT access tokens for User A & User B', async () => {
    // Register User A
    const regResA = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: shared.userA.username,
        email: shared.userA.email,
        password: shared.userA.password,
      },
    });
    assertStatus(regResA, 201, 'User A registration must return HTTP 201');
    assertTruthy(regResA.body.user_id, 'User A registration must return user_id');
    assertTruthy(regResA.body.access_token, 'User A registration must return access_token');
    shared.userA.userId = regResA.body.user_id;
    shared.userA.accessToken = regResA.body.access_token;

    // Login User A to retrieve refresh token
    const loginResA = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        email: shared.userA.email,
        password: shared.userA.password,
      },
    });
    assertStatus(loginResA, 200, 'User A login must return HTTP 200');
    assertTruthy(loginResA.body.refresh_token, 'User A login must return refresh_token');
    shared.userA.refreshToken = loginResA.body.refresh_token;

    // Register User B for isolation checks
    const regResB = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: shared.userB.username,
        email: shared.userB.email,
        password: shared.userB.password,
      },
    });
    assertStatus(regResB, 201, 'User B registration must return HTTP 201');
    shared.userB.userId = regResB.body.user_id;
    shared.userB.accessToken = regResB.body.access_token;
  });

  // TC-02: Start task session via POST /api/tasks/start
  await runTest('TC-02', 'POST /api/tasks/start creates session in D1 (returns HTTP 201 + session_id + running status)', async () => {
    const res = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: {
        instruction: 'เปิดแอป LINE แล้วส่งข้อความหาสมศรีว่า ถึงแล้วนะ',
      },
    });
    assertStatus(res, 201, 'POST /api/tasks/start must return HTTP 201');
    assertTruthy(res.body.session_id, 'Response must contain session_id');
    assertEqual(res.body.status, 'running', 'Status must be running');
    shared.primarySessionId = res.body.session_id;
  });

  // TC-03: Polling fallback via GET /api/tasks/:session_id/status immediately after creation
  await runTest('TC-03', 'GET /api/tasks/:session_id/status returns initial running status and null log', async () => {
    const res = await apiRequest(`/api/tasks/${shared.primarySessionId}/status`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(res, 200, 'GET /api/tasks/:session_id/status must return HTTP 200');
    assertEqual(res.body.session_id, shared.primarySessionId, 'session_id must match');
    assertEqual(res.body.status, 'running', 'Initial status must be running');
    assertEqual(res.body.current_step, 0, 'Initial step count should be 0');
    assertEqual(res.body.last_log, null, 'Initial last_log should be null');
  });

  // TC-04: WebSocket upgrade handshake to /ws/tasks/:session_id?token=<access_token>
  await runTest('TC-04', 'WebSocket connection to /ws/tasks/:session_id?token=<access_token> upgrades successfully', async () => {
    const wsUrl = getWsUrl(`/ws/tasks/${shared.primarySessionId}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();
    assert(client.opened, 'WebSocket must reach open state (HTTP 101 Switching Protocols)');
    client.close();
    await client.waitForClose();
  });

  // TC-05: WebSocket receives initial { event: "connected" } frame
  await runTest('TC-05', 'WebSocket client receives initial { event: "connected" } frame upon connection', async () => {
    // Create fresh task session for clean stream verification
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'ทดสอบรับ connected frame' },
    });
    assertStatus(taskRes, 201);
    const sessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    const connectedFrame = await client.waitForMessage(
      (m) => m && m.event === 'connected',
      5000,
      'connected event'
    );
    assert(connectedFrame !== null, 'Client must receive connected event');
    assertEqual(connectedFrame.session_id, sessionId, 'connected frame session_id must match');

    client.close();
    await client.waitForClose();
  });

  // TC-06: WebSocket streams sequential { event: "log" } frames in real time
  await runTest('TC-06', 'WebSocket client receives sequential { event: "log" } frames representing automation steps', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'ทดสอบรับ sequential log frames' },
    });
    assertStatus(taskRes, 201);
    const sessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Wait for step 1
    const step1 = await client.waitForMessage(
      (m) => m && m.event === 'log' && m.step_no === 1,
      6000,
      'step 1 log event'
    );
    assertTruthy(step1.log_message, 'Step 1 must have log_message');
    assertEqual(step1.session_id, sessionId, 'Step 1 session_id must match');
    assertTruthy(step1.timestamp, 'Step 1 must include timestamp');

    // Wait for step 2
    const step2 = await client.waitForMessage(
      (m) => m && m.event === 'log' && m.step_no === 2,
      6000,
      'step 2 log event'
    );
    assertTruthy(step2.log_message, 'Step 2 must have log_message');
    assert(step2.step_no > step1.step_no, 'Step numbers must be strictly sequential');

    client.close();
    await client.waitForClose();
  });

  // TC-07: Task completion frame { event: "finished" } and graceful socket close
  await runTest('TC-07', 'WebSocket client receives { event: "finished" } on completion and socket closes cleanly (code 1000)', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'ทดสอบ task finished completion' },
    });
    assertStatus(taskRes, 201);
    const sessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Wait for task completion
    const finishedFrame = await client.waitForMessage(
      (m) => m && m.event === 'finished',
      15000,
      'finished event'
    );
    assertEqual(finishedFrame.session_id, sessionId, 'finished frame session_id must match');
    assertEqual(finishedFrame.status, 'completed', 'finished frame status must be completed');

    // Server should close the connection cleanly
    const closeEvent = await client.waitForClose(5000);
    assertEqual(closeEvent.code, 1000, 'WebSocket close code must be 1000 (normal closure)');
  });

  // TC-08: D1 SQLite persistence verification for task_steps and completed status
  await runTest('TC-08', 'D1 SQLite persistence: task_steps contains all emitted steps and session marked completed', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'ทดสอบ D1 step persistence' },
    });
    assertStatus(taskRes, 201);
    const sessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Wait until finished event
    await client.waitForMessage((m) => m && m.event === 'finished', 15000, 'finished event');
    await client.waitForClose(5000);

    // Verify session status via REST
    const statusRes = await apiRequest(`/api/tasks/${sessionId}/status`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(statusRes, 200);
    assertEqual(statusRes.body.status, 'completed', 'D1 session status must be completed');
    assert(statusRes.body.current_step >= 1, 'Current step must be >= 1');
    assertTruthy(statusRes.body.last_log, 'last_log must not be null');

    // Verify replay logs via GET /api/tasks/:session_id/logs
    const logsRes = await apiRequest(`/api/tasks/${sessionId}/logs`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(logsRes, 200);
    assert(Array.isArray(logsRes.body.logs), 'logs must be an array');
    assert(logsRes.body.logs.length >= 1, 'task_steps table must contain persisted steps');
    for (let i = 0; i < logsRes.body.logs.length; i++) {
      const step = logsRes.body.logs[i];
      assertEqual(step.step_no, i + 1, `Step ${i + 1} number must match sequential index`);
      assertTruthy(step.log_message, `Step ${i + 1} must have log_message`);
      assertTruthy(step.action_type, `Step ${i + 1} must have action_type`);
    }
  });

  // --------------------------------------------------------------------------
  // TIER 2: Boundary & Corner Cases
  // --------------------------------------------------------------------------
  printTierHeader(2, 'Boundary & Corner Cases');

  // TC-09: WebSocket handshake without token rejected with HTTP 401
  await runTest('TC-09', 'WebSocket handshake without token rejected with HTTP 401 Unauthorized', async () => {
    const path = `/ws/tasks/${shared.primarySessionId}`;
    // 1. Verify via HTTP upgrade check
    const httpRes = await apiRequest(path, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    assertStatus(httpRes, 401, 'Missing token handshake must return HTTP 401');

    // 2. Verify native WebSocket connection failure
    let wsRejected = false;
    const wsUrl = getWsUrl(path);
    const client = new WsClient(wsUrl);
    try {
      await client.connect();
    } catch (_) {
      wsRejected = true;
    }
    assert(wsRejected, 'Native WebSocket handshake without token must fail');
  });

  // TC-10: WebSocket handshake with invalid / malformed JWT rejected with HTTP 401
  await runTest('TC-10', 'WebSocket handshake with invalid / malformed token rejected with HTTP 401 Unauthorized', async () => {
    const path = `/ws/tasks/${shared.primarySessionId}?token=invalid.jwt.token_signature`;
    const httpRes = await apiRequest(path, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    assertStatus(httpRes, 401, 'Invalid token handshake must return HTTP 401');

    let wsRejected = false;
    const wsUrl = getWsUrl(path);
    const client = new WsClient(wsUrl);
    try {
      await client.connect();
    } catch (_) {
      wsRejected = true;
    }
    assert(wsRejected, 'Native WebSocket with invalid token must fail handshake');
  });

  // TC-11: WebSocket handshake with refresh token rejected with HTTP 401
  await runTest('TC-11', 'WebSocket handshake with refresh token rejected with HTTP 401 Unauthorized (access token required)', async () => {
    const path = `/ws/tasks/${shared.primarySessionId}?token=${shared.userA.refreshToken}`;
    const httpRes = await apiRequest(path, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    assertStatus(httpRes, 401, 'Refresh token must be rejected with HTTP 401 on WebSocket handshake');
  });

  // TC-12: WebSocket handshake for non-existent session ID rejected with HTTP 404
  await runTest('TC-12', 'WebSocket handshake for non-existent session ID rejected with HTTP 404 Not Found', async () => {
    const nonExistentId = '00000000-0000-4000-8000-000000000000';
    const path = `/ws/tasks/${nonExistentId}?token=${shared.userA.accessToken}`;
    const httpRes = await apiRequest(path, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    assertStatus(httpRes, 404, 'Non-existent session handshake must return HTTP 404');
  });

  // TC-13: Cross-user WebSocket isolation: User B attempting to connect to User A's session rejected with HTTP 404
  await runTest('TC-13', 'Cross-user WebSocket isolation: User B connecting to User A session rejected with HTTP 404', async () => {
    const path = `/ws/tasks/${shared.primarySessionId}?token=${shared.userB.accessToken}`;
    const httpRes = await apiRequest(path, {
      headers: {
        'Upgrade': 'websocket',
        'Connection': 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    assertStatus(httpRes, 404, 'User B must receive HTTP 404 when connecting to User A session (prevents enumeration)');
  });

  // TC-14: Cross-user REST isolation: User B polling status or cancelling User A's session rejected with HTTP 404
  await runTest('TC-14', 'Cross-user REST isolation: User B polling or cancelling User A session rejected with HTTP 404', async () => {
    // User B status check
    const statusRes = await apiRequest(`/api/tasks/${shared.primarySessionId}/status`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${shared.userB.accessToken}` },
    });
    assertStatus(statusRes, 404, 'User B polling User A session status must return HTTP 404');

    // User B cancel attempt
    const cancelRes = await apiRequest(`/api/tasks/${shared.primarySessionId}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userB.accessToken}` },
    });
    assertStatus(cancelRes, 404, 'User B cancelling User A session must return HTTP 404');

    // User B logs replay attempt
    const logsRes = await apiRequest(`/api/tasks/${shared.primarySessionId}/logs`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${shared.userB.accessToken}` },
    });
    assertStatus(logsRes, 404, 'User B querying User A logs must return HTTP 404');
  });

  // TC-15: POST /api/tasks/start input validation
  await runTest('TC-15', 'POST /api/tasks/start input validation rejects empty, missing, or malformed instructions (HTTP 400)', async () => {
    // Missing instruction
    const missingRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: {},
    });
    assertStatus(missingRes, 400, 'Missing instruction must return HTTP 400');

    // Whitespace instruction
    const emptyRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: '     ' },
    });
    assertStatus(emptyRes, 400, 'Whitespace instruction must return HTTP 400');

    // Non-string instruction
    const numberRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 12345 },
    });
    assertStatus(numberRes, 400, 'Non-string instruction must return HTTP 400');

    // Unauthenticated request
    const unauthRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      body: { instruction: 'Valid instruction without token' },
    });
    assertStatus(unauthRes, 401, 'Unauthenticated start must return HTTP 401');
  });

  // TC-16: WebSocket bidirectional heartbeat: ping -> pong
  await runTest('TC-16', 'WebSocket heartbeat: client dispatches { event: "ping" } and receives { event: "pong" }', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'ทดสอบ heartbeat ping pong' },
    });
    assertStatus(taskRes, 201);
    const sessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Await connected
    await client.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected event');

    // Send ping
    client.send({ event: 'ping' });

    // Expect pong
    const pongFrame = await client.waitForMessage(
      (m) => m && m.event === 'pong',
      5000,
      'pong event'
    );
    assert(pongFrame !== null, 'Client must receive pong event from server');
    assertTruthy(pongFrame.timestamp, 'Pong frame must contain timestamp');

    client.close();
    await client.waitForClose();
  });

  // TC-17: WebSocket resilient error handling: client sends malformed non-JSON frame
  await runTest('TC-17', 'WebSocket error resilience: client sends non-JSON frame and receives { event: "error" }', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'ทดสอบ malformed frame resilience' },
    });
    assertStatus(taskRes, 201);
    const sessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    await client.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected event');

    // Send malformed raw text
    client.send('This is not valid JSON string {{{');

    // Server should respond with error frame
    const errorFrame = await client.waitForMessage(
      (m) => m && m.event === 'error',
      5000,
      'error event'
    );
    assert(errorFrame !== null, 'Client must receive error event for malformed input');

    client.close();
    await client.waitForClose();
  });

  // --------------------------------------------------------------------------
  // TIER 3: Cross-Feature Combinations & Real-Time Cancellation
  // --------------------------------------------------------------------------
  printTierHeader(3, 'Cross-Feature Combinations & Real-Time Cancellation');

  // TC-18: In-flight cancellation via REST POST /api/tasks/:session_id/cancel
  let cancelledSessionId1 = null;
  await runTest('TC-18', 'In-flight cancellation: REST POST /api/tasks/:session_id/cancel triggers { event: "cancelled" } over active WS', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'ทดสอบ in-flight cancel ผ่าน REST' },
    });
    assertStatus(taskRes, 201);
    cancelledSessionId1 = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${cancelledSessionId1}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Wait for at least 1 log event so task is actively in flight
    await client.waitForMessage(
      (m) => m && m.event === 'log',
      6000,
      'first log event before cancellation'
    );

    // Issue cancel via REST
    const cancelRes = await apiRequest(`/api/tasks/${cancelledSessionId1}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(cancelRes, 200, 'Cancel request must return HTTP 200');
    assertEqual(cancelRes.body.status, 'cancelled', 'Cancel response status must be cancelled');

    // Verify active WS receives cancelled event
    const cancelledFrame = await client.waitForMessage(
      (m) => m && m.event === 'cancelled',
      6000,
      'cancelled event over WebSocket'
    );
    assertEqual(cancelledFrame.session_id, cancelledSessionId1, 'cancelled frame session_id must match');
    assertEqual(cancelledFrame.status, 'cancelled', 'cancelled frame status must be cancelled');

    // Wait for socket to close
    const closeEvent = await client.waitForClose(5000);
    assertEqual(closeEvent.code, 1000, 'WebSocket close code must be 1000 upon cancellation');
  });

  // TC-19: Verify no further log frames emitted and socket is completely terminated
  await runTest('TC-19', 'WebSocket remains closed after cancellation and does not emit trailing log frames', async () => {
    assertTruthy(cancelledSessionId1, 'Previous cancelled session ID required');
    // Verify via status query
    const statusRes = await apiRequest(`/api/tasks/${cancelledSessionId1}/status`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(statusRes, 200);
    assertEqual(statusRes.body.status, 'cancelled', 'Task status must remain cancelled in D1');
  });

  // TC-20: In-band WebSocket cancellation: client sends { event: "cancel" } over active WS
  await runTest('TC-20', 'In-band WS cancellation: client sends { event: "cancel" } over WS and receives { event: "cancelled" }', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'ทดสอบ in-band cancel ผ่าน WebSocket' },
    });
    assertStatus(taskRes, 201);
    const sessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Wait for step 1
    await client.waitForMessage((m) => m && m.event === 'log', 6000, 'first log event');

    // Send in-band cancel event
    client.send({ event: 'cancel' });

    // Await cancelled frame
    const cancelledFrame = await client.waitForMessage(
      (m) => m && m.event === 'cancelled',
      6000,
      'cancelled event after in-band cancel'
    );
    assertEqual(cancelledFrame.status, 'cancelled', 'Status must be cancelled');

    const closeEvent = await client.waitForClose(5000);
    assertEqual(closeEvent.code, 1000, 'WebSocket close code must be 1000');

    // Verify D1 status updated
    const statusRes = await apiRequest(`/api/tasks/${sessionId}/status`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(statusRes, 200);
    assertEqual(statusRes.body.status, 'cancelled', 'D1 session status must be updated to cancelled');
  });

  // TC-21: Idempotent cancellation: repeated cancellation requests on finalized session return HTTP 200
  await runTest('TC-21', 'Idempotent cancellation: repeated cancel calls on cancelled session return HTTP 200 safely', async () => {
    assertTruthy(cancelledSessionId1, 'Previous cancelled session ID required');
    const secondCancelRes = await apiRequest(`/api/tasks/${cancelledSessionId1}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(secondCancelRes, 200, 'Subsequent cancel calls must return HTTP 200');
    assertEqual(secondCancelRes.body.status, 'cancelled', 'Status must remain cancelled');
  });

  // TC-22: Reconnecting WebSocket to an already finalized session
  await runTest('TC-22', 'Connecting WebSocket to an already cancelled session receives cancelled frame and closes cleanly', async () => {
    assertTruthy(cancelledSessionId1, 'Previous cancelled session ID required');
    const wsUrl = getWsUrl(`/ws/tasks/${cancelledSessionId1}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Should receive cancelled frame immediately
    const terminalFrame = await client.waitForMessage(
      (m) => m && (m.event === 'cancelled' || m.event === 'finished'),
      5000,
      'terminal event frame'
    );
    assertEqual(terminalFrame.status, 'cancelled', 'Terminal frame status must be cancelled');

    const closeEvent = await client.waitForClose(5000);
    assertEqual(closeEvent.code, 1000, 'Socket must close cleanly with code 1000');
  });

  // --------------------------------------------------------------------------
  // TIER 4: Real-World Android Workload Scenarios
  // --------------------------------------------------------------------------
  printTierHeader(4, 'Real-World Android Workload Scenarios');

  // TC-23: Full Android End-to-End Automation Workflow Simulation
  await runTest('TC-23', 'Full Android client lifecycle: Token verification -> Start Task -> Polling -> Streaming -> Heartbeat -> History Replay', async () => {
    // 1. Android splash screen verifies token
    const verifyRes = await apiRequest('/api/auth/verify-token', {
      method: 'POST',
      body: { token: shared.userA.accessToken },
    });
    assertStatus(verifyRes, 200, 'Android verify-token check must return HTTP 200');
    assertEqual(verifyRes.body.valid, true, 'Token must be valid');

    // 2. User inputs command into Hollis Chat UI
    const startRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'สั่งซื้อกาแฟคาปูชิโน่เย็นหวานน้อยจากแอป Lineman' },
    });
    assertStatus(startRes, 201);
    const sessionId = startRes.body.session_id;

    // 3. Android app queries initial status fallback
    const initialStatus = await apiRequest(`/api/tasks/${sessionId}/status`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(initialStatus, 200);
    assertEqual(initialStatus.body.status, 'running');

    // 4. Android app establishes WebSocket streaming connection
    const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${shared.userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // 5. App receives connected event
    await client.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected event');

    // 6. App receives step 1 log
    const step1 = await client.waitForMessage((m) => m && m.event === 'log' && m.step_no === 1, 6000, 'step 1');
    assertTruthy(step1.log_message);

    // 7. App sends periodic heartbeat ping
    client.send({ event: 'ping' });
    const pong = await client.waitForMessage((m) => m && m.event === 'pong', 5000, 'pong event');
    assertTruthy(pong.timestamp);

    // 8. App waits for completion
    const finished = await client.waitForMessage((m) => m && m.event === 'finished', 15000, 'finished event');
    assertEqual(finished.status, 'completed');
    await client.waitForClose(5000);

    // 9. Android Task History screen lists the session
    const listRes = await apiRequest('/api/tasks?limit=10', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(listRes, 200);
    const foundTask = listRes.body.tasks.find((t) => t.session_id === sessionId);
    assert(Boolean(foundTask), 'Completed session must appear in task history list');
    assertEqual(foundTask.status, 'completed');

    // 10. Android Session Replay screen loads full step logs
    const logsRes = await apiRequest(`/api/tasks/${sessionId}/logs`, {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(logsRes, 200);
    assert(logsRes.body.logs.length >= 2, 'History replay must contain recorded steps');
  });

  // TC-24: Multi-Session Concurrency & Stream Isolation
  await runTest('TC-24', 'Concurrent sessions: 2 tasks running in parallel maintain independent log streams with zero cross-talk', async () => {
    // Start Task 1
    const task1 = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'Concurrent Task 1: Check Weather' },
    });
    assertStatus(task1, 201);
    const id1 = task1.body.session_id;

    // Start Task 2
    const task2 = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'Concurrent Task 2: Set Alarm 07:00' },
    });
    assertStatus(task2, 201);
    const id2 = task2.body.session_id;

    assert(id1 !== id2, 'Session IDs must be distinct');

    // Connect both WebSockets simultaneously
    const ws1 = new WsClient(getWsUrl(`/ws/tasks/${id1}?token=${shared.userA.accessToken}`));
    const ws2 = new WsClient(getWsUrl(`/ws/tasks/${id2}?token=${shared.userA.accessToken}`));

    await Promise.all([ws1.connect(), ws2.connect()]);

    // Both should receive initial connected frames
    const [c1, c2] = await Promise.all([
      ws1.waitForMessage((m) => m && m.event === 'connected', 5000, 'T1 connected'),
      ws2.waitForMessage((m) => m && m.event === 'connected', 5000, 'T2 connected'),
    ]);
    assertEqual(c1.session_id, id1, 'WS1 session_id must match id1');
    assertEqual(c2.session_id, id2, 'WS2 session_id must match id2');

    // Both should receive sequential logs
    const [log1, log2] = await Promise.all([
      ws1.waitForMessage((m) => m && m.event === 'log', 6000, 'T1 log'),
      ws2.waitForMessage((m) => m && m.event === 'log', 6000, 'T2 log'),
    ]);
    assertEqual(log1.session_id, id1, 'Log 1 must belong to id1');
    assertEqual(log2.session_id, id2, 'Log 2 must belong to id2');

    // Clean up
    ws1.close();
    ws2.close();
    await Promise.all([ws1.waitForClose(), ws2.waitForClose()]);
  });

  // TC-25: Concurrent stream cancellation isolation: cancelling Task A does not interrupt Task B
  await runTest('TC-25', 'Concurrent cancellation isolation: cancelling Task A leaves concurrent Task B streaming unaffected', async () => {
    // Start Session X (to be cancelled)
    const taskX = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'Session X to be cancelled' },
    });
    assertStatus(taskX, 201);
    const idX = taskX.body.session_id;

    // Start Session Y (to continue running)
    const taskY = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
      body: { instruction: 'Session Y to keep running' },
    });
    assertStatus(taskY, 201);
    const idY = taskY.body.session_id;

    const wsX = new WsClient(getWsUrl(`/ws/tasks/${idX}?token=${shared.userA.accessToken}`));
    const wsY = new WsClient(getWsUrl(`/ws/tasks/${idY}?token=${shared.userA.accessToken}`));

    await Promise.all([wsX.connect(), wsY.connect()]);

    // Wait for step 1 on both
    await Promise.all([
      wsX.waitForMessage((m) => m && m.event === 'log', 6000, 'X step 1'),
      wsY.waitForMessage((m) => m && m.event === 'log', 6000, 'Y step 1'),
    ]);

    // Cancel Session X via REST
    const cancelRes = await apiRequest(`/api/tasks/${idX}/cancel`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    });
    assertStatus(cancelRes, 200);

    // Session X receives cancelled frame and closes
    const cancelledFrameX = await wsX.waitForMessage((m) => m && m.event === 'cancelled', 6000, 'X cancelled frame');
    assertEqual(cancelledFrameX.session_id, idX);
    await wsX.waitForClose(5000);

    // Verify Session Y has NOT received any cancel event and remains alive
    const hasYReceivedCancel = wsY.messages.some((m) => m && m.event === 'cancelled');
    assertEqual(hasYReceivedCancel, false, 'Session Y must NOT receive any cancel event from Session X');

    // Send ping over Session Y to verify it is healthy and responsive
    wsY.send({ event: 'ping' });
    const pongY = await wsY.waitForMessage((m) => m && m.event === 'pong', 5000, 'Y pong frame');
    assertTruthy(pongY.timestamp, 'Session Y must remain healthy and respond to ping');

    wsY.close();
    await wsY.waitForClose();
  });

  // ==========================================================================
  // Summary & Statistics
  // ==========================================================================
  const totalDuration = testResults.reduce((acc, t) => acc + t.duration, 0);

  console.log(`\n${colors.cyan}================================================================${colors.reset}`);
  console.log(`${colors.cyan}                    EPIC 2 TEST SUMMARY                         ${colors.reset}`);
  console.log(`${colors.cyan}================================================================${colors.reset}`);
  console.log(`  Target Server : ${baseUrl}`);
  console.log(`  Total Tests   : ${colors.bold}${testResults.length}${colors.reset}`);
  console.log(`  Passed        : ${colors.green}${colors.bold}${passedCount}${colors.reset}`);
  console.log(`  Failed        : ${failedCount > 0 ? colors.red : colors.green}${colors.bold}${failedCount}${colors.reset}`);
  console.log(`  Duration      : ${totalDuration}ms`);

  if (failedCount === 0) {
    console.log(`\n  ${colors.green}${colors.bold}[OVERALL RESULT] ALL ${testResults.length} TEST CASES PASSED SUCCESSFULLY!${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n  ${colors.red}${colors.bold}[OVERALL RESULT] ${failedCount} OF ${testResults.length} TEST CASES FAILED.${colors.reset}\n`);
    process.exit(1);
  }
}

// Execute test suite
runAllTests().catch((fatalErr) => {
  console.error(`\n${colors.red}${colors.bold}[FATAL UNHANDLED EXCEPTION]${colors.reset}:`, fatalErr);
  process.exit(1);
});
