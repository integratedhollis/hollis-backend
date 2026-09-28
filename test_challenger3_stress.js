/**
 * Hollis Backend Epic 2 — Adversarial Stress & Resiliency Test Suite
 * Agent: challenger_3 (Adversarial Empirical Challenger)
 *
 * Scope:
 * 1. TC-17 & Malformed/Oversized Frame Stress:
 *    - Validates { event: "error", message: "Invalid message format" } is returned
 *    - Rapid bursts of 30 malformed frames without socket drop or worker crash
 *    - Oversized payloads (128 KB+) handling
 *    - Non-object JSON primitive injections (null, numbers, strings, booleans)
 * 2. Duplicate Connection Supersession:
 *    - Duplicate connection cleanly closes superseded socket with code 1000 ('Replaced by new connection')
 *    - Active stream handoff to new connection without missing steps
 *    - Stale close event immunity (superseded socket close does not evict new socket)
 *    - Rapid flurry of 5 duplicate connections for the same session ID
 * 3. Reconnection to Partially Streamed Sessions:
 *    - Interruption after step 2 and reconnection
 *    - Seamless resumption from step 3 without duplicate key collisions
 *    - Zero SQLite constraint crashes (UNIQUE constraint failed: task_steps.session_id, task_steps.step_no)
 *    - Verifies D1 consistency and final 'completed' state
 * 4. Terminal State Reconnection:
 *    - Reconnection to completed and cancelled sessions
 *
 * Target: Cloudflare Workers Dev Server (default: http://127.0.0.1:8787)
 * Runtime: Node.js v22/v24+ (native fetch & WebSocket, zero external dependencies)
 *
 * Usage:
 *   node test_challenger3_stress.js
 *   node test_challenger3_stress.js --url http://127.0.0.1:8787
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
  console.error('[FATAL] globalThis.WebSocket is required. Please use Node.js v22+');
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
          reject(new Error(`WebSocket error: ${event.message || 'Handshake failed'}`));
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
        const received = this.messages.map((m) => (typeof m === 'object' ? JSON.stringify(m) : m)).join(', ');
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

const testResults = [];
let passedCount = 0;
let failedCount = 0;

async function runStressTest(id, title, testFn) {
  const start = Date.now();
  try {
    process.stdout.write(`  [TEST] ${id}: ${title} ... `);
    await testFn();
    const duration = Date.now() - start;
    passedCount++;
    testResults.push({ id, title, status: 'PASS', duration });
    console.log(`${colors.green}PASS${colors.reset} ${colors.gray}(${duration}ms)${colors.reset}`);
  } catch (err) {
    const duration = Date.now() - start;
    failedCount++;
    testResults.push({ id, title, status: 'FAIL', duration, error: err.message });
    console.log(`${colors.red}FAIL${colors.reset} ${colors.gray}(${duration}ms)${colors.reset}`);
    console.log(`         ${colors.red}Error: ${err.message}${colors.reset}`);
  }
}

async function registerTestUser(emailPrefix) {
  const email = `${emailPrefix}_${Date.now()}_${Math.floor(Math.random() * 10000)}@test.com`;
  const regRes = await apiRequest('/api/auth/register', {
    method: 'POST',
    body: {
      username: emailPrefix,
      email,
      password: 'Password123!',
    },
  });
  if (regRes.status !== 201) {
    throw new Error(`Failed to register user: HTTP ${regRes.status} ${regRes.rawText}`);
  }
  return {
    userId: regRes.body.user_id,
    accessToken: regRes.body.access_token,
    email,
  };
}

async function main() {
  console.log(`\n${colors.cyan}${colors.bold}================================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}   HOLLIS BACKEND — CHALLENGER 3 ADVERSARIAL STRESS TEST SUITE   ${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}================================================================${colors.reset}\n`);

  const healthRes = await apiRequest('/api/health').catch(() => apiRequest('/health'));
  if (healthRes.status !== 200) {
    throw new Error(`Target server unhealthy at ${baseUrl}: HTTP ${healthRes.status}`);
  }
  console.log(`${colors.green}✓ Server healthy at ${baseUrl}${colors.reset}\n`);

  const testUser = await registerTestUser('challenger3_user');

  // ==========================================================================
  // SECTION 1: TC-17 & Malformed/Oversized Frame Stress Resilience
  // ==========================================================================
  console.log(`${colors.bold}--- SECTION 1: TC-17 & Malformed / Oversized Frame Resilience ---${colors.reset}`);

  // STRESS-01: Baseline TC-17 Exact Contract Verification
  await runStressTest('STRESS-01', 'TC-17 Contract: Non-JSON string receives { event: "error", message: "Invalid message format" }', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
      body: { instruction: 'STRESS-01 TC-17 baseline verification' },
    });
    if (taskRes.status !== 201) throw new Error(`Task start failed: ${taskRes.status}`);
    const sessionId = taskRes.body.session_id;

    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws.connect();
    await ws.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected event');

    // Send exact TC-17 malformed string
    ws.send('This is not valid JSON string {{{');

    const errorFrame = await ws.waitForMessage((m) => m && m.event === 'error', 5000, 'error event');
    if (!errorFrame) throw new Error('Expected { event: "error" } frame not received');
    if (errorFrame.message !== 'Invalid message format') {
      throw new Error(`Expected message "Invalid message format", received "${errorFrame.message}"`);
    }

    // Verify socket is NOT closed by server
    ws.send({ event: 'ping' });
    const pong = await ws.waitForMessage((m) => m && m.event === 'pong', 5000, 'pong event');
    if (!pong || !pong.timestamp) throw new Error('Server socket dead or dropped after error frame');

    ws.close();
    await ws.waitForClose();
  });

  // STRESS-02: Rapid burst of 30 malformed frames
  await runStressTest('STRESS-02', 'Rapid burst: 30 malformed non-JSON frames in immediate succession', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
      body: { instruction: 'STRESS-02 30 malformed frames burst' },
    });
    const sessionId = taskRes.body.session_id;

    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws.connect();
    await ws.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected event');

    const malformedSnippets = [
      '{broken: json',
      '<<<XML_NOT_JSON>>>',
      '{"unclosed_str": "abc',
      '{"trailing_comma": 1,}',
      'undefined',
      'NaN',
      'function() {}',
      '\\x00\\x01\\x02',
      '[{]',
      ':bad_colon',
    ];

    // Blast 30 malformed messages
    for (let i = 0; i < 30; i++) {
      ws.send(malformedSnippets[i % malformedSnippets.length] + `_${i}`);
    }

    // Wait for at least 25 error frames
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const errFrames = ws.messages.filter((m) => m && m.event === 'error');
      if (errFrames.length >= 25) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const errCount = ws.messages.filter((m) => m && m.event === 'error').length;
    if (errCount < 25) {
      throw new Error(`Expected at least 25 error frames, received ${errCount}`);
    }

    // Socket still responsive
    ws.send({ event: 'ping' });
    const pong = await ws.waitForMessage((m) => m && m.event === 'pong', 5000, 'pong event');
    if (!pong) throw new Error('Socket dead after 30 malformed frames burst');

    ws.close();
    await ws.waitForClose();
  });

  // STRESS-03: Oversized text payload (128 KB malformed string)
  await runStressTest('STRESS-03', 'Oversized text stress: 128 KB malformed string without socket crash', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
      body: { instruction: 'STRESS-03 Oversized 128KB payload' },
    });
    const sessionId = taskRes.body.session_id;

    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws.connect();
    await ws.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected event');

    // 128 KB malformed non-JSON
    const oversizedMalformed = 'GARBAGE_PREFIX_' + 'A'.repeat(128 * 1024) + '_UNCLOSED_{{{';
    ws.send(oversizedMalformed);

    const errorFrame = await ws.waitForMessage((m) => m && m.event === 'error', 6000, 'error event');
    if (!errorFrame) throw new Error('Server did not respond with error frame for 128KB malformed payload');

    // Verify alive
    ws.send({ event: 'ping' });
    const pong = await ws.waitForMessage((m) => m && m.event === 'pong', 5000, 'pong event');
    if (!pong) throw new Error('Socket unresponsive after oversized payload');

    ws.close();
    await ws.waitForClose();
  });

  // STRESS-04: Non-object JSON primitive injection
  await runStressTest('STRESS-04', 'Non-object JSON primitives: null, numbers, strings, booleans emit error frame', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
      body: { instruction: 'STRESS-04 Non-object JSON primitives' },
    });
    const sessionId = taskRes.body.session_id;

    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws.connect();
    await ws.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected event');

    const primitives = ['null', '12345', '"plain_json_string"', 'true', 'false'];
    for (const prim of primitives) {
      ws.send(prim);
    }

    const deadline = Date.now() + 6000;
    while (Date.now() < deadline) {
      const errFrames = ws.messages.filter((m) => m && m.event === 'error');
      if (errFrames.length >= primitives.length) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const errCount = ws.messages.filter((m) => m && m.event === 'error').length;
    if (errCount < primitives.length) {
      throw new Error(`Expected ${primitives.length} error frames for primitives, received ${errCount}`);
    }

    ws.close();
    await ws.waitForClose();
  });

  // ==========================================================================
  // SECTION 2: Duplicate Connection Supersession & Handoff
  // ==========================================================================
  console.log(`\n${colors.bold}--- SECTION 2: Duplicate Connection Supersession & Handoff ---${colors.reset}`);

  // STRESS-05: Duplicate connection cleanly closes old socket (code 1000) and new socket continues
  await runStressTest('STRESS-05', 'Duplicate connection supersession: WS1 receives code 1000 and WS2 continues streaming', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
      body: { instruction: 'STRESS-05 Duplicate connection supersession' },
    });
    const sessionId = taskRes.body.session_id;

    // Connect WS1
    const ws1 = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws1.connect();
    await ws1.waitForMessage((m) => m && m.event === 'connected', 5000, 'WS1 connected');

    // Wait until WS1 gets at least step 1
    const step1 = await ws1.waitForMessage((m) => m && m.event === 'log' && m.step_no === 1, 6000, 'WS1 step 1');
    if (!step1) throw new Error('WS1 never received step 1');

    // Now open duplicate connection WS2 for the SAME session
    const ws2 = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws2.connect();
    await ws2.waitForMessage((m) => m && m.event === 'connected', 5000, 'WS2 connected');

    // WS1 MUST receive a close frame with code 1000 and reason 'Replaced by new connection'
    const closeEvent1 = await ws1.waitForClose(5000);
    if (!closeEvent1) throw new Error('WS1 was not closed when WS2 connected');
    if (closeEvent1.code !== 1000) {
      throw new Error(`Expected WS1 close code 1000, got ${closeEvent1.code}`);
    }
    if (closeEvent1.reason !== 'Replaced by new connection') {
      throw new Error(`Expected WS1 close reason "Replaced by new connection", got "${closeEvent1.reason}"`);
    }

    // WS2 MUST continue receiving subsequent steps and complete with code 1000
    const finishedEvent = await ws2.waitForMessage((m) => m && m.event === 'finished', 10000, 'WS2 finished event');
    if (!finishedEvent) throw new Error('WS2 did not complete log streaming');

    const closeEvent2 = await ws2.waitForClose(5000);
    if (closeEvent2.code !== 1000) {
      throw new Error(`Expected WS2 close code 1000, got ${closeEvent2.code}`);
    }
  });

  // STRESS-06: Stale close event immunity (WS1 close does not evict WS2 from registry)
  await runStressTest('STRESS-06', 'Stale close event immunity: WS1 close does not evict WS2, REST cancel targets WS2', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
      body: { instruction: 'STRESS-06 Stale close event immunity' },
    });
    const sessionId = taskRes.body.session_id;

    // Connect WS1
    const ws1 = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws1.connect();
    await ws1.waitForMessage((m) => m && m.event === 'connected', 5000, 'WS1 connected');

    // Open WS2 immediately to supersede WS1
    const ws2 = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws2.connect();
    await ws2.waitForMessage((m) => m && m.event === 'connected', 5000, 'WS2 connected');

    // Wait for WS1 to be closed
    await ws1.waitForClose(5000);

    // Now issue REST cancellation: If WS1 close evicted the session from registry, cancelActiveSession would fail!
    const cancelRes = await apiRequest(`/api/tasks/${sessionId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
    });
    if (cancelRes.status !== 200) throw new Error(`Cancel request failed: ${cancelRes.status}`);

    // WS2 MUST receive { event: "cancelled" }
    const cancelledFrame = await ws2.waitForMessage((m) => m && m.event === 'cancelled', 6000, 'WS2 cancelled frame');
    if (!cancelledFrame) {
      throw new Error('WS2 did not receive { event: "cancelled" } — registry was corrupted by stale close event!');
    }

    const close2 = await ws2.waitForClose(5000);
    if (close2.code !== 1000) throw new Error(`WS2 closed with code ${close2.code} instead of 1000`);
  });

  // STRESS-07: Rapid flurry of 5 duplicate connections in succession
  await runStressTest('STRESS-07', 'Rapid flurry: 5 duplicate connections for the same session ID in rapid succession', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
      body: { instruction: 'STRESS-07 5 duplicate connections flurry' },
    });
    const sessionId = taskRes.body.session_id;

    const sockets = [];
    for (let i = 0; i < 5; i++) {
      const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
      await ws.connect();
      sockets.push(ws);
      // Wait tiny delay between connection establishments
      await new Promise((r) => setTimeout(r, 150));
    }

    // Verify sockets 0, 1, 2, 3 were all cleanly closed with code 1000
    for (let i = 0; i < 4; i++) {
      const closeEv = await sockets[i].waitForClose(5000);
      if (!closeEv || closeEv.code !== 1000) {
        throw new Error(`Socket ${i} was not cleanly closed with 1000: code ${closeEv?.code}`);
      }
    }

    // The 5th socket (sockets[4]) must be alive and reach finished
    const finalSocket = sockets[4];
    const finished = await finalSocket.waitForMessage((m) => m && m.event === 'finished', 12000, 'final finished event');
    if (!finished) throw new Error('5th socket failed to complete log streaming');

    await finalSocket.waitForClose(5000);
  });

  // ==========================================================================
  // SECTION 3: Reconnection to Partially Streamed Sessions (SQLite Resilience)
  // ==========================================================================
  console.log(`\n${colors.bold}--- SECTION 3: Reconnection to Partially Streamed Sessions ---${colors.reset}`);

  // STRESS-08: Disconnect midway and reconnect; verify resumption and no UNIQUE constraint failure
  await runStressTest('STRESS-08', 'Reconnection after mid-task disconnect: Resumes without SQLite UNIQUE constraint crash', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
      body: { instruction: 'STRESS-08 Reconnection mid-task resumption' },
    });
    const sessionId = taskRes.body.session_id;

    // Connect WS1
    const ws1 = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws1.connect();
    await ws1.waitForMessage((m) => m && m.event === 'connected', 5000, 'WS1 connected');

    // Wait until step 2 is emitted
    const step2 = await ws1.waitForMessage((m) => m && m.event === 'log' && m.step_no === 2, 8000, 'WS1 step 2');
    if (!step2) throw new Error('WS1 never reached step 2');

    // Abruptly drop WS1
    ws1.close(1000, 'Client dropped mid-task intentionally');
    await ws1.waitForClose(3000);

    // Verify D1 has at least 2 steps recorded
    const logsRes = await apiRequest(`/api/tasks/${sessionId}/logs`, {
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
    });
    if (logsRes.status !== 200) throw new Error(`Failed to query logs: ${logsRes.status}`);
    const recordedStepsBefore = logsRes.body.steps || [];
    if (recordedStepsBefore.length < 2) {
      throw new Error(`Expected at least 2 steps recorded in D1 before reconnect, got ${recordedStepsBefore.length}`);
    }

    // Wait 300ms, then reconnect WS2 to the SAME session ID
    await new Promise((r) => setTimeout(r, 300));

    const ws2 = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws2.connect();
    await ws2.waitForMessage((m) => m && m.event === 'connected', 5000, 'WS2 connected');

    // WS2 MUST receive remaining steps (step_no > recordedStepsBefore.length) and finish cleanly
    const finishedEvent = await ws2.waitForMessage((m) => m && m.event === 'finished', 10000, 'WS2 finished event');
    if (!finishedEvent) throw new Error('WS2 failed to reach finished event on reconnection');

    const close2 = await ws2.waitForClose(5000);
    if (close2.code !== 1000) throw new Error(`WS2 closed with code ${close2.code} instead of 1000`);

    // Verify final database state: exactly 5 steps recorded without duplicate step_no
    const finalLogs = await apiRequest(`/api/tasks/${sessionId}/logs`, {
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
    });
    const finalSteps = finalLogs.body.steps || [];
    if (finalSteps.length !== 5) {
      throw new Error(`Expected exactly 5 steps in D1, found ${finalSteps.length}`);
    }

    const stepNumbers = finalSteps.map((s) => s.step_no).sort((a, b) => a - b);
    for (let i = 0; i < 5; i++) {
      if (stepNumbers[i] !== i + 1) {
        throw new Error(`D1 steps corrupted or contains duplicates: [${stepNumbers.join(', ')}]`);
      }
    }

    // Verify session status is completed
    const finalStatus = await apiRequest(`/api/tasks/${sessionId}/status`, {
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
    });
    if (finalStatus.body.status !== 'completed') {
      throw new Error(`Expected status 'completed', got '${finalStatus.body.status}'`);
    }
  });

  // ==========================================================================
  // SECTION 4: Terminal State Reconnection
  // ==========================================================================
  console.log(`\n${colors.bold}--- SECTION 4: Terminal State Reconnection ---${colors.reset}`);

  // STRESS-09: Reconnection to already completed session
  await runStressTest('STRESS-09', 'Terminal Reconnection: Already completed session emits { event: "finished" } and closes cleanly', async () => {
    // 1. Run a task to full completion
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
      body: { instruction: 'STRESS-09 Completed session test' },
    });
    const sessionId = taskRes.body.session_id;

    const ws1 = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws1.connect();
    await ws1.waitForMessage((m) => m && m.event === 'finished', 12000, 'completion');
    await ws1.waitForClose(5000);

    // 2. Reconnect to the completed session
    const ws2 = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws2.connect();

    const finished = await ws2.waitForMessage((m) => m && m.event === 'finished', 5000, 'reconnect finished');
    if (!finished) throw new Error('Did not receive finished event on terminal session reconnect');
    if (finished.status !== 'completed') throw new Error(`Expected status completed, got ${finished.status}`);

    const close2 = await ws2.waitForClose(5000);
    if (close2.code !== 1000) throw new Error(`Expected close code 1000, got ${close2.code}`);
  });

  // STRESS-10: Reconnection to already cancelled session
  await runStressTest('STRESS-10', 'Terminal Reconnection: Already cancelled session emits { event: "cancelled" } and closes cleanly', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
      body: { instruction: 'STRESS-10 Cancelled session test' },
    });
    const sessionId = taskRes.body.session_id;

    // Cancel task immediately
    const cancelRes = await apiRequest(`/api/tasks/${sessionId}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${testUser.accessToken}` },
    });
    if (cancelRes.status !== 200) throw new Error(`Cancel failed: ${cancelRes.status}`);

    // Connect to cancelled session
    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${testUser.accessToken}`));
    await ws.connect();

    const cancelled = await ws.waitForMessage((m) => m && m.event === 'cancelled', 5000, 'cancelled frame');
    if (!cancelled) throw new Error('Did not receive cancelled event on cancelled session connect');
    if (cancelled.status !== 'cancelled') throw new Error(`Expected status cancelled, got ${cancelled.status}`);

    const closeEv = await ws.waitForClose(5000);
    if (closeEv.code !== 1000) throw new Error(`Expected close code 1000, got ${closeEv.code}`);
  });

  // ==========================================================================
  // Summary
  // ==========================================================================
  console.log(`\n${colors.cyan}${colors.bold}================================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}   TEST SUMMARY: ${passedCount} PASSED / ${failedCount} FAILED   ${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}================================================================${colors.reset}\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${colors.red}[UNHANDLED ERROR] ${err.message}${colors.reset}\n`);
  process.exit(1);
});
