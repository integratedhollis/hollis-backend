/**
 * Hollis Backend Epic 2 — Challenger 4 Adversarial Verification Harness
 * Focus: Cancellation Concurrency, Atomic Status Updates, and Database Integrity
 *
 * Target: Cloudflare Workers Local Dev Server (default: http://127.0.0.1:8787)
 * Runtime: Node.js v22/v24+ (native fetch & native WebSocket, zero external dependencies)
 *
 * Test Scenarios:
 * 1. Concurrency Race: REST Cancel vs Task Completion (WHERE status = 'running' guard)
 * 2. Concurrency Race: In-Band WS Cancel vs Task Completion
 * 3. Concurrent Cancel Flood: 25 simultaneous REST cancels (HTTP 200 + Code 1000 closure)
 * 4. Idempotent Repeated Cancels: 25 repeated cancels on finalized session
 * 5. Clean Code 1000 Socket Closure Verification across all cancellation scenarios
 * 6. Database Integrity Audit: sessions status, step_count invariants, no phantom steps
 * 7. Cross-Tenant Cancellation Isolation: User B cannot cancel User A's session (HTTP 404)
 *
 * Usage:
 *   node test_challenger4_concurrency.js
 *   node test_challenger4_concurrency.js --url http://127.0.0.1:8787
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

const NativeWebSocket = globalThis.WebSocket;
if (!NativeWebSocket) {
  console.error('[ENVIRONMENT ERROR] globalThis.WebSocket is required (Node.js v22+).');
  process.exit(1);
}

const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
};

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

async function apiRequest(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = {
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  let body = options.body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const start = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body,
      signal: AbortSignal.timeout(options.timeout || 10000),
    });
  } catch (err) {
    throw new Error(`HTTP ${options.method || 'GET'} ${url} failed after ${Date.now() - start}ms: ${err.message}`);
  }

  const rawText = await response.text();
  let jsonBody = null;
  try {
    jsonBody = JSON.parse(rawText);
  } catch (_) {}

  return {
    status: response.status,
    headers: response.headers,
    body: jsonBody,
    rawText,
    durationMs: Date.now() - start,
  };
}

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
          reject(new Error(`WebSocket connect timeout (${timeoutMs}ms)`));
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
        try { data = JSON.parse(event.data); } catch (_) {}
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
          reject(new Error(`WebSocket closed before open: code ${event.code}`));
        }
      };

      this.ws.onerror = (event) => {
        this.errorEvents.push(event);
        this._notifyWaiters();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket error before open`));
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

  async waitForMessage(predicate, timeoutMs = 8000, description = 'frame') {
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
      throw new Error(`WebSocket not open (readyState ${this.ws?.readyState})`);
    }
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.ws.send(payload);
  }

  close(code = 1000, reason = 'Normal closure') {
    try {
      if (this.ws) this.ws.close(code, reason);
    } catch (_) {}
  }
}

const testResults = [];
let passedCount = 0;
let failedCount = 0;

async function runTest(id, description, testFn) {
  const start = Date.now();
  process.stdout.write(`  [${id}] ${description} ... `);
  try {
    await testFn();
    const duration = Date.now() - start;
    passedCount++;
    testResults.push({ id, description, status: 'PASS', duration });
    console.log(`${colors.green}${colors.bold}PASS${colors.reset} ${colors.gray}(${duration}ms)${colors.reset}`);
  } catch (err) {
    const duration = Date.now() - start;
    failedCount++;
    testResults.push({ id, description, status: 'FAIL', duration, error: err });
    console.log(`${colors.red}${colors.bold}FAIL${colors.reset} ${colors.gray}(${duration}ms)${colors.reset}`);
    console.log(`    ${colors.red}${err.message}${colors.reset}`);
  }
}

async function runChallenger4Suite() {
  console.log(`\n${colors.magenta}${colors.bold}================================================================${colors.reset}`);
  console.log(`${colors.magenta}${colors.bold}   CHALLENGER 4: CONCURRENCY, ATOMICITY & INTEGRITY HARNESS     ${colors.reset}`);
  console.log(`${colors.magenta}${colors.bold}================================================================${colors.reset}`);
  console.log(`  Target Base URL: ${colors.bold}${baseUrl}${colors.reset}\n`);

  // Preflight health check
  try {
    const health = await apiRequest('/health');
    if (health.status !== 200) throw new Error(`Health status ${health.status}`);
    console.log(`  ${colors.green}[PREFLIGHT OK] Hollis server healthy${colors.reset}\n`);
  } catch (err) {
    console.error(`  ${colors.red}[PREFLIGHT FAILED] Cannot reach ${baseUrl}: ${err.message}${colors.reset}`);
    process.exit(1);
  }

  // Provision User A & User B
  const runId = generateUUID().slice(0, 8);
  const userA = {
    username: `c4_user_a_${runId}`,
    email: `c4_a_${runId}@hollis.local`,
    password: `C4Password123!_${runId}`,
    userId: null,
    accessToken: null,
  };
  const userB = {
    username: `c4_user_b_${runId}`,
    email: `c4_b_${runId}@hollis.local`,
    password: `C4Password123!_${runId}`,
    userId: null,
    accessToken: null,
  };

  const regA = await apiRequest('/api/auth/register', {
    method: 'POST',
    body: { username: userA.username, email: userA.email, password: userA.password },
  });
  if (regA.status !== 201) throw new Error(`User A registration failed: ${regA.status}`);
  userA.userId = regA.body.user_id;
  userA.accessToken = regA.body.access_token;

  const regB = await apiRequest('/api/auth/register', {
    method: 'POST',
    body: { username: userB.username, email: userB.email, password: userB.password },
  });
  if (regB.status !== 201) throw new Error(`User B registration failed: ${regB.status}`);
  userB.userId = regB.body.user_id;
  userB.accessToken = regB.body.access_token;

  console.log(`  ${colors.cyan}[AUTH SETUP] Provisioned User A (${userA.userId}) and User B (${userB.userId})${colors.reset}\n`);

  // --------------------------------------------------------------------------
  // TEST 1: Concurrency Race: REST Cancel vs Task Completion
  // --------------------------------------------------------------------------
  console.log(`${colors.yellow}${colors.bold}--- SECTION 1: Cancellation vs Completion Concurrency ---${colors.reset}`);

  let restCancelledSessionId = null;
  await runTest('C4-01', 'REST Cancel vs Completion: status cannot be overwritten to completed (WHERE status = "running")', async () => {
    const startRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
      body: { instruction: 'Concurrency Test: REST cancel vs completion race' },
    });
    if (startRes.status !== 201) throw new Error(`Task start failed: ${startRes.status}`);
    restCancelledSessionId = startRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${restCancelledSessionId}?token=${userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    // Await connected and step 1
    await client.waitForMessage(m => m && m.event === 'connected', 5000);
    await client.waitForMessage(m => m && m.event === 'log' && m.step_no === 1, 6000);

    // Cancel in-flight via REST
    const cancelRes = await apiRequest(`/api/tasks/${restCancelledSessionId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    if (cancelRes.status !== 200) throw new Error(`Cancel failed: ${cancelRes.status}`);
    if (cancelRes.body.status !== 'cancelled') throw new Error(`Expected status cancelled, got ${cancelRes.body.status}`);

    // WS receives cancelled frame
    const cancelFrame = await client.waitForMessage(m => m && m.event === 'cancelled', 6000);
    if (!cancelFrame || cancelFrame.status !== 'cancelled') throw new Error('Did not receive cancelled frame');

    // Clean close with code 1000
    const closeEv = await client.waitForClose(5000);
    if (closeEv.code !== 1000) throw new Error(`Expected close code 1000, got ${closeEv.code}`);

    // Wait 3 seconds to ensure background completion loop has finished
    await new Promise(r => setTimeout(r, 3000));

    // Verify D1 status remains cancelled and was NOT overwritten by completion
    const statusRes = await apiRequest(`/api/tasks/${restCancelledSessionId}/status`, {
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    if (statusRes.status !== 200) throw new Error(`Status query failed: ${statusRes.status}`);
    if (statusRes.body.status !== 'cancelled') {
      throw new Error(`CRITICAL ATOMICITY BUG: Task status was overwritten from cancelled to ${statusRes.body.status}!`);
    }

    // Verify no finished frame was received on client
    const hasFinished = client.messages.some(m => m && m.event === 'finished');
    if (hasFinished) throw new Error('CRITICAL: WebSocket received finished frame after cancellation!');
  });

  // --------------------------------------------------------------------------
  // TEST 2: Concurrency Race: In-Band WS Cancel vs Task Completion
  // --------------------------------------------------------------------------
  let inBandSessionId = null;
  await runTest('C4-02', 'In-Band WS Cancel vs Completion: status cannot be overwritten by concurrent completion', async () => {
    const startRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
      body: { instruction: 'Concurrency Test: In-band cancel vs completion' },
    });
    if (startRes.status !== 201) throw new Error(`Task start failed: ${startRes.status}`);
    inBandSessionId = startRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${inBandSessionId}?token=${userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    await client.waitForMessage(m => m && m.event === 'log' && m.step_no === 1, 6000);

    // Send in-band cancel frame
    client.send({ event: 'cancel' });

    // WS receives cancelled frame
    const cancelFrame = await client.waitForMessage(m => m && m.event === 'cancelled', 6000);
    if (!cancelFrame || cancelFrame.status !== 'cancelled') throw new Error('Did not receive cancelled frame');

    // Clean close with code 1000
    const closeEv = await client.waitForClose(5000);
    if (closeEv.code !== 1000) throw new Error(`Expected close code 1000, got ${closeEv.code}`);

    // Wait 3 seconds to let any background task settle
    await new Promise(r => setTimeout(r, 3000));

    // Verify D1 status remains cancelled
    const statusRes = await apiRequest(`/api/tasks/${inBandSessionId}/status`, {
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    if (statusRes.status !== 200) throw new Error(`Status query failed: ${statusRes.status}`);
    if (statusRes.body.status !== 'cancelled') {
      throw new Error(`CRITICAL ATOMICITY BUG: In-band cancelled session overwritten to ${statusRes.body.status}!`);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 3: Concurrent Cancel Flood (25 simultaneous requests)
  // --------------------------------------------------------------------------
  console.log(`\n${colors.yellow}${colors.bold}--- SECTION 2: Concurrent Cancel Bombardment & Idempotency ---${colors.reset}`);

  let floodSessionId = null;
  await runTest('C4-03', 'Concurrent Cancel Flood: 25 simultaneous REST cancels all return HTTP 200 with status: cancelled', async () => {
    const startRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
      body: { instruction: 'Concurrent Cancel Flood 25 Requests' },
    });
    if (startRes.status !== 201) throw new Error(`Task start failed: ${startRes.status}`);
    floodSessionId = startRes.body.session_id;

    const wsUrl = getWsUrl(`/ws/tasks/${floodSessionId}?token=${userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    await client.waitForMessage(m => m && m.event === 'log', 6000);

    // Fire 25 concurrent POST /cancel requests
    const FLOOD_COUNT = 25;
    const cancelPromises = Array.from({ length: FLOOD_COUNT }, () =>
      apiRequest(`/api/tasks/${floodSessionId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userA.accessToken}` },
      })
    );

    const responses = await Promise.all(cancelPromises);

    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      if (res.status !== 200) {
        throw new Error(`Concurrent cancel #${i + 1} failed with status ${res.status}: ${res.rawText}`);
      }
      if (res.body?.status !== 'cancelled') {
        throw new Error(`Concurrent cancel #${i + 1} returned status ${res.body?.status}`);
      }
    }

    // Await WS cancellation frame
    const cancelFrame = await client.waitForMessage(m => m && m.event === 'cancelled', 6000);
    if (!cancelFrame) throw new Error('Did not receive cancelled frame');

    // Clean close with code 1000
    const closeEv = await client.waitForClose(5000);
    if (closeEv.code !== 1000) throw new Error(`Expected close code 1000, got ${closeEv.code}`);

    // Verify exactly 1 cancelled event was emitted on the wire (no duplicate spam)
    const cancelFrames = client.messages.filter(m => m && m.event === 'cancelled');
    if (cancelFrames.length !== 1) {
      throw new Error(`Expected exactly 1 cancel frame, received ${cancelFrames.length}`);
    }
  });

  // --------------------------------------------------------------------------
  // TEST 4: Idempotent Repeated Cancels on Finalized Session
  // --------------------------------------------------------------------------
  await runTest('C4-04', 'Idempotent Repeated Cancels: 25 sequential/concurrent cancels on finalized session return HTTP 200', async () => {
    const REPEAT_COUNT = 25;
    const repeatPromises = Array.from({ length: REPEAT_COUNT }, () =>
      apiRequest(`/api/tasks/${floodSessionId}/cancel`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userA.accessToken}` },
      })
    );

    const responses = await Promise.all(repeatPromises);
    for (let i = 0; i < responses.length; i++) {
      const res = responses[i];
      if (res.status !== 200) {
        throw new Error(`Repeated cancel #${i + 1} failed: status ${res.status}`);
      }
      if (res.body?.status !== 'cancelled') {
        throw new Error(`Repeated cancel #${i + 1} returned unexpected status: ${res.body?.status}`);
      }
    }
  });

  // --------------------------------------------------------------------------
  // TEST 5: Clean Code 1000 Socket Closure Verification
  // --------------------------------------------------------------------------
  console.log(`\n${colors.yellow}${colors.bold}--- SECTION 3: Socket Closure Code & Terminal Handshake ---${colors.reset}`);

  await runTest('C4-05', 'Terminal Reconnection: Connecting to cancelled session receives terminal frame and closes code 1000', async () => {
    const wsUrl = getWsUrl(`/ws/tasks/${floodSessionId}?token=${userA.accessToken}`);
    const client = new WsClient(wsUrl);
    await client.connect();

    const frame = await client.waitForMessage(m => m && m.event === 'cancelled', 5000);
    if (!frame || frame.status !== 'cancelled') throw new Error('Expected terminal cancelled frame');

    const closeEv = await client.waitForClose(5000);
    if (closeEv.code !== 1000) throw new Error(`Expected close code 1000, got ${closeEv.code}`);
  });

  // --------------------------------------------------------------------------
  // TEST 6: D1 Database Integrity & Invariant Audit
  // --------------------------------------------------------------------------
  console.log(`\n${colors.yellow}${colors.bold}--- SECTION 4: Database Integrity & Invariants ---${colors.reset}`);

  await runTest('C4-06', 'D1 Integrity: sessions and task_steps invariants (status, step_count continuity, ended_at)', async () => {
    const sessionsToCheck = [restCancelledSessionId, inBandSessionId, floodSessionId].filter(Boolean);

    for (const sid of sessionsToCheck) {
      // 1. Check summary
      const sumRes = await apiRequest(`/api/tasks/${sid}`, {
        headers: { Authorization: `Bearer ${userA.accessToken}` },
      });
      if (sumRes.status !== 200) throw new Error(`Failed to fetch summary for ${sid}`);
      const summary = sumRes.body;

      if (summary.status !== 'cancelled') throw new Error(`Expected status cancelled for ${sid}, got ${summary.status}`);
      if (!summary.ended_at) throw new Error(`ended_at is missing for cancelled session ${sid}`);

      const startTime = new Date(summary.started_at).getTime();
      const endTime = new Date(summary.ended_at).getTime();
      if (endTime < startTime) throw new Error(`ended_at (${summary.ended_at}) is earlier than started_at (${summary.started_at})`);

      // 2. Check logs replay
      const logsRes = await apiRequest(`/api/tasks/${sid}/logs`, {
        headers: { Authorization: `Bearer ${userA.accessToken}` },
      });
      if (logsRes.status !== 200) throw new Error(`Failed to fetch logs for ${sid}`);
      const logs = logsRes.body.logs;

      // Invariant: sessions.step_count must match task_steps count
      if (summary.step_count !== logs.length) {
        throw new Error(`Invariant mismatch: sessions.step_count (${summary.step_count}) !== logs.length (${logs.length}) for ${sid}`);
      }

      // Invariant: step numbers must be continuous 1..N
      for (let i = 0; i < logs.length; i++) {
        if (logs[i].step_no !== i + 1) {
          throw new Error(`Discontinuous step number: index ${i} has step_no ${logs[i].step_no} for ${sid}`);
        }
      }
    }
  });

  // --------------------------------------------------------------------------
  // TEST 7: Cross-Tenant Cancellation Isolation
  // --------------------------------------------------------------------------
  console.log(`\n${colors.yellow}${colors.bold}--- SECTION 5: Multi-Tenant Cancellation Isolation ---${colors.reset}`);

  await runTest('C4-07', 'Tenant Isolation: User B cancelling User A session returns HTTP 404; User A session unaffected', async () => {
    // Start task for User A
    const startRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
      body: { instruction: 'Tenant Isolation Cancellation Check' },
    });
    if (startRes.status !== 201) throw new Error(`Task start failed: ${startRes.status}`);
    const isolatedSessionId = startRes.body.session_id;

    // Connect User A WebSocket
    const wsUrl = getWsUrl(`/ws/tasks/${isolatedSessionId}?token=${userA.accessToken}`);
    const clientA = new WsClient(wsUrl);
    await clientA.connect();
    await clientA.waitForMessage(m => m && m.event === 'log' && m.step_no === 1, 6000);

    // User B attempts to cancel User A's session
    const rogueCancel = await apiRequest(`/api/tasks/${isolatedSessionId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userB.accessToken}` },
    });
    if (rogueCancel.status !== 404) {
      throw new Error(`SECURITY VULNERABILITY: User B cancel returned HTTP ${rogueCancel.status}, expected 404`);
    }

    // User A's stream must NOT receive any cancellation frame and must continue
    const cancelReceived = clientA.messages.some(m => m && m.event === 'cancelled');
    if (cancelReceived) {
      throw new Error('SECURITY VULNERABILITY: User A stream received cancellation triggered by User B!');
    }

    // Clean up
    clientA.close();
    await clientA.waitForClose();
  });

  // --------------------------------------------------------------------------
  // Summary
  // --------------------------------------------------------------------------
  const totalDuration = testResults.reduce((acc, t) => acc + t.duration, 0);

  console.log(`\n${colors.cyan}================================================================${colors.reset}`);
  console.log(`${colors.cyan}             CHALLENGER 4 TEST SUITE SUMMARY                    ${colors.reset}`);
  console.log(`${colors.cyan}================================================================${colors.reset}`);
  console.log(`  Target Server : ${baseUrl}`);
  console.log(`  Total Tests   : ${colors.bold}${testResults.length}${colors.reset}`);
  console.log(`  Passed        : ${colors.green}${colors.bold}${passedCount}${colors.reset}`);
  console.log(`  Failed        : ${failedCount > 0 ? colors.red : colors.green}${colors.bold}${failedCount}${colors.reset}`);
  console.log(`  Duration      : ${totalDuration}ms`);

  if (failedCount === 0) {
    console.log(`\n  ${colors.green}${colors.bold}[VERDICT] ALL CHALLENGER 4 ADVERSARIAL TESTS PASSED SUCCESSFULLY!${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n  ${colors.red}${colors.bold}[VERDICT] ${failedCount} CHALLENGER 4 ADVERSARIAL TESTS FAILED.${colors.reset}\n`);
    process.exit(1);
  }
}

runChallenger4Suite().catch(err => {
  console.error(`\n${colors.red}[FATAL ERROR]:${colors.reset}`, err);
  process.exit(1);
});
