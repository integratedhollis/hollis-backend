/**
 * Hollis Screen Control — Pluggable Unified AI Adapter
 *
 * Automatically chooses between Text Mode (Groq openai/gpt-oss-120b, falling back to Cloudflare Workers AI
 * @cf/openai/gpt-oss-120b, then Groq openai/gpt-oss-20b) and Vision Mode (OpenRouter / Qwen3-VL)
 * based on Accessibility Tree Quality evaluation.
 *
 * The scripted Mock Engine is for tests and offline development only: it runs when
 * env.ALLOW_MOCK_AI === 'true'. Without it a missing key or a failing model is an explicit error.
 */

import { check_tree_quality } from './treeQuality.js';
import {
  callGroqTextModel,
  callWorkersAITextModel,
  resolveGroqModel,
  DEFAULT_WORKERS_AI_MODEL,
  DEFAULT_GROQ_FALLBACK_MODEL,
  HOLLIS_TOOLS,
} from './groq.js';
import { callOpenRouterVisionModel } from './openrouter.js';
import { elementList, findElement, resolveInstalledApp } from './prompt.js';

/**
 * Intelligent Mock Engine producing dynamic automation actions
 * based on user instructions, screen tree contents, and step count.
 *
 * @param {object} params
 * @returns {object}
 */
export function runMockEngine({ instruction = '', screen_tree, screenshot, history = [], mode = 'text', options = {} }) {
  // If test explicitly specified a mock action override
  if (options.mockAction) {
    const act = options.mockAction;
    const toolName = act.tool_name || act.action_type || 'click_element';
    const params = act.parameters || { element_id: act.element_id ?? 0, target_description: act.target || 'mock' };
    return {
      action_type: toolName,
      tool_name: toolName,
      parameters: params,
      element_id: params.element_id ?? 0,
      target: act.target || 'mock target',
      is_completed: toolName === 'task_finish' || Boolean(act.is_completed),
      log_message: act.log_message || 'Executing mock action',
      ...act,
    };
  }

  // If test provided a sequence of actions
  if (Array.isArray(options.mockSequence) && options.mockSequence[history.length]) {
    const act = options.mockSequence[history.length];
    const toolName = act.tool_name || act.action_type || 'click_element';
    return {
      action_type: toolName,
      tool_name: toolName,
      parameters: act.parameters || { element_id: act.element_id ?? 0 },
      is_completed: toolName === 'task_finish' || Boolean(act.is_completed),
      ...act,
    };
  }

  const stepIndex = options.stepIndex !== undefined ? options.stepIndex : history.length;
  const lowerInst = (instruction || '').toLowerCase();

  // Test scenario: Loop detection trigger
  if (options.simulate_loop || lowerInst.includes('test_loop') || lowerInst.includes('ทดสอบลูป')) {
    return {
      action_type: 'click_element',
      tool_name: 'click_element',
      parameters: { element_id: 99, target_description: 'ปุ่มติดลูปเดิม' },
      element_id: 99,
      target: 'ปุ่มติดลูปเดิม',
      target_id: '99',
      text: null,
      log_message: 'กดปุ่มเดิมซ้ำๆ เพื่อทดสอบระบบตรวจจับลูป',
      is_completed: false,
    };
  }

  // Test scenario: Risky operations (ลบ, delete)
  if (lowerInst.includes('ลบ') || lowerInst.includes('delete')) {
    if (stepIndex === 0) {
      return {
        action_type: 'click_element',
        tool_name: 'click_element',
        parameters: { element_id: 1, target_description: 'ค้นหารายการที่ต้องการลบ' },
        element_id: 1,
        target: 'ค้นหารายการที่ต้องการลบ',
        target_id: '1',
        log_message: 'ค้นหารายการเป้าหมาย',
        is_completed: false,
      };
    }
    if (stepIndex === 1) {
      return {
        action_type: 'click_element',
        tool_name: 'click_element',
        parameters: { element_id: 2, target_description: 'ปุ่ม ยืนยันการลบ ข้อมูลถาวร' },
        element_id: 2,
        target: 'ปุ่ม ยืนยันการลบ ข้อมูลถาวร',
        target_id: '2',
        log_message: 'เตรียมลบข้อมูล (ต้องยืนยันความเสี่ยง)',
        is_completed: false,
      };
    }
    return {
      action_type: 'task_finish',
      tool_name: 'task_finish',
      parameters: { status: 'success', message: 'ลบข้อมูลสำเร็จเรียบร้อย' },
      element_id: null,
      target: 'เสร็จสิ้นการลบ',
      log_message: 'ลบข้อมูลสำเร็จเรียบร้อย',
      is_completed: true,
    };
  }

  // Test scenario: Risky operations (โอน, pay, confirm, ยืนยัน)
  if (lowerInst.includes('โอน') || lowerInst.includes('pay') || lowerInst.includes('confirm') || lowerInst.includes('ยืนยัน')) {
    if (stepIndex === 0) {
      return {
        action_type: 'click_element',
        tool_name: 'click_element',
        parameters: { element_id: 1, target_description: 'เลือกบัญชีผู้รับ' },
        element_id: 1,
        target: 'เลือกบัญชีผู้รับ',
        target_id: '1',
        log_message: 'เลือกบัญชีเป้าหมาย',
        is_completed: false,
      };
    }
    if (stepIndex === 1) {
      return {
        action_type: 'click_element',
        tool_name: 'click_element',
        parameters: { element_id: 2, target_description: 'ปุ่ม ยืนยันการโอนเงิน' },
        element_id: 2,
        target: 'ปุ่ม ยืนยันการโอนเงิน',
        target_id: '2',
        log_message: 'กดปุ่มยืนยันการทำธุรกรรม (เสี่ยง)',
        is_completed: false,
      };
    }
    return {
      action_type: 'task_finish',
      tool_name: 'task_finish',
      parameters: { status: 'success', message: 'ทำธุรกรรมเสร็จสิ้น' },
      element_id: null,
      target: 'โอนสำเร็จ',
      log_message: 'ทำธุรกรรมเสร็จสิ้น',
      is_completed: true,
    };
  }

  // Test scenario: Launching an application (เปิดแอป, open app, etc.)
  if (lowerInst.includes('เปิดแอป') || lowerInst.includes('open app') || lowerInst.includes('เปิด line') || lowerInst.includes('เปิด youtube') || lowerInst.includes('เปิด shopee')) {
    if (stepIndex === 0) {
      const appName = lowerInst.includes('line') ? 'LINE' : (lowerInst.includes('youtube') ? 'YouTube' : (lowerInst.includes('shopee') ? 'Shopee' : 'Settings'));
      const packageName = appName === 'LINE' ? 'jp.naver.line.android' : (appName === 'YouTube' ? 'com.google.android.youtube' : (appName === 'Shopee' ? 'com.shopee.th' : 'com.android.settings'));
      return {
        action_type: 'open_app',
        tool_name: 'open_app',
        parameters: { app_name: appName, package_name: packageName },
        app_name: appName,
        package_name: packageName,
        element_id: null,
        target: `เปิดแอป ${appName}`,
        target_id: null,
        log_message: `เปิดแอปพลิเคชัน ${appName} (${packageName})`,
        is_completed: false,
      };
    }
  }

  // Dynamic tree-aware mock: if tree has elements, interact with element_id
  let targetDesc = 'เป้าหมายบนหน้าจอ';
  let targetId = 0;
  if (screen_tree && typeof screen_tree === 'object') {
    const list = screen_tree.screen_elements || screen_tree.elements;
    if (Array.isArray(list) && list.length > 0) {
      targetDesc = list[0].text || list[0].content_description || 'ปุ่มบนหน้าจอ';
      targetId = list[0].id !== undefined ? list[0].id : 0;
    } else {
      const visited = new Set();
      const findClickable = (node, depth = 0) => {
        if (!node || typeof node !== 'object' || depth > 64 || visited.has(node)) return null;
        visited.add(node);
        if (node.clickable || node.is_clickable) return node;
        const ch = node.children || node.nodes || node.child_nodes || [];
        if (Array.isArray(ch)) {
          for (const c of ch) {
            const found = findClickable(c, depth + 1);
            if (found) return found;
          }
        }
        return null;
      };
      const node = findClickable(screen_tree);
      if (node) {
        targetDesc = node.text || node.content_description || node.label || 'ปุ่มบนหน้าจอ';
        targetId = node.id !== undefined ? (typeof node.id === 'number' ? node.id : 0) : 0;
      }
    }
  }

  // Sequential progression across 7 tools
  if (stepIndex === 0) {
    if (mode === 'vision') {
      return {
        action_type: 'click_coordinate',
        tool_name: 'click_coordinate',
        parameters: { x: 540, y: 1200, target_description: targetDesc },
        coordinates: { x: 0.5, y: 0.5 },
        target: targetDesc,
        target_id: null,
        log_message: `แตะพิกัดหน้าจอ (Vision Mode): ${targetDesc}`,
        is_completed: false,
      };
    }
    return {
      action_type: 'click_element',
      tool_name: 'click_element',
      parameters: { element_id: targetId, target_description: targetDesc },
      element_id: targetId,
      target: targetDesc,
      target_id: String(targetId),
      log_message: `กดเลือก ${targetDesc} (ID: ${targetId})`,
      is_completed: false,
    };
  }

  if (stepIndex === 1) {
    return {
      action_type: 'swipe_screen',
      tool_name: 'swipe_screen',
      parameters: { direction: 'DOWN' },
      direction: 'DOWN',
      target: 'เลื่อนหน้าจอลง',
      target_id: null,
      log_message: 'เลื่อนหน้าจอลงเพื่อค้นหาเนื้อหาเพิ่มเติม',
      is_completed: false,
    };
  }

  if (stepIndex === 2) {
    return {
      action_type: 'wait_and_poll',
      tool_name: 'wait_and_poll',
      parameters: { duration_ms: 700 },
      duration_ms: 700,
      target: 'รอหน้าจอโหลด',
      target_id: null,
      log_message: 'หยุดรอหน้าจอ 700 ms เพื่อให้เนื้อหาโหลดเสร็จสิ้น',
      is_completed: false,
    };
  }

  return {
    action_type: 'task_finish',
    tool_name: 'task_finish',
    parameters: { status: 'success', message: 'งานเสร็จสมบูรณ์เรียบร้อยแล้ว' },
    element_id: null,
    target: 'งานสำเร็จ',
    target_id: null,
    log_message: 'งานเสร็จสมบูรณ์เรียบร้อยแล้ว',
    is_completed: true,
  };
}

/** Raised when no real AI engine could produce a decision. The loop reports it to the user instead of faking progress. */
export class AIEngineError extends Error {
  /**
   * @param {'ai_not_configured' | 'ai_unavailable' | 'ai_no_input'} code
   * @param {string} message
   * @param {string[]} [details]
   */
  constructor(code, message, details = []) {
    super(message);
    this.name = 'AIEngineError';
    this.code = code;
    this.details = details;
  }
}

const TOOL_NAMES = HOLLIS_TOOLS.map((t) => t.function.name);

/**
 * Checks a model's tool call against the current screen before it is sent to the phone.
 * @returns {string | null} A message the model can act on, or null when the call is usable.
 */
export function validateDecision(action, screen_tree) {
  const tool = action?.tool_name || action?.action_type;
  if (!TOOL_NAMES.includes(tool)) return `"${tool}" is not one of the available tools.`;
  const p = action.parameters || {};

  switch (tool) {
    case 'click_element':
    case 'input_text': {
      if (p.element_id === null || p.element_id === undefined || p.element_id === '' || !Number.isInteger(Number(p.element_id))) {
        return `${tool} needs an integer element_id.`;
      }
      const list = elementList(screen_tree);
      if (list && !findElement(screen_tree, p.element_id)) {
        return `There is no element with id ${p.element_id} on the current screen (valid ids are 0-${list.length - 1}).`;
      }
      if (tool === 'input_text' && typeof p.text !== 'string') return 'input_text needs a text string.';
      return null;
    }
    case 'click_coordinate':
      return p.x !== null && p.y !== null && p.x !== undefined && p.y !== undefined &&
        Number.isFinite(Number(p.x)) && Number.isFinite(Number(p.y))
        ? null
        : 'click_coordinate needs numeric x and y.';
    case 'swipe_screen':
      return ['UP', 'DOWN', 'LEFT', 'RIGHT'].includes(String(p.direction).toUpperCase())
        ? null
        : 'swipe_screen direction must be UP, DOWN, LEFT or RIGHT.';
    case 'system_navigation':
      return ['BACK', 'HOME', 'RECENTS'].includes(String(p.action).toUpperCase())
        ? null
        : 'system_navigation action must be BACK, HOME or RECENTS.';
    case 'open_app':
      return typeof p.app_name === 'string' && p.app_name.trim() ? null : 'open_app needs an app_name.';
    default:
      return null;
  }
}

/** Calls an engine, and if its answer fails validation asks once more with the reason attached. */
async function callWithValidation(call, screen_tree) {
  let feedback = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const action = await call(feedback);
    const problem = validateDecision(action, screen_tree);
    if (!problem) return action;
    console.warn(`[AIAdapter] Invalid tool call (attempt ${attempt + 1}): ${problem}`);
    feedback = problem;
  }
  throw new Error(`Model returned an invalid tool call twice: ${feedback}`);
}

/** Fixes up a validated decision: real package for open_app, device pixels for vision taps, clamped waits. */
function finalizeParameters(action, { engine, context }) {
  const params = { ...(action.parameters || {}) };
  const tool = action.tool_name || action.action_type;
  const apps = Array.isArray(context.installed_apps) ? context.installed_apps : [];

  if (tool === 'open_app') {
    const app = resolveInstalledApp(apps, params.app_name);
    if (app) {
      params.app_name = app.name;
      params.package_name = app.package;
    } else if (apps.length > 0 && params.package_name && !apps.some((a) => a.package === params.package_name)) {
      // A package the model made up; let the phone resolve the app by name instead.
      delete params.package_name;
    }
  } else if (tool === 'swipe_screen') {
    params.direction = String(params.direction).toUpperCase();
  } else if (tool === 'system_navigation') {
    params.action = String(params.action).toUpperCase();
  } else if (tool === 'wait_and_poll') {
    params.duration_ms = Math.max(500, Math.min(3000, Number(params.duration_ms) || 1000));
  } else if (tool === 'click_coordinate' && engine === 'openrouter') {
    // The vision model answers in fractions of the screenshot; the phone taps in pixels.
    const x = Number(params.x);
    const y = Number(params.y);
    const { w, h } = context.screen || {};
    if (x >= 0 && x <= 1 && y >= 0 && y <= 1 && w > 0 && h > 0) {
      params.x = Math.round(x * w);
      params.y = Math.round(y * h);
    }
  }
  return params;
}

/**
 * Rate-limit memory (per Worker isolate, best effort): an engine that just answered 429 is tried
 * last until its window passes, so every step of a task does not first burn a call on a limited key.
 */
const engineCooldowns = new Map();
const DEFAULT_COOLDOWN_MS = 20_000;
const MAX_COOLDOWN_MS = 300_000;

function isCoolingDown(id) {
  return (engineCooldowns.get(id) || 0) > Date.now();
}

function startCooldown(id, retryAfterMs) {
  const wait = Math.min(MAX_COOLDOWN_MS, Math.max(1_000, retryAfterMs || DEFAULT_COOLDOWN_MS));
  engineCooldowns.set(id, Date.now() + wait);
}

/** For tests. */
export function resetEngineCooldowns() {
  engineCooldowns.clear();
}

/**
 * Unified Decision Engine: decides the next action by evaluating tree quality, choosing the
 * preferred model (Text vs Vision), and falling back to the other one when it cannot be used.
 *
 * There is NO silent fake fallback: when no real engine can answer, this throws an
 * {@link AIEngineError}. The scripted mock engine only runs when `env.ALLOW_MOCK_AI === 'true'`
 * (tests / offline development) or when a test forces it through `options`.
 *
 * @param {object} params
 * @param {string} params.instruction - User command
 * @param {any} [params.screen_tree] - Screen accessibility hierarchy / flat element list
 * @param {string} [params.screenshot] - Screen image Base64
 * @param {Array} [params.history] - AgentLoop history entries
 * @param {{package?: string, screen?: {w: number, h: number}, installed_apps?: Array<{name: string, package: string}>}} [params.context] - Device facts reported by the phone
 * @param {Record<string, any>} [params.env] - Cloudflare worker env containing API keys
 * @param {object} [params.options] - Custom options or forced settings
 * @returns {Promise<{
 *   action_type: string,
 *   tool_name: string,
 *   parameters: object,
 *   element_id: number | null,
 *   target: string,
 *   target_id: string | null,
 *   coordinates?: { x: number, y: number } | null,
 *   text: string | null,
 *   log_message: string,
 *   is_completed: boolean,
 *   mode_used: 'text' | 'vision',
 *   engine_used: 'groq' | 'workers-ai' | 'openrouter' | 'mock' | 'mock_fallback',
 *   model_used: string | null,
 *   tree_quality: object
 * }>}
 */
export async function decide_action({
  instruction,
  screen_tree,
  screenshot,
  history = [],
  context = {},
  env = {},
  options = {},
}) {
  // 1. Evaluate Tree Quality to determine preferred mode (Text vs Vision)
  const treeQuality = check_tree_quality(screen_tree);
  const preferredMode = options.forced_mode || treeQuality.mode; // 'text' | 'vision'

  const mockForced = Boolean(
    options.force_mock || options.mockAction || options.mockSequence || options.simulate_loop || env?.FORCE_MOCK_AI === 'true'
  );
  const mockAllowed = mockForced || env?.ALLOW_MOCK_AI === 'true';

  let action = null;
  let engineUsed = 'mock';
  let modelUsed = null;
  let modeUsed = preferredMode;
  const failures = [];

  if (!mockForced) {
    const canGroq = Boolean(env?.GROQ_API_KEY);
    const canWorkersAI = Boolean(env?.AI) && typeof env.AI.run === 'function';
    const canVision = Boolean(env?.OPENROUTER_API_KEY) && Boolean(screenshot);
    // Text mode can run on a thin tree too, as long as there is at least one element to talk about.
    const hasElements = (elementList(screen_tree)?.length || 0) > 0 || (!elementList(screen_tree) && Boolean(screen_tree));

    const textArgs = { instruction, screen_tree, history, context, reasoningEffort: env.GROQ_REASONING_EFFORT || undefined };
    const groqPrimary = resolveGroqModel(env.GROQ_MODEL);
    const groqFallback = resolveGroqModel(env.GROQ_FALLBACK_MODEL || DEFAULT_GROQ_FALLBACK_MODEL);
    const workersModel = env.CF_AI_MODEL || DEFAULT_WORKERS_AI_MODEL;

    const textEngine = (engine, model, usable, call) => ({
      id: `${engine}:${model}`,
      mode: 'text',
      engine,
      model,
      usable: usable && hasElements,
      run: () => callWithValidation((feedback) => call({ ...textArgs, feedback, model }), screen_tree),
    });

    // Text chain: Groq 120b, then Cloudflare Workers AI 120b (separate quota), then the smaller Groq 20b.
    const textChain = [
      textEngine('groq', groqPrimary, canGroq, (a) => callGroqTextModel({ ...a, apiKey: env.GROQ_API_KEY })),
      textEngine('workers-ai', workersModel, canWorkersAI, (a) => callWorkersAITextModel({ ...a, ai: env.AI })),
      ...(groqFallback !== groqPrimary
        ? [textEngine('groq', groqFallback, canGroq, (a) => callGroqTextModel({ ...a, apiKey: env.GROQ_API_KEY }))]
        : []),
    ];
    const visionModel = env.OPENROUTER_MODEL || 'qwen/qwen-2.5-vl-72b-instruct';
    const vision = {
      id: `openrouter:${visionModel}`,
      mode: 'vision',
      engine: 'openrouter',
      model: visionModel,
      usable: canVision,
      run: () =>
        callWithValidation(
          (feedback) =>
            callOpenRouterVisionModel({
              apiKey: env.OPENROUTER_API_KEY,
              instruction,
              screenshot,
              screen_tree,
              history,
              context,
              feedback,
              model: env.OPENROUTER_MODEL || undefined,
            }),
          screen_tree
        ),
    };

    // Preferred mode first; engines that just hit a rate limit go to the back of the line, not out of it.
    const usable = (preferredMode === 'text' ? [...textChain, vision] : [vision, ...textChain]).filter((c) => c.usable);
    const candidates = [...usable.filter((c) => !isCoolingDown(c.id)), ...usable.filter((c) => isCoolingDown(c.id))];

    for (const candidate of candidates) {
      try {
        action = await candidate.run();
        engineUsed = candidate.engine;
        modelUsed = candidate.model;
        modeUsed = candidate.mode;
        if (failures.length > 0) {
          console.warn(`[AIAdapter] Answered by fallback ${candidate.engine} (${candidate.model}) after: ${failures.join(' | ')}`);
        }
        break;
      } catch (err) {
        console.warn(`[AIAdapter] ${candidate.engine} (${candidate.model}) failed:`, err.message);
        failures.push(`${candidate.engine} (${candidate.model}): ${err.message}`);
        if (err.isRateLimit) startCooldown(candidate.id, err.retryAfterMs);
      }
    }

    if (!action && !mockAllowed) {
      if (failures.length > 0) {
        throw new AIEngineError('ai_unavailable', 'ระบบ AI ตอบกลับไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', failures);
      }
      if (!canGroq && !canWorkersAI && !env?.OPENROUTER_API_KEY) {
        throw new AIEngineError(
          'ai_not_configured',
          'ระบบ AI ยังไม่ได้ตั้งค่า (ไม่มี GROQ_API_KEY / OPENROUTER_API_KEY / AI binding บนเซิร์ฟเวอร์)'
        );
      }
      throw new AIEngineError(
        'ai_no_input',
        'อ่านหน้าจอนี้ไม่ได้ (ไม่มีทั้งข้อมูล UI และภาพหน้าจอ) จึงไม่สามารถทำงานต่อได้',
        [treeQuality.reason]
      );
    }
    if (!action) engineUsed = failures.length > 0 ? 'mock_fallback' : 'mock';
  }

  if (!action) {
    action = runMockEngine({
      instruction,
      screen_tree,
      screenshot: preferredMode === 'text' ? null : screenshot,
      history,
      mode: preferredMode,
      options,
    });
    modeUsed = preferredMode;
  }

  const toolName = action.tool_name || action.action_type || 'click_element';
  const isMock = engineUsed === 'mock' || engineUsed === 'mock_fallback';
  const parameters = isMock ? action.parameters || {} : finalizeParameters(action, { engine: engineUsed, context });

  return {
    action_type: toolName,
    tool_name: toolName,
    parameters,
    element_id: action.element_id !== undefined && action.element_id !== null
      ? action.element_id
      : (parameters.element_id !== undefined ? parameters.element_id : null),
    target: action.target || parameters.target_description || parameters.text || toolName,
    target_id: action.target_id || (parameters.element_id !== undefined ? String(parameters.element_id) : null),
    coordinates: parameters.x !== undefined && parameters.y !== undefined ? { x: parameters.x, y: parameters.y } : (action.coordinates || null),
    text: action.text || parameters.text || null,
    direction: parameters.direction || action.direction || null,
    nav_action: parameters.action || action.nav_action || null,
    duration_ms: parameters.duration_ms || action.duration_ms || null,
    log_message: action.log_message || `ดำเนินการ ${toolName}`,
    is_completed: toolName === 'task_finish' || Boolean(action.is_completed),
    mode_used: modeUsed,
    engine_used: engineUsed,
    model_used: modelUsed,
    tree_quality: treeQuality,
  };
}

// Named alias
export const decideAction = decide_action;


/**
 * Adapter Class wrapper
 */
export class AIAdapter {
  constructor(env = {}) {
    this.env = env;
  }

  decide(params) {
    return decide_action({ ...params, env: this.env });
  }
}
