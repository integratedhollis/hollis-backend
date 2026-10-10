/**
 * Hollis Screen Control — Pluggable Unified AI Adapter
 *
 * Automatically chooses between Text Mode (Groq / gpt-oss-120b) and Vision Mode (OpenRouter / Qwen3-VL)
 * based on Accessibility Tree Quality evaluation.
 *
 * Defaults to intelligent Mock Engine for deterministic, offline, and local test execution
 * when API keys are not supplied.
 */

import { check_tree_quality } from './treeQuality.js';
import { callGroqTextModel } from './groq.js';
import { callOpenRouterVisionModel } from './openrouter.js';

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

/**
 * Unified Decision Engine: decides next action by evaluating tree quality,
 * selecting the optimal model (Text vs Vision), and executing via live API or mock engine.
 *
 * @param {object} params
 * @param {string} params.instruction - User command
 * @param {any} [params.screen_tree] - Screen accessibility hierarchy
 * @param {string} [params.screenshot] - Screen image Base64
 * @param {Array} [params.history] - Array of past step records
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
 *   engine_used: 'groq' | 'openrouter' | 'mock' | 'mock_fallback',
 *   tree_quality: object
 * }>}
 */
export async function decide_action({
  instruction,
  screen_tree,
  screenshot,
  history = [],
  env = {},
  options = {},
}) {
  // 1. Evaluate Tree Quality to determine preferred mode (Text vs Vision)
  const treeQuality = check_tree_quality(screen_tree);
  const preferredMode = options.forced_mode || treeQuality.mode; // 'text' | 'vision'

  let action;
  let engineUsed = 'mock';

  // 2. Text Mode path (DO NOT pass screenshot image to minimize token latency)
  if (preferredMode === 'text') {
    if (env && env.GROQ_API_KEY && !options.force_mock) {
      try {
        action = await callGroqTextModel({
          apiKey: env.GROQ_API_KEY,
          instruction,
          screen_tree,
          history,
          model: env.GROQ_MODEL,
        });
        engineUsed = 'groq';
      } catch (err) {
        console.warn('[AIAdapter] Groq API call failed, falling back to mock:', err.message);
        action = runMockEngine({ instruction, screen_tree, screenshot: null, history, mode: 'text', options });
        engineUsed = 'mock_fallback';
      }
    } else {
      action = runMockEngine({ instruction, screen_tree, screenshot: null, history, mode: 'text', options });
      engineUsed = 'mock';
    }
  } else {
    // 3. Vision Mode path (Send screenshot only on fallback turns)
    if (env && env.OPENROUTER_API_KEY && screenshot && !options.force_mock) {
      try {
        action = await callOpenRouterVisionModel({
          apiKey: env.OPENROUTER_API_KEY,
          instruction,
          screenshot,
          screen_tree,
          history,
          model: env.OPENROUTER_MODEL,
        });
        engineUsed = 'openrouter';
      } catch (err) {
        console.warn('[AIAdapter] OpenRouter API call failed, falling back to mock:', err.message);
        action = runMockEngine({ instruction, screen_tree, screenshot, history, mode: 'vision', options });
        engineUsed = 'mock_fallback';
      }
    } else {
      action = runMockEngine({ instruction, screen_tree, screenshot, history, mode: 'vision', options });
      engineUsed = 'mock';
    }
  }

  const toolName = action.tool_name || action.action_type || 'click_element';
  const parameters = action.parameters || {};

  return {
    action_type: toolName,
    tool_name: toolName,
    parameters,
    element_id: action.element_id !== undefined ? action.element_id : (parameters.element_id !== undefined ? parameters.element_id : null),
    target: action.target || parameters.target_description || parameters.text || toolName,
    target_id: action.target_id || (parameters.element_id !== undefined ? String(parameters.element_id) : null),
    coordinates: action.coordinates || (parameters.x !== undefined && parameters.y !== undefined ? { x: parameters.x, y: parameters.y } : null),
    text: action.text || parameters.text || null,
    direction: action.direction || parameters.direction || null,
    nav_action: action.nav_action || parameters.action || null,
    duration_ms: action.duration_ms || parameters.duration_ms || null,
    log_message: action.log_message || `ดำเนินการ ${toolName}`,
    is_completed: toolName === 'task_finish' || Boolean(action.is_completed),
    mode_used: preferredMode,
    engine_used: engineUsed,
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
