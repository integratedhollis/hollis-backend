/**
 * Hollis Backend Epic 3 - Screen Control & AI Agent Loop Test Suite
 * ระบบควบคุมหน้าจอ (Screen Control & AI Agent Loop)
 *
 * Exercises:
 * 1. Tree Quality Evaluation (check_tree_quality: Text Mode vs Vision Mode)
 * 2. Risk Detection Engine (check_risk: Thai & English sensitive keywords)
 * 3. Structural Diff Engine (verify_step: DOM/Tree diff & verified_changed 0/1)
 * 4. Pluggable AI Adapter & Model Switching (Text Mode vs Vision Mode, Mock vs Live)
 * 5. Full 5-Step Agent Loop Lifecycle via WebSocket:
 *    - Handshake & Connected Event
 *    - Client `observe` frame ingestion
 *    - `action` and `log` frame dispatch
 *    - Client `action_done` response & step verification
 *    - Risk interception (`risk_confirmation_required`) and approval/rejection
 *    - Loop detection termination (`stopped_loop` on 3 consecutive unchanged steps)
 *    - Step limit enforcement (`stopped_limit` upon reaching max_step_limit)
 *    - Goal completion (`finished` code 1000 & D1 persistence)
 *
 * Usage:
 *   node test_epic3.js
 *   node test_epic3.js --url http://127.0.0.1:8787
 */

'use strict';

import { check_tree_quality } from './src/ai/treeQuality.js';
import { check_risk, DEFAULT_RISK_KEYWORDS } from './src/ai/riskEngine.js';
import { verify_step } from './src/ai/diffEngine.js';
import { decide_action, AIAdapter } from './src/ai/adapter.js';
import { formatTreeForPrompt } from './src/ai/groq.js';

// ============================================================================
// CLI & URL Setup
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
// Terminal Styling & Helpers
// ============================================================================

const isColor = !process.env.NO_COLOR;
const c = {
  reset: isColor ? '\x1b[0m' : '',
  bold: isColor ? '\x1b[1m' : '',
  dim: isColor ? '\x1b[2m' : '',
  green: isColor ? '\x1b[32m' : '',
  red: isColor ? '\x1b[31m' : '',
  yellow: isColor ? '\x1b[33m' : '',
  cyan: isColor ? '\x1b[36m' : '',
  magenta: isColor ? '\x1b[35m' : '',
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

// ============================================================================
// WebSocket Client Helper
// ============================================================================

const NativeWebSocket = globalThis.WebSocket;

class TestWsClient {
  constructor(url, options = {}) {
    this.url = url;
    this.options = options;
    this.ws = null;
    this.messages = [];
    this.closeEvent = null;
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
          reject(new Error(`WebSocket closed before open: code ${event.code}`));
        }
      };

      this.ws.onerror = (event) => {
        this._notifyWaiters();
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(new Error(`WebSocket connection error: ${event.message || 'error'}`));
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
      throw new Error(`Cannot send message: WebSocket is not open`);
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
// HTTP API Helper
// ============================================================================

async function apiRequest(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {}),
  };

  let body = options.body;
  if (body && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body,
    signal: options.signal || AbortSignal.timeout(10000),
  });

  const rawText = await res.text();
  let jsonBody = null;
  try {
    jsonBody = JSON.parse(rawText);
  } catch (_) {}

  return {
    status: res.status,
    body: jsonBody,
    rawText,
  };
}

// ============================================================================
// Test Framework Runner
// ============================================================================

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function test(name, fn) {
  totalTests++;
  process.stdout.write(`  [TEST] ${name} ... `);
  try {
    await fn();
    passedTests++;
    console.log(`${c.green}PASS${c.reset}`);
  } catch (err) {
    failedTests++;
    console.log(`${c.red}FAIL${c.reset}`);
    console.error(`    ${c.red}${err.message}${c.reset}`);
    if (err.stack) {
      const lines = err.stack.split('\n').slice(1, 3);
      console.error(`    ${c.dim}${lines.join('\n    ')}${c.reset}`);
    }
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message || 'Assertion failed');
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message || 'Assertion failed'}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

// ============================================================================
// Test Execution
// ============================================================================

async function main() {
  console.log(`\n${c.bold}${c.magenta}================================================================${c.reset}`);
  console.log(`${c.bold}${c.magenta}  Hollis Backend Epic 3: Screen Control & AI Agent Loop Tests   ${c.reset}`);
  console.log(`${c.bold}${c.magenta}================================================================${c.reset}\n`);

  // --------------------------------------------------------------------------
  // SECTION 1: Tree Quality Engine Verification
  // --------------------------------------------------------------------------
  console.log(`${c.bold}${c.cyan}--- Section 1: Tree Quality Evaluation Engine ---${c.reset}`);

  await test('TreeQuality: Null/undefined tree falls back to Vision Mode', () => {
    const resNull = check_tree_quality(null);
    assertEqual(resNull.mode, 'vision', 'Null tree must use vision mode');
    assertEqual(resNull.sufficient, false);

    const resUndef = check_tree_quality(undefined);
    assertEqual(resUndef.mode, 'vision', 'Undefined tree must use vision mode');
  });

  await test('TreeQuality: Empty object or canvas with zero clickables falls back to Vision Mode', () => {
    const emptyTree = { class: 'android.widget.FrameLayout', clickable: false, children: [] };
    const res = check_tree_quality(emptyTree);
    assertEqual(res.mode, 'vision');
    assertEqual(res.clickable_nodes, 0);
  });

  await test('TreeQuality: Rich hierarchy with clickable and text elements selects Text Mode', () => {
    const richTree = {
      class: 'android.widget.LinearLayout',
      clickable: false,
      children: [
        {
          class: 'android.widget.TextView',
          text: 'แอปพลิเคชัน Hollis',
          clickable: false,
        },
        {
          class: 'android.widget.Button',
          text: 'ส่งเงิน',
          clickable: true,
        },
      ],
    };
    const res = check_tree_quality(richTree);
    assertEqual(res.mode, 'text', 'Rich tree should select text mode');
    assertEqual(res.sufficient, true);
    assert(res.clickable_nodes >= 1, 'Should count clickable nodes');
    assert(res.text_elements >= 1, 'Should count text elements');
    assert(res.depth >= 2, 'Should compute depth');
  });

  await test('TreeQuality: Formats tree into prompt-friendly compact format', () => {
    const tree = {
      id: 'root',
      class: 'android.widget.LinearLayout',
      children: [
        { id: 'btn_1', class: 'Button', text: 'Confirm', clickable: true },
      ],
    };
    const formatted = formatTreeForPrompt(tree);
    assert(typeof formatted === 'string' && formatted.includes('btn_1'));
    assert(formatted.includes('Confirm'));
  });

  // --------------------------------------------------------------------------
  // SECTION 2: Risk Evaluation Engine Verification
  // --------------------------------------------------------------------------
  console.log(`\n${c.bold}${c.cyan}--- Section 2: Risk Evaluation Engine ---${c.reset}`);

  await test('RiskEngine: Detects Thai risky keywords (ส่ง, ลบ, โอน, ยืนยัน, จ่าย)', () => {
    const thaiActions = [
      { action: { target: 'ปุ่ม โอนเงิน ไปยังบัญชีเป้าหมาย' }, expectedKeyword: 'โอน' },
      { action: { text: 'ลบข้อมูล ผู้ใช้งานทั้งหมด' }, expectedKeyword: 'ลบ' },
      { action: { log_message: 'กดปุ่ม ยืนยัน การทำรายการ' }, expectedKeyword: 'ยืนยัน' },
      { action: { label: 'ส่ง ข้อความแจ้งเตือน' }, expectedKeyword: 'ส่ง' },
      { action: { description: 'ชำระ ค่าบริการ' }, expectedKeyword: 'ชำระ' },
    ];

    for (const item of thaiActions) {
      const risk = check_risk(item.action);
      assertEqual(risk.is_risky, true, `Should detect risk in: ${JSON.stringify(item.action)}`);
      assertEqual(risk.matched_keyword, item.expectedKeyword);
      assert(risk.reason !== null, 'Reason must be populated');
    }
  });

  await test('RiskEngine: Detects English risky keywords (pay, delete, buy, confirm, transfer)', () => {
    const engActions = [
      { action: { target: 'Click Pay Now button' }, expectedKeyword: 'pay' },
      { action: { text: 'Delete selected user' }, expectedKeyword: 'delete' },
      { action: { log_message: 'Confirm order checkout' }, expectedKeyword: 'confirm' },
      { action: { target: 'Buy with 1-Click' }, expectedKeyword: 'buy' },
      { action: 'transfer funds to account', expectedKeyword: 'transfer' },
    ];

    for (const item of engActions) {
      const risk = check_risk(item.action);
      assertEqual(risk.is_risky, true, `Should detect risk in: ${JSON.stringify(item.action)}`);
      assertEqual(risk.matched_keyword, item.expectedKeyword);
    }
  });

  await test('RiskEngine: Passes safe non-risky actions safely', () => {
    const safeActions = [
      { action_type: 'scroll_down', target: 'เลื่อนดูรายการสินค้า' },
      { action_type: 'inspect_screen', target: 'ตรวจสอบหน้าจอ' },
      { action_type: 'tap', target: 'ปุ่มเปิดเมนูตั้งค่า' },
      null,
      undefined,
    ];

    for (const act of safeActions) {
      const risk = check_risk(act);
      assertEqual(risk.is_risky, false, `Action should not be risky: ${JSON.stringify(act)}`);
      assertEqual(risk.matched_keyword, null);
    }
  });

  // --------------------------------------------------------------------------
  // SECTION 3: Structural Diff Engine Verification
  // --------------------------------------------------------------------------
  console.log(`\n${c.bold}${c.cyan}--- Section 3: Structural Diff Engine ---${c.reset}`);

  await test('DiffEngine: Evaluates verified_changed = 0 for identical screen trees', () => {
    const tree = {
      class: 'android.widget.FrameLayout',
      clickable: false,
      text: 'หน้าจอหลัก',
      children: [
        { id: 'btn_ok', class: 'Button', text: 'OK', clickable: true },
      ],
    };
    const cloned = JSON.parse(JSON.stringify(tree));

    const diff = verify_step(tree, cloned);
    assertEqual(diff.verified_changed, 0, 'Identical trees must produce verified_changed = 0');
    assertEqual(diff.has_changed, false);
  });

  await test('DiffEngine: Evaluates verified_changed = 1 when text or nodes change', () => {
    const before = {
      class: 'android.widget.FrameLayout',
      children: [
        { id: 'status', class: 'TextView', text: 'กำลังดาวน์โหลด...' },
      ],
    };
    const after = {
      class: 'android.widget.FrameLayout',
      children: [
        { id: 'status', class: 'TextView', text: 'ดาวน์โหลดเสร็จสมบูรณ์!' },
      ],
    };

    const diff = verify_step(before, after);
    assertEqual(diff.verified_changed, 1, 'Altered text must produce verified_changed = 1');
    assertEqual(diff.has_changed, true);
  });

  await test('DiffEngine: Evaluates verified_changed = 1 when node count changes', () => {
    const before = {
      children: [
        { id: 'item_1', text: 'Item 1' },
      ],
    };
    const after = {
      children: [
        { id: 'item_1', text: 'Item 1' },
        { id: 'item_2', text: 'Item 2' },
      ],
    };

    const diff = verify_step(before, after);
    assertEqual(diff.verified_changed, 1);
    assertEqual(diff.details.added_nodes, 1);
  });

  await test('DiffEngine: Handles null, string, and screenshot visual changes', () => {
    assertEqual(verify_step(null, null).verified_changed, 0);
    assertEqual(verify_step(null, { text: 'new' }).verified_changed, 1);

    const s1 = { screenshot: 'base64_img_1' };
    const s2 = { screenshot: 'base64_img_2' };
    assertEqual(verify_step(s1, s2).verified_changed, 1);
  });

  // --------------------------------------------------------------------------
  // SECTION 4: AI Unified Adapter Verification
  // --------------------------------------------------------------------------
  console.log(`\n${c.bold}${c.cyan}--- Section 4: Pluggable AI Adapter & Mode Switching ---${c.reset}`);

  await test('Adapter: Selects Text Mode when tree is rich and produces valid structured action', async () => {
    const richTree = {
      class: 'android.widget.LinearLayout',
      children: [
        { class: 'android.widget.Button', text: 'เปิดแอป LINE', clickable: true },
      ],
    };

    const decision = await decide_action({
      instruction: 'เปิดแอป LINE',
      screen_tree: richTree,
    });

    assertEqual(decision.mode_used, 'text', 'Should select text mode for rich tree');
    assert(typeof decision.action_type === 'string', 'Should return action_type');
    assert(typeof decision.log_message === 'string', 'Should return log_message');
    assertEqual(decision.tree_quality.sufficient, true);
  });

  await test('Adapter: Selects Vision Mode when tree is empty or insufficient', async () => {
    const emptyTree = null;
    const screenshot = 'data:image/png;base64,mockScreenshotBytes';

    const decision = await decide_action({
      instruction: 'กดปุ่มบนหน้าจอ',
      screen_tree: emptyTree,
      screenshot,
    });

    assertEqual(decision.mode_used, 'vision', 'Should select vision mode for empty tree');
    assertEqual(decision.tree_quality.sufficient, false);
  });

  // --------------------------------------------------------------------------
  // SECTION 5: End-to-End WebSocket Agent Loop Integration (requires server)
  // --------------------------------------------------------------------------
  console.log(`\n${c.bold}${c.cyan}--- Section 5: E2E Real-time Agent Loop Integration ---${c.reset}`);

  let serverOnline = false;
  try {
    const preflight = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
    if (preflight.ok || preflight.status === 200) {
      serverOnline = true;
    }
  } catch (_) {
    try {
      const rootRes = await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(2000) });
      if (rootRes.ok || rootRes.status === 200) serverOnline = true;
    } catch (_) {}
  }

  if (!serverOnline) {
    console.log(`${c.yellow}[NOTICE] Server is not running at ${baseUrl}. Skipping live WebSocket integration tests.${c.reset}`);
    console.log(`${c.yellow}To run live integration tests: start server with 'npm run dev' and re-run test_epic3.js.${c.reset}`);
  } else {
    // Register user for test session
    const testEmail = `epic3_${generateUUID()}@test.local`;
    const regRes = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'Epic3 Tester',
        email: testEmail,
        password: 'Password123!',
      },
    });
    assert(regRes.status === 201, `Failed to register user: ${regRes.rawText}`);
    const token = regRes.body.access_token;

    // Test TC-E3-01: Connect and receive connected frame
    await test('TC-E3-01: WebSocket connects and receives initial connected frame', async () => {
      const taskRes = await apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: { instruction: 'ทดสอบเชื่อมต่อ Agent Loop' },
      });
      assert(taskRes.status === 201);
      const sessionId = taskRes.body.session_id;

      const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${token}&mode=interactive`);
      const client = new TestWsClient(wsUrl);
      await client.connect();

      const connected = await client.waitForMessage(
        (m) => m && m.event === 'connected',
        5000,
        'connected event'
      );
      assertEqual(connected.session_id, sessionId);
      assertEqual(connected.status, 'running');

      client.close();
      await client.waitForClose();
    });

    // Test TC-E3-02: Interactive 5-Step Loop: observe -> action -> action_done -> verification
    await test('TC-E3-02: Interactive Agent Loop: observe -> action frame -> action_done -> verified step', async () => {
      const taskRes = await apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: { instruction: 'เปิดหน้าค้นหา' },
      });
      assert(taskRes.status === 201);
      const sessionId = taskRes.body.session_id;

      const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${token}&mode=interactive`);
      const client = new TestWsClient(wsUrl);
      await client.connect();

      await client.waitForMessage((m) => m && m.event === 'connected', 4000);

      // Client sends observe frame
      client.send({
        event: 'observe',
        screen_tree: {
          class: 'android.widget.FrameLayout',
          children: [
            { class: 'android.widget.Button', text: 'ค้นหารายการ', clickable: true },
          ],
        },
      });

      // Wait for agent to decide and dispatch action
      const actionFrame = await client.waitForMessage(
        (m) => m && m.event === 'action',
        6000,
        'action frame'
      );
      assert(actionFrame !== null, 'Client must receive action frame');
      assertEqual(actionFrame.session_id, sessionId);
      assert(typeof actionFrame.action === 'object', 'action must be an object');

      // Client responds with action_done (simulating execution with updated UI)
      client.send({
        event: 'action_done',
        step_no: actionFrame.step_no,
        screen_tree: {
          class: 'android.widget.FrameLayout',
          children: [
            { class: 'android.widget.TextView', text: 'หน้าผลการค้นหา' },
          ],
        },
        status: 'ok',
      });

      // Verify that step was persisted in D1
      await new Promise((r) => setTimeout(r, 600));
      const logsRes = await apiRequest(`/api/tasks/${sessionId}/logs`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      assert(logsRes.status === 200);
      assert(logsRes.body.logs.length >= 1, 'Step must be saved to D1 task_steps');
      assertEqual(logsRes.body.logs[0].verified_changed, true, 'Diff verification must mark verified_changed');

      client.close();
      await client.waitForClose();
    });

    // Test TC-E3-03: Risk Interception and Confirmation Required
    await test('TC-E3-03: Risk interception pauses loop and broadcasts risk_confirmation_required', async () => {
      // Start task with risky instruction (โอนเงิน)
      const taskRes = await apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: { instruction: 'ทำการ โอนเงิน 1000 บาท' },
      });
      assert(taskRes.status === 201);
      const sessionId = taskRes.body.session_id;

      const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${token}&mode=interactive`);
      const client = new TestWsClient(wsUrl);
      await client.connect();

      await client.waitForMessage((m) => m && m.event === 'connected', 4000);

      // Step 1 observe
      client.send({
        event: 'observe',
        screen_tree: {
          class: 'android.widget.FrameLayout',
          children: [{ class: 'android.widget.Button', text: 'เลือกบัญชี', clickable: true }],
        },
      });

      const act1 = await client.waitForMessage((m) => m && m.event === 'action' && m.step_no === 1, 6000);
      // Respond to step 1
      client.send({
        event: 'action_done',
        step_no: act1.step_no,
        screen_tree: {
          class: 'android.widget.FrameLayout',
          children: [{ class: 'android.widget.Button', text: 'ปุ่ม ยืนยันการโอนเงิน', clickable: true }],
        },
      });

      // Step 2 is risky -> server should emit risk_confirmation_required
      const riskFrame = await client.waitForMessage(
        (m) => m && m.event === 'risk_confirmation_required',
        8000,
        'risk_confirmation_required frame'
      );
      assert(riskFrame !== null, 'Must emit risk_confirmation_required');
      assertEqual(riskFrame.session_id, sessionId);
      assertEqual(riskFrame.matched_keyword, 'โอน');

      // User approves risk via WebSocket confirm frame
      client.send({
        event: 'confirm',
        approved: true,
      });

      // Now action should be dispatched
      const act2 = await client.waitForMessage(
        (m) => m && m.event === 'action' && m.step_no === 2,
        6000,
        'action frame after risk approved'
      );
      assertEqual(act2.is_risky, true);

      client.close();
      await client.waitForClose();
    });

    // Test TC-E3-04: Loop Detection Termination (stopped_loop)
    await test('TC-E3-04: Loop detection terminates session with status stopped_loop after 3 unchanged steps', async () => {
      const taskRes = await apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: { instruction: 'ทดสอบลูปการทำงาน test_loop' },
      });
      assert(taskRes.status === 201);
      const sessionId = taskRes.body.session_id;

      const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${token}&mode=interactive`);
      const client = new TestWsClient(wsUrl);
      await client.connect();

      await client.waitForMessage((m) => m && m.event === 'connected', 4000);

      const staticTree = {
        class: 'android.widget.FrameLayout',
        children: [{ class: 'android.widget.Button', text: 'ปุ่มเดิมติดลูป', clickable: true }],
      };

      // Loop 1
      client.send({ event: 'observe', screen_tree: staticTree });
      const act1 = await client.waitForMessage((m) => m && m.event === 'action' && m.step_no === 1, 6000);
      client.send({ event: 'action_done', step_no: act1.step_no, screen_tree: staticTree });

      // Loop 2
      const act2 = await client.waitForMessage((m) => m && m.event === 'action' && m.step_no === 2, 6000);
      client.send({ event: 'action_done', step_no: act2.step_no, screen_tree: staticTree });

      // Loop 3
      const act3 = await client.waitForMessage((m) => m && m.event === 'action' && m.step_no === 3, 6000);
      client.send({ event: 'action_done', step_no: act3.step_no, screen_tree: staticTree });

      // After 3 unchanged actions, agent must emit stopped_loop frame
      const loopFrame = await client.waitForMessage(
        (m) => m && m.event === 'stopped_loop',
        8000,
        'stopped_loop frame'
      );
      assert(loopFrame !== null, 'Must emit stopped_loop frame');
      assertEqual(loopFrame.status, 'stopped_loop');

      // Verify D1 status is stopped_loop
      const statusRes = await apiRequest(`/api/tasks/${sessionId}/status`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      assertEqual(statusRes.body.status, 'stopped_loop', 'D1 session status must be stopped_loop');

      client.close();
      await client.waitForClose();
    });

    // Test TC-E3-05: Step Limit Enforcer (stopped_limit)
    await test('TC-E3-05: Step limit enforcer terminates session with status stopped_limit', async () => {
      // Set user's max_step_limit to 2 for this test
      await apiRequest('/api/users/settings', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` },
        body: { max_step_limit: 2 },
      });

      const taskRes = await apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: { instruction: 'ทดสอบลิมิตขั้นตอน' },
      });
      assert(taskRes.status === 201);
      const sessionId = taskRes.body.session_id;

      const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${token}&mode=interactive`);
      const client = new TestWsClient(wsUrl);
      await client.connect();

      await client.waitForMessage((m) => m && m.event === 'connected', 4000);

      // Step 1
      client.send({
        event: 'observe',
        screen_tree: { children: [{ text: 'Step 1' }] },
      });
      const act1 = await client.waitForMessage((m) => m && m.event === 'action' && m.step_no === 1, 6000);
      client.send({
        event: 'action_done',
        step_no: act1.step_no,
        screen_tree: { children: [{ text: 'Step 1 Done' }] },
      });

      // Step 2 (reaches limit 2)
      const act2 = await client.waitForMessage((m) => m && m.event === 'action' && m.step_no === 2, 6000);
      client.send({
        event: 'action_done',
        step_no: act2.step_no,
        screen_tree: { children: [{ text: 'Step 2 Done' }] },
      });

      // Must emit stopped_limit frame
      const limitFrame = await client.waitForMessage(
        (m) => m && m.event === 'stopped_limit',
        8000,
        'stopped_limit frame'
      );
      assert(limitFrame !== null, 'Must emit stopped_limit frame');
      assertEqual(limitFrame.status, 'stopped_limit');

      // Verify D1 status is stopped_limit
      const statusRes = await apiRequest(`/api/tasks/${sessionId}/status`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      assertEqual(statusRes.body.status, 'stopped_limit', 'D1 session status must be stopped_limit');

      // Restore user settings
      await apiRequest('/api/users/settings', {
        method: 'PUT',
        headers: { 'Authorization': `Bearer ${token}` },
        body: { max_step_limit: 20 },
      });

      client.close();
      await client.waitForClose();
    });

    // Test TC-E3-06: Task Completion (finished frame)
    await test('TC-E3-06: Task completes normally with finished frame and code 1000', async () => {
      const taskRes = await apiRequest('/api/tasks/start', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
        body: { instruction: 'คำสั่งงานสำเร็จปกติ' },
      });
      assert(taskRes.status === 201);
      const sessionId = taskRes.body.session_id;

      const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${token}`);
      const client = new TestWsClient(wsUrl);
      await client.connect();

      // In default/autonomous mode, it will run through mock progression and complete
      const finishedFrame = await client.waitForMessage(
        (m) => m && m.event === 'finished',
        12000,
        'finished frame'
      );
      assert(finishedFrame !== null);
      assertEqual(finishedFrame.status, 'completed');

      const closeEvent = await client.waitForClose(5000);
      assertEqual(closeEvent.code, 1000, 'Close code must be 1000');
    });
  }

  // --------------------------------------------------------------------------
  // Summary Report
  // --------------------------------------------------------------------------
  console.log(`\n${c.bold}================================================================${c.reset}`);
  console.log(`${c.bold}  Hollis Backend Epic 3 Test Execution Summary                 ${c.reset}`);
  console.log(`================================================================`);
  console.log(`  Total Tests  : ${totalTests}`);
  console.log(`  Passed Tests : ${c.green}${passedTests}${c.reset}`);
  console.log(`  Failed Tests : ${failedTests > 0 ? c.red : c.green}${failedTests}${c.reset}`);
  console.log(`================================================================\n`);

  if (failedTests > 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n${c.red}[UNHANDLED TEST RUNNER ERROR]${c.reset}`, err);
  process.exit(1);
});
