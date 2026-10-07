/**
 * Hollis Backend Epic 2 - Adversarial Stress & Forensic Integrity Test Suite
 * Agent: challenger_2 (Adversarial Empirical Challenger)
 * 
 * Focus Areas:
 * 1. Token Spoofing: Tampered JWT signatures, alg "none", expired tokens, wrong secret keys
 * 2. In-Flight Cancellation Race Conditions: Cancelling at step 1, step 3, and step 5
 * 3. Repeat Cancellation Spamming: Concurrent POST /api/tasks/:id/cancel bombardment
 * 4. In-Band WebSocket Cancellation: {"event": "cancel"} frame and socket termination
 * 5. D1 SQLite Database Integrity: sessions.status, step_count invariants, and task_steps continuity
 * 
 * Target: Cloudflare Workers Local Dev Server (default: http://127.0.0.1:8787)
 * Runtime: Pure Node.js (v20/22/24+ native fetch & native WebSocket, zero external dependencies)
 * 
 * Usage:
 *   node test_challenger2_stress.js
 *   node test_challenger2_stress.js --url http://127.0.0.1:8787
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
  }
}

baseUrl = baseUrl.replace(/\/+$/, '');

// ============================================================================
// Colors & Formatting
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
// Native WebSocket Check
// ============================================================================

const NativeWebSocket = globalThis.WebSocket;
if (!NativeWebSocket) {
  console.error(`\n${colors.red}[FATAL] globalThis.WebSocket is not available. Please use Node.js v22+${colors.reset}\n`);
  process.exit(1);
}

// ============================================================================
// Helper Utilities & Web Crypto JWT Generator
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

const textEncoder = new TextEncoder();

function bytesToBase64Url(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return Buffer.from(binary, 'binary')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function stringToBase64Url(str) {
  return Buffer.from(str, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function createSpoofedJwt(headerObj, payloadObj, secretKey = 'hollis-default-dev-secret-key-do-not-use-in-prod-32bytes') {
  const encodedHeader = stringToBase64Url(JSON.stringify(headerObj));
  const encodedPayload = stringToBase64Url(JSON.stringify(payloadObj));
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  if (headerObj.alg === 'none') {
    return `${signingInput}.`;
  }

  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secretKey),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, textEncoder.encode(signingInput));
  const encodedSignature = bytesToBase64Url(new Uint8Array(signature));

  return `${signingInput}.${encodedSignature}`;
}

// ============================================================================
// HTTP Request Wrapper
// ============================================================================

async function apiRequest(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = {
    Accept: 'application/json',
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
// Reliable WebSocket Test Client
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
          reject(new Error(`WebSocket connection error: ${event.message || 'Handshake failed'}`));
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
        const received = this.messages.map((m) => typeof m === 'object' ? JSON.stringify(m) : m).join(', ');
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

  close(code = 1000, reason = 'Test client closed') {
    if (this.ws && (this.ws.readyState === 0 || this.ws.readyState === 1)) {
      this.ws.close(code, reason);
    }
  }
}

// ============================================================================
// Assertion Harness
// ============================================================================

class AssertionError extends Error {
  constructor(message, actual, expected) {
    super(message);
    this.name = 'AssertionError';
    this.actual = actual;
    this.expected = expected;
  }
}

function assert(condition, message = 'Assertion failed') {
  if (!condition) throw new AssertionError(message, condition, true);
}

function assertEqual(actual, expected, message = '') {
  if (actual !== expected) {
    const msg = message ? `${message} | Expected ${expected}, got ${actual}` : `Expected ${expected}, got ${actual}`;
    throw new AssertionError(msg, actual, expected);
  }
}

function assertStatus(response, expectedStatus, message = '') {
  if (response.status !== expectedStatus) {
    const errorDetail = response.body?.error || response.body?.message || response.rawText || '';
    const msg = `${message || 'Unexpected HTTP status'}: expected ${expectedStatus}, got ${response.status}. Detail: ${errorDetail}`;
    throw new AssertionError(msg, response.status, expectedStatus);
  }
}

const testResults = [];

async function runTest(id, description, testFn) {
  const start = Date.now();
  process.stdout.write(`  [${id}] ${description} ... `);
  try {
    await testFn();
    const duration = Date.now() - start;
    testResults.push({ id, description, status: 'PASS', duration });
    console.log(`${colors.green}${colors.bold}PASS${colors.reset} ${colors.gray}(${duration}ms)${colors.reset}`);
  } catch (err) {
    const duration = Date.now() - start;
    testResults.push({ id, description, status: 'FAIL', duration, error: err });
    console.log(`${colors.red}${colors.bold}FAIL${colors.reset} ${colors.gray}(${duration}ms)${colors.reset}`);
    console.log(`    ${colors.red}${err.message}${colors.reset}`);
  }
}

// ============================================================================
// Main Adversarial Test Execution
// ============================================================================

async function runAdversarialHarness() {
  console.log(`\n${colors.magenta}${colors.bold}================================================================${colors.reset}`);
  console.log(`${colors.magenta}${colors.bold}    CHALLENGER 2: ADVERSARIAL STRESS & INTEGRITY SUITE          ${colors.reset}`);
  console.log(`${colors.magenta}${colors.bold}================================================================${colors.reset}`);
  console.log(`  Target Base URL: ${colors.bold}${baseUrl}${colors.reset}\n`);

  // Preflight health check
  try {
    const health = await apiRequest('/health');
    assertStatus(health, 200, 'Server health check');
    console.log(`  ${colors.green}[PREFLIGHT OK] Server responsive (${health.body?.service || 'hollis-backend'})${colors.reset}\n`);
  } catch (err) {
    console.error(`  ${colors.red}[PREFLIGHT FAILED] Cannot reach target server at ${baseUrl}.${colors.reset}`);
    console.error(`  Ensure Wrangler local dev server is running (npm run dev).\n`);
    process.exit(1);
  }

  // Provision authenticated user accounts for testing
  const runId = generateUUID().substring(0, 8);
  const user = {
    username: `chal2_user_${runId}`,
    email: `chal2_${runId}@example.com`,
    password: `P@ssword123!_${runId}`,
    userId: null,
    accessToken: null,
    refreshToken: null,
  };

  const regRes = await apiRequest('/api/auth/register', {
    method: 'POST',
    body: { username: user.username, email: user.email, password: user.password },
  });
  assertStatus(regRes, 201, 'User registration');
  user.userId = regRes.body.user_id;
  user.accessToken = regRes.body.access_token;

  const loginRes = await apiRequest('/api/auth/login', {
    method: 'POST',
    body: { email: user.email, password: user.password },
  });
  assertStatus(loginRes, 200, 'User login');
  user.refreshToken = loginRes.body.refresh_token;

  console.log(`  ${colors.cyan}[AUTH SETUP] Provisioned test user ${user.userId}${colors.reset}\n`);

  // ==========================================================================
  // SECTION 1: Token Spoofing & Auth Security
  // ==========================================================================
  console.log(`${colors.yellow}${colors.bold}--- SECTION 1: Token Spoofing & Auth Security ---${colors.reset}`);

  // Test S1-01: Tampered JWT Signature on REST
  await runTest('S1-01', 'REST: Tampered JWT signature is rejected with HTTP 401', async () => {
    const parts = user.accessToken.split('.');
    // Flip characters in the signature part
    const tamperedSig = parts[2].substring(0, parts[2].length - 4) + 'WXYZ';
    const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`;

    const res = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${tamperedToken}` },
      body: { instruction: 'Tampered token test' },
    });
    assertStatus(res, 401, 'Tampered JWT signature must return HTTP 401');
  });

  // Test S1-02: Tampered JWT Signature on WebSocket handshake
  await runTest('S1-02', 'WebSocket: Tampered JWT signature is rejected during handshake (HTTP 401)', async () => {
    const parts = user.accessToken.split('.');
    const tamperedSig = parts[2].substring(0, parts[2].length - 4) + 'ABCD';
    const tamperedToken = `${parts[0]}.${parts[1]}.${tamperedSig}`;

    const res = await apiRequest(`/ws/tasks/${generateUUID()}?token=${tamperedToken}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    assertStatus(res, 401, 'Tampered token handshake must be rejected with HTTP 401');
  });

  // Test S1-03: Algorithm "none" attack on REST
  await runTest('S1-03', 'REST: Algorithm "none" JWT is strictly rejected with HTTP 401', async () => {
    const noneToken = await createSpoofedJwt(
      { alg: 'none', typ: 'JWT' },
      { sub: user.userId, email: user.email, type: 'access', exp: Math.floor(Date.now() / 1000) + 3600 }
    );

    const res = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${noneToken}` },
      body: { instruction: 'Alg none attack test' },
    });
    assertStatus(res, 401, 'Algorithm "none" token must return HTTP 401');
  });

  // Test S1-04: Algorithm "none" attack on WebSocket handshake
  await runTest('S1-04', 'WebSocket: Algorithm "none" JWT is strictly rejected (HTTP 401)', async () => {
    const noneToken = await createSpoofedJwt(
      { alg: 'none', typ: 'JWT' },
      { sub: user.userId, email: user.email, type: 'access', exp: Math.floor(Date.now() / 1000) + 3600 }
    );

    const res = await apiRequest(`/ws/tasks/${generateUUID()}?token=${noneToken}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    assertStatus(res, 401, 'Algorithm "none" handshake must return HTTP 401');
  });

  // Test S1-05: Expired access token on REST
  await runTest('S1-05', 'REST: Expired access token (exp in past) is rejected with HTTP 401', async () => {
    const expiredToken = await createSpoofedJwt(
      { alg: 'HS256', typ: 'JWT' },
      { sub: user.userId, email: user.email, type: 'access', exp: Math.floor(Date.now() / 1000) - 3600 }
    );

    const res = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${expiredToken}` },
      body: { instruction: 'Expired token test' },
    });
    assertStatus(res, 401, 'Expired access token must return HTTP 401');
  });

  // Test S1-06: Expired access token on WebSocket handshake
  await runTest('S1-06', 'WebSocket: Expired access token is rejected during handshake (HTTP 401)', async () => {
    const expiredToken = await createSpoofedJwt(
      { alg: 'HS256', typ: 'JWT' },
      { sub: user.userId, email: user.email, type: 'access', exp: Math.floor(Date.now() / 1000) - 3600 }
    );

    const res = await apiRequest(`/ws/tasks/${generateUUID()}?token=${expiredToken}`, {
      headers: {
        Upgrade: 'websocket',
        Connection: 'Upgrade',
        'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version': '13',
      },
    });
    assertStatus(res, 401, 'Expired token handshake must return HTTP 401');
  });

  // Test S1-07: Token signed with unauthorized / foreign secret key
  await runTest('S1-07', 'REST: JWT signed with foreign secret key is rejected with HTTP 401', async () => {
    const rogueToken = await createSpoofedJwt(
      { alg: 'HS256', typ: 'JWT' },
      { sub: user.userId, email: user.email, type: 'access', exp: Math.floor(Date.now() / 1000) + 3600 },
      'completely-wrong-unauthorized-secret-key-32bytes'
    );

    const res = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${rogueToken}` },
      body: { instruction: 'Rogue secret key test' },
    });
    assertStatus(res, 401, 'Token signed with foreign secret must return HTTP 401');
  });

  // ==========================================================================
  // SECTION 2: In-Flight Cancellation Race Conditions
  // ==========================================================================
  console.log(`\n${colors.yellow}${colors.bold}--- SECTION 2: In-Flight Cancellation Race Conditions ---${colors.reset}`);

  // Test S2-01: In-Flight Cancellation Race at Step 1
  let step1SessionId = null;
  await runTest('S2-01', 'In-Flight Cancel at Step 1: Active WS receives cancelled frame, suppresses later steps', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.accessToken}` },
      body: { instruction: 'Adversarial Race Test: Cancel at Step 1' },
    });
    assertStatus(taskRes, 201);
    step1SessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${step1SessionId}?token=${user.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Await Step 1 log
    const step1Log = await client.waitForMessage(
      (m) => m && m.event === 'log' && m.step_no === 1,
      6000,
      'step 1 log'
    );
    assert(step1Log !== null, 'Step 1 log must be received');

    // Trigger immediate REST cancellation
    const cancelRes = await apiRequest(`/api/tasks/${step1SessionId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    assertStatus(cancelRes, 200);
    assertEqual(cancelRes.body.status, 'cancelled');

    // Verify WebSocket receives cancelled frame
    const cancelFrame = await client.waitForMessage(
      (m) => m && m.event === 'cancelled',
      6000,
      'cancelled event'
    );
    assertEqual(cancelFrame.session_id, step1SessionId);
    assertEqual(cancelFrame.status, 'cancelled');

    // Verify socket terminates cleanly
    const closeEv = await client.waitForClose(5000);
    assertEqual(closeEv.code, 1000, 'WebSocket close code must be 1000');

    // Verify no trailing step 2..5 logs arrived
    const step2Logs = client.messages.filter((m) => m && m.event === 'log' && m.step_no > 1);
    assertEqual(step2Logs.length, 0, 'No trailing steps should be received after step 1 cancellation');
  });

  // Test S2-02: In-Flight Cancellation Race at Step 3
  let step3SessionId = null;
  await runTest('S2-02', 'In-Flight Cancel at Step 3: Cancels cleanly mid-stream, suppresses steps 4 & 5', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.accessToken}` },
      body: { instruction: 'Adversarial Race Test: Cancel at Step 3' },
    });
    assertStatus(taskRes, 201);
    step3SessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${step3SessionId}?token=${user.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Await Step 3 log
    const step3Log = await client.waitForMessage(
      (m) => m && m.event === 'log' && m.step_no === 3,
      8000,
      'step 3 log'
    );
    assert(step3Log !== null, 'Step 3 log must be received');

    // Cancel immediately via REST
    const cancelRes = await apiRequest(`/api/tasks/${step3SessionId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    assertStatus(cancelRes, 200);
    assertEqual(cancelRes.body.status, 'cancelled');

    // Await cancelled frame on WS
    const cancelFrame = await client.waitForMessage(
      (m) => m && m.event === 'cancelled',
      6000,
      'cancelled event'
    );
    assertEqual(cancelFrame.status, 'cancelled');

    await client.waitForClose(5000);

    // Verify no step 4 or 5 logs emitted
    const trailingSteps = client.messages.filter((m) => m && m.event === 'log' && m.step_no >= 4);
    assertEqual(trailingSteps.length, 0, 'Steps 4 and 5 must not be emitted after cancellation at step 3');
  });

  // Test S2-03: In-Flight Cancellation Race at Step 5 (Boundary Condition)
  let step5SessionId = null;
  await runTest('S2-03', 'In-Flight Cancel at Step 5: Resolves deterministically without state corruption', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.accessToken}` },
      body: { instruction: 'Adversarial Race Test: Cancel at Step 5' },
    });
    assertStatus(taskRes, 201);
    step5SessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${step5SessionId}?token=${user.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Wait for Step 5
    await client.waitForMessage((m) => m && m.event === 'log' && m.step_no === 5, 10000, 'step 5 log');

    // Immediately dispatch cancellation
    const cancelRes = await apiRequest(`/api/tasks/${step5SessionId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    assertStatus(cancelRes, 200);
    assert(
      cancelRes.body.status === 'cancelled' || cancelRes.body.status === 'completed',
      'Status must resolve cleanly to cancelled or completed'
    );

    // Wait for socket closure
    await client.waitForClose(5000);

    // Verify D1 state is deterministic
    const statusRes = await apiRequest(`/api/tasks/${step5SessionId}/status`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    assertStatus(statusRes, 200);
    assert(
      statusRes.body.status === 'cancelled' || statusRes.body.status === 'completed',
      'D1 status must remain either cancelled or completed'
    );
  });

  // ==========================================================================
  // SECTION 3: Repeat Cancellation Spamming (Concurrency Bombardment)
  // ==========================================================================
  console.log(`\n${colors.yellow}${colors.bold}--- SECTION 3: Repeat Cancellation Spamming ---${colors.reset}`);

  // Test S3-01: Concurrent POST /cancel flood (20 simultaneous requests on running task)
  await runTest('S3-01', 'Concurrent spam: 20 simultaneous POST /cancel calls on active stream all return HTTP 200', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.accessToken}` },
      body: { instruction: 'Concurrent Cancellation Bombardment (20 requests)' },
    });
    assertStatus(taskRes, 201);
    const floodSessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${floodSessionId}?token=${user.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Wait for step 1
    await client.waitForMessage((m) => m && m.event === 'log', 6000, 'first log');

    // Fire 20 concurrent cancel requests
    const CONCURRENCY = 20;
    const cancelPromises = Array.from({ length: CONCURRENCY }, () =>
      apiRequest(`/api/tasks/${floodSessionId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.accessToken}` },
      })
    );

    const responses = await Promise.all(cancelPromises);

    // Assert every response is HTTP 200 with status: 'cancelled'
    for (let i = 0; i < responses.length; i++) {
      assertStatus(responses[i], 200, `Concurrent cancel call #${i + 1} must return HTTP 200`);
      assertEqual(responses[i].body.status, 'cancelled', `Concurrent cancel call #${i + 1} status must be cancelled`);
    }

    // Await WebSocket cancellation frame
    const cancelledFrame = await client.waitForMessage((m) => m && m.event === 'cancelled', 6000, 'cancelled frame');
    assertEqual(cancelledFrame.status, 'cancelled');

    await client.waitForClose(5000);

    // Verify WebSocket received exactly 1 cancellation frame (no duplicate frame spam)
    const cancelFrames = client.messages.filter((m) => m && m.event === 'cancelled');
    assertEqual(cancelFrames.length, 1, 'WebSocket must receive exactly 1 cancelled event, not duplicated');
  });

  // Test S3-02: Spamming 50 repeated cancellations on already finalized session
  await runTest('S3-02', 'Idempotent spam: 50 repeated POST /cancel calls on finalized session return HTTP 200 safely', async () => {
    const SPAM_COUNT = 50;
    const spamPromises = Array.from({ length: SPAM_COUNT }, () =>
      apiRequest(`/api/tasks/${step1SessionId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${user.accessToken}` },
      })
    );

    const responses = await Promise.all(spamPromises);
    for (let i = 0; i < responses.length; i++) {
      assertStatus(responses[i], 200, `Spam cancel #${i + 1} must return HTTP 200`);
      assertEqual(responses[i].body.status, 'cancelled', `Spam cancel #${i + 1} must report cancelled`);
    }
  });

  // ==========================================================================
  // SECTION 4: In-Band WebSocket Cancellation Frame
  // ==========================================================================
  console.log(`\n${colors.yellow}${colors.bold}--- SECTION 4: In-Band WebSocket Cancellation ---${colors.reset}`);

  // Test S4-01: In-Band {"event": "cancel"} frame
  let inBandSessionId = null;
  await runTest('S4-01', 'In-band WS cancellation: client sends {"event": "cancel"} frame, updates D1 and terminates socket', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${user.accessToken}` },
      body: { instruction: 'In-Band WebSocket Cancellation Frame Test' },
    });
    assertStatus(taskRes, 201);
    inBandSessionId = taskRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${inBandSessionId}?token=${user.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Wait for step 1
    await client.waitForMessage((m) => m && m.event === 'log' && m.step_no === 1, 6000, 'step 1 log');

    // Send in-band cancel frame
    client.send({ event: 'cancel' });

    // Expect cancelled frame
    const cancelFrame = await client.waitForMessage(
      (m) => m && m.event === 'cancelled',
      6000,
      'in-band cancelled event'
    );
    assertEqual(cancelFrame.status, 'cancelled', 'In-band cancel must emit cancelled event');

    // Expect graceful socket close
    const closeEv = await client.waitForClose(5000);
    assertEqual(closeEv.code, 1000, 'WebSocket close code must be 1000');

    // Verify D1 status was persisted as cancelled
    const statusRes = await apiRequest(`/api/tasks/${inBandSessionId}/status`, {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    assertStatus(statusRes, 200);
    assertEqual(statusRes.body.status, 'cancelled', 'D1 status must be cancelled following in-band frame');
  });

  // Test S4-02: Reconnecting WebSocket to in-band cancelled session
  await runTest('S4-02', 'Reconnecting to in-band cancelled session receives terminal cancelled frame and closes (code 1000)', async () => {
    const wsUrl = getWsUrl(`/ws/tasks/${inBandSessionId}?token=${user.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    const terminalFrame = await client.waitForMessage(
      (m) => m && m.event === 'cancelled',
      5000,
      'terminal cancelled frame'
    );
    assertEqual(terminalFrame.status, 'cancelled');

    const closeEv = await client.waitForClose(5000);
    assertEqual(closeEv.code, 1000, 'Must close with code 1000');
  });

  // ==========================================================================
  // SECTION 5: D1 SQLite Database Integrity & Invariant Audit
  // ==========================================================================
  console.log(`\n${colors.yellow}${colors.bold}--- SECTION 5: D1 SQLite Database Integrity & Invariants ---${colors.reset}`);

  // Test S5-01: Integrity check across all test sessions
  await runTest('S5-01', 'D1 Integrity: sessions.step_count matches task_steps count and log sequence is continuous', async () => {
    const sessionIdsToCheck = [step1SessionId, step3SessionId, inBandSessionId].filter(Boolean);

    for (const sid of sessionIdsToCheck) {
      // 1. Fetch summary
      const sumRes = await apiRequest(`/api/tasks/${sid}`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      assertStatus(sumRes, 200, `Summary for session ${sid}`);
      assertEqual(sumRes.body.status, 'cancelled', `Session ${sid} status must be cancelled`);
      assert(sumRes.body.ended_at !== null, `Session ${sid} ended_at must be populated`);

      // 2. Fetch logs
      const logsRes = await apiRequest(`/api/tasks/${sid}/logs`, {
        headers: { Authorization: `Bearer ${user.accessToken}` },
      });
      assertStatus(logsRes, 200, `Logs for session ${sid}`);
      const logs = logsRes.body.logs;

      // Invariant: sessions.step_count must equal total recorded steps in task_steps
      assertEqual(
        sumRes.body.step_count,
        logs.length,
        `Step count invariant: sessions.step_count (${sumRes.body.step_count}) must equal logs length (${logs.length})`
      );

      // Invariant: step numbers must be strictly sequential 1..N
      for (let i = 0; i < logs.length; i++) {
        assertEqual(logs[i].step_no, i + 1, `Step ${i + 1} number must equal index + 1`);
      }
    }
  });

  // Test S5-02: Task history query pagination and ordering integrity
  await runTest('S5-02', 'D1 History: Task list returns all created sessions ordered by started_at DESC', async () => {
    const listRes = await apiRequest('/api/tasks?limit=50', {
      headers: { Authorization: `Bearer ${user.accessToken}` },
    });
    assertStatus(listRes, 200);
    assert(Array.isArray(listRes.body.tasks), 'tasks must be an array');
    assert(listRes.body.total >= 4, 'Total tasks must be >= 4');

    // Verify ordering
    for (let i = 0; i < listRes.body.tasks.length - 1; i++) {
      const t1 = new Date(listRes.body.tasks[i].started_at).getTime();
      const t2 = new Date(listRes.body.tasks[i + 1].started_at).getTime();
      assert(t1 >= t2, 'Tasks must be returned in descending chronological order');
    }
  });

  // ==========================================================================
  // Final Summary & Reporting
  // ==========================================================================
  const total = testResults.length;
  const passed = testResults.filter((t) => t.status === 'PASS').length;
  const failed = testResults.filter((t) => t.status === 'FAIL').length;
  const totalDuration = testResults.reduce((acc, t) => acc + t.duration, 0);

  console.log(`\n${colors.cyan}================================================================${colors.reset}`);
  console.log(`${colors.cyan}             CHALLENGER 2 TEST SUITE SUMMARY                    ${colors.reset}`);
  console.log(`${colors.cyan}================================================================${colors.reset}`);
  console.log(`  Target Server : ${baseUrl}`);
  console.log(`  Total Tests   : ${colors.bold}${total}${colors.reset}`);
  console.log(`  Passed        : ${colors.green}${colors.bold}${passed}${colors.reset}`);
  console.log(`  Failed        : ${failed > 0 ? colors.red : colors.green}${colors.bold}${failed}${colors.reset}`);
  console.log(`  Duration      : ${totalDuration}ms`);

  if (failed === 0) {
    console.log(`\n  ${colors.green}${colors.bold}[VERDICT] ALL ${total} ADVERSARIAL STRESS TESTS PASSED!${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n  ${colors.red}${colors.bold}[VERDICT] ${failed} OF ${total} ADVERSARIAL TESTS FAILED.${colors.reset}\n`);
    process.exit(1);
  }
}

// Execute harness
runAdversarialHarness().catch((fatalErr) => {
  console.error(`\n${colors.red}[FATAL UNHANDLED]${colors.reset}:`, fatalErr);
  process.exit(1);
});
