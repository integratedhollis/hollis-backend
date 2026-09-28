/**
 * Hollis Backend Epic 2 — Adversarial & Stress Testing Suite
 * ระบบแชทหลัก (Chat & Real-time Communication System)
 *
 * Target: Cloudflare Workers Local Dev Server (default: http://127.0.0.1:8787)
 * Runtime: Node.js v22/v24+ (native fetch & native WebSocket, zero external dependencies)
 *
 * Adversarial Test Dimensions:
 * 1. Rapid Open/Close Socket Cycles (Stress testing connection churn and abort handling)
 * 2. Malformed Frame Injection (Garbage binary, oversized JSON, unexpected event types, malformed text)
 * 3. Rapid Ping/Pong Flooding (Keepalive stress under high frame frequency)
 * 4. Parallel Multi-Session Isolation (Concurrent streaming, zero cross-talk, isolated cancellations)
 *
 * Usage:
 *   node test_adversarial_epic2.js
 *   node test_adversarial_epic2.js --url http://127.0.0.1:8787
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
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
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
          reject(new Error(`WebSocket closed before open: code ${event.code}`));
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
        reject(new Error(`Timeout waiting for close event after ${timeoutMs}ms`));
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
      throw new Error(`Cannot send: WebSocket readyState is ${this.ws ? this.ws.readyState : 'null'}`);
    }
    const payload = typeof data === 'string' ? data : JSON.stringify(data);
    this.ws.send(payload);
  }

  sendBinary(buffer) {
    if (!this.ws || this.ws.readyState !== 1) {
      throw new Error(`Cannot send binary: readyState ${this.ws ? this.ws.readyState : 'null'}`);
    }
    this.ws.send(buffer);
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

async function runAdvTest(id, title, testFn) {
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

async function runAdversarialSuite() {
  console.log(`\n${colors.cyan}${colors.bold}================================================================${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}   HOLLIS BACKEND — EPIC 2 ADVERSARIAL & STRESS TEST SUITE      ${colors.reset}`);
  console.log(`${colors.cyan}${colors.bold}================================================================${colors.reset}\n`);

  // Health pre-check
  const healthRes = await apiRequest('/health');
  if (healthRes.status !== 200) {
    throw new Error(`Dev server unhealthy at ${baseUrl}: HTTP ${healthRes.status}`);
  }
  console.log(`${colors.green}✓ Server healthy at ${baseUrl}${colors.reset}\n`);

  const userA = await registerTestUser('adv_user_a');
  const userB = await registerTestUser('adv_user_b');

  // ==========================================================================
  // SECTION 1: Rapid Open / Close Socket Churn
  // ==========================================================================
  console.log(`${colors.bold}--- SECTION 1: Rapid Open / Close Socket Churn ---${colors.reset}`);

  await runAdvTest('ADV-01', 'Immediate socket abort upon connection open (10 rapid cycles)', async () => {
    for (let i = 0; i < 10; i++) {
      const taskRes = await apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${userA.accessToken}` },
        body: { instruction: `Rapid abort cycle ${i}` },
      });
      if (taskRes.status !== 201) throw new Error(`Task start failed: ${taskRes.status}`);
      const sessionId = taskRes.body.session_id;

      const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${userA.accessToken}`));
      await ws.connect();
      // Immediately close without waiting for frames
      ws.close(1000, 'Immediate abort');
      await ws.waitForClose(3000);
    }
  });

  await runAdvTest('ADV-02', 'Rapid socket abort midway through stream reception', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
      body: { instruction: 'Midway abort test' },
    });
    const sessionId = taskRes.body.session_id;

    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${userA.accessToken}`));
    await ws.connect();
    // Wait for step 1
    await ws.waitForMessage((m) => m && m.event === 'log' && m.step_no === 1, 5000, 'step 1');
    // Abort socket abruptly with abnormal close or normal close
    ws.close(1000, 'Client aborted after step 1');
    await ws.waitForClose(3000);

    // Sleep 1s to allow background worker to settle
    await new Promise((r) => setTimeout(r, 1000));

    // Verify server remains responsive and status is queryable
    const statusRes = await apiRequest(`/api/tasks/${sessionId}/status`, {
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    if (statusRes.status !== 200) {
      throw new Error(`Server returned ${statusRes.status} after socket abort`);
    }
  });

  // ==========================================================================
  // SECTION 2: Malformed Frame Injection & Fuzzing
  // ==========================================================================
  console.log(`\n${colors.bold}--- SECTION 2: Malformed Frame Injection & Fuzzing ---${colors.reset}`);

  await runAdvTest('ADV-03', 'Injection: Non-JSON raw strings and syntax errors', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
      body: { instruction: 'Malformed string injection' },
    });
    const sessionId = taskRes.body.session_id;

    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${userA.accessToken}`));
    await ws.connect();
    await ws.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected');

    // Send malformed non-JSON
    ws.send('<<<BAD_SYNTAX_NON_JSON>>>');
    ws.send('{unquoted_key: 123}');
    ws.send('{"truncated": ');

    // Send ping to verify socket loop is still processing frames
    ws.send({ event: 'ping' });
    const pong = await ws.waitForMessage((m) => m && m.event === 'pong', 5000, 'pong');
    if (!pong || !pong.timestamp) {
      throw new Error('Server socket loop dead after non-JSON frames');
    }

    ws.close();
    await ws.waitForClose();
  });

  await runAdvTest('ADV-04', 'Injection: Garbage binary frames and non-UTF8 buffers', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
      body: { instruction: 'Garbage binary injection' },
    });
    const sessionId = taskRes.body.session_id;

    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${userA.accessToken}`));
    await ws.connect();
    await ws.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected');

    // Send arbitrary binary bytes
    const binaryGarbage = new Uint8Array([0x00, 0xff, 0xfe, 0xfd, 0x80, 0x7f, 0xaa, 0xbb]);
    ws.sendBinary(binaryGarbage);

    // Verify server did not crash and responds to ping
    ws.send({ event: 'ping' });
    const pong = await ws.waitForMessage((m) => m && m.event === 'pong', 5000, 'pong');
    if (!pong) throw new Error('Server failed to respond after binary garbage injection');

    ws.close();
    await ws.waitForClose();
  });

  await runAdvTest('ADV-05', 'Injection: Oversized JSON payload (128 KB)', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
      body: { instruction: 'Oversized JSON payload' },
    });
    const sessionId = taskRes.body.session_id;

    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${userA.accessToken}`));
    await ws.connect();
    await ws.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected');

    // 128KB payload of repeated data
    const largeStr = 'X'.repeat(128 * 1024);
    ws.send({ event: 'custom_large', payload: largeStr });

    // Verify server remains responsive
    ws.send({ event: 'ping' });
    const pong = await ws.waitForMessage((m) => m && m.event === 'pong', 5000, 'pong');
    if (!pong) throw new Error('Server unresponsive after 128KB payload');

    ws.close();
    await ws.waitForClose();
  });

  await runAdvTest('ADV-06', 'Injection: Unexpected event types and schema violations', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
      body: { instruction: 'Schema violations' },
    });
    const sessionId = taskRes.body.session_id;

    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${userA.accessToken}`));
    await ws.connect();
    await ws.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected');

    ws.send({ event: 'UNKNOWN_OPCODE', timestamp: -1 });
    ws.send({ event: 99999 });
    ws.send({ event: null });
    ws.send({ event: {} });
    ws.send([]);
    ws.send(12345);

    // Verify stream continues normally
    const log = await ws.waitForMessage((m) => m && m.event === 'log', 6000, 'log frame');
    if (!log) throw new Error('Streaming halted after unexpected event frames');

    ws.close();
    await ws.waitForClose();
  });

  // ==========================================================================
  // SECTION 3: Rapid Ping / Pong Flooding
  // ==========================================================================
  console.log(`\n${colors.bold}--- SECTION 3: Rapid Ping / Pong Flooding ---${colors.reset}`);

  await runAdvTest('ADV-07', 'Flood: 50 rapid ping messages sent in immediate burst', async () => {
    const taskRes = await apiRequest('/api/tasks/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
      body: { instruction: 'Ping flood test' },
    });
    const sessionId = taskRes.body.session_id;

    const ws = new WsClient(getWsUrl(`/ws/tasks/${sessionId}?token=${userA.accessToken}`));
    await ws.connect();
    await ws.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected');

    const PING_COUNT = 50;
    for (let i = 0; i < PING_COUNT; i++) {
      ws.send({ event: 'ping', seq: i });
    }

    // Wait for at least 40 pong responses
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const pongs = ws.messages.filter((m) => m && m.event === 'pong');
      if (pongs.length >= PING_COUNT) break;
      await new Promise((r) => setTimeout(r, 100));
    }

    const totalPongs = ws.messages.filter((m) => m && m.event === 'pong').length;
    if (totalPongs < PING_COUNT) {
      throw new Error(`Expected ${PING_COUNT} pongs, received ${totalPongs}`);
    }

    ws.close();
    await ws.waitForClose();
  });

  // ==========================================================================
  // SECTION 4: Parallel Multi-Session Isolation & Zero Cross-Talk
  // ==========================================================================
  console.log(`\n${colors.bold}--- SECTION 4: Parallel Multi-Session Isolation & Zero Cross-Talk ---${colors.reset}`);

  await runAdvTest('ADV-08', 'Parallel: 4 concurrent sessions across 2 users with zero cross-talk', async () => {
    // Start 2 tasks for User A, 2 tasks for User B
    const [tA1, tA2, tB1, tB2] = await Promise.all([
      apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${userA.accessToken}` },
        body: { instruction: 'User A Task 1' },
      }),
      apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${userA.accessToken}` },
        body: { instruction: 'User A Task 2' },
      }),
      apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${userB.accessToken}` },
        body: { instruction: 'User B Task 1' },
      }),
      apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { Authorization: `Bearer ${userB.accessToken}` },
        body: { instruction: 'User B Task 2' },
      }),
    ]);

    const sA1 = tA1.body.session_id;
    const sA2 = tA2.body.session_id;
    const sB1 = tB1.body.session_id;
    const sB2 = tB2.body.session_id;

    // Connect 4 WebSockets concurrently
    const wsA1 = new WsClient(getWsUrl(`/ws/tasks/${sA1}?token=${userA.accessToken}`));
    const wsA2 = new WsClient(getWsUrl(`/ws/tasks/${sA2}?token=${userA.accessToken}`));
    const wsB1 = new WsClient(getWsUrl(`/ws/tasks/${sB1}?token=${userB.accessToken}`));
    const wsB2 = new WsClient(getWsUrl(`/ws/tasks/${sB2}?token=${userB.accessToken}`));

    await Promise.all([wsA1.connect(), wsA2.connect(), wsB1.connect(), wsB2.connect()]);

    // Await connected on all 4
    const [cA1, cA2, cB1, cB2] = await Promise.all([
      wsA1.waitForMessage((m) => m && m.event === 'connected', 5000),
      wsA2.waitForMessage((m) => m && m.event === 'connected', 5000),
      wsB1.waitForMessage((m) => m && m.event === 'connected', 5000),
      wsB2.waitForMessage((m) => m && m.event === 'connected', 5000),
    ]);

    if (cA1.session_id !== sA1) throw new Error(`sA1 mismatch: ${cA1.session_id}`);
    if (cA2.session_id !== sA2) throw new Error(`sA2 mismatch: ${cA2.session_id}`);
    if (cB1.session_id !== sB1) throw new Error(`sB1 mismatch: ${cB1.session_id}`);
    if (cB2.session_id !== sB2) throw new Error(`sB2 mismatch: ${cB2.session_id}`);

    // Wait for at least 1 log frame on each
    await Promise.all([
      wsA1.waitForMessage((m) => m && m.event === 'log', 6000),
      wsA2.waitForMessage((m) => m && m.event === 'log', 6000),
      wsB1.waitForMessage((m) => m && m.event === 'log', 6000),
      wsB2.waitForMessage((m) => m && m.event === 'log', 6000),
    ]);

    // Verify zero cross-talk in messages received by wsA1: must NEVER contain sA2, sB1, or sB2
    const crossTalkA1 = wsA1.messages.some(
      (m) => m && m.session_id && m.session_id !== sA1
    );
    if (crossTalkA1) throw new Error('Cross-talk detected on wsA1: received foreign session frame');

    const crossTalkB1 = wsB1.messages.some(
      (m) => m && m.session_id && m.session_id !== sB1
    );
    if (crossTalkB1) throw new Error('Cross-talk detected on wsB1: received foreign session frame');

    // Cancel sA1 via REST
    const cancelRes = await apiRequest(`/api/tasks/${sA1}/cancel`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${userA.accessToken}` },
    });
    if (cancelRes.status !== 200) throw new Error(`Cancel sA1 failed: ${cancelRes.status}`);

    // wsA1 should receive cancelled event
    const cancelledA1 = await wsA1.waitForMessage((m) => m && m.event === 'cancelled', 6000);
    if (!cancelledA1) throw new Error('wsA1 failed to receive cancelled frame');
    await wsA1.waitForClose(5000);

    // wsA2, wsB1, wsB2 must NOT receive cancelled event and should keep streaming
    if (wsA2.messages.some((m) => m && m.event === 'cancelled')) {
      throw new Error('wsA2 erroneously received cancellation frame meant for sA1');
    }
    if (wsB1.messages.some((m) => m && m.event === 'cancelled')) {
      throw new Error('wsB1 erroneously received cancellation frame meant for sA1');
    }

    // Clean up remaining sockets
    wsA2.close();
    wsB1.close();
    wsB2.close();
    await Promise.all([wsA2.waitForClose(), wsB1.waitForClose(), wsB2.waitForClose()]);
  });

  // Post-stress server health verification
  console.log(`\n${colors.bold}--- Post-Stress Server Verification ---${colors.reset}`);
  const postHealth = await apiRequest('/health');
  if (postHealth.status !== 200) {
    throw new Error(`Server unhealthy after stress suite: HTTP ${postHealth.status}`);
  }
  console.log(`${colors.green}✓ Post-stress server health OK (HTTP 200)${colors.reset}\n`);

  // Summary
  console.log(`${colors.cyan}================================================================${colors.reset}`);
  console.log(`${colors.cyan}             ADVERSARIAL STRESS TEST SUMMARY                    ${colors.reset}`);
  console.log(`${colors.cyan}================================================================${colors.reset}`);
  console.log(`  Target        : ${baseUrl}`);
  console.log(`  Total Tests   : ${testResults.length}`);
  console.log(`  Passed        : ${colors.green}${passedCount}${colors.reset}`);
  console.log(`  Failed        : ${failedCount > 0 ? colors.red : colors.green}${failedCount}${colors.reset}\n`);

  if (failedCount > 0) {
    process.exit(1);
  }
}

runAdversarialSuite().catch((fatal) => {
  console.error(`\n${colors.red}[FATAL ADVERSARIAL RUN ERROR]:${colors.reset}`, fatal);
  process.exit(1);
});
