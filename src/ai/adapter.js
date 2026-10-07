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
    return {
      action_type: 'tap',
      target: 'mock target',
      is_completed: false,
      log_message: 'Executing mock action',
      ...options.mockAction,
    };
  }

  // If test provided a sequence of actions
  if (Array.isArray(options.mockSequence) && options.mockSequence[history.length]) {
    return options.mockSequence[history.length];
  }

  const stepIndex = options.stepIndex !== undefined ? options.stepIndex : history.length;
  const lowerInst = (instruction || '').toLowerCase();

  // Test scenario: Loop detection trigger
  if (options.simulate_loop || lowerInst.includes('test_loop') || lowerInst.includes('ทดสอบลูป')) {
    return {
      action_type: 'tap',
      target: 'ปุ่มติดลูปเดิม',
      target_id: 'btn_stuck_loop',
      text: null,
      log_message: 'กดปุ่มเดิมซ้ำๆ เพื่อทดสอบระบบตรวจจับลูป',
      is_completed: false,
    };
  }

  // Test scenario: Risky operations
  if (lowerInst.includes('ลบ') || lowerInst.includes('delete')) {
    if (stepIndex === 0) {
      return {
        action_type: 'tap',
        target: 'ค้นหารายการที่ต้องการลบ',
        target_id: 'btn_search',
        log_message: 'ค้นหารายการเป้าหมาย',
        is_completed: false,
      };
    }
    if (stepIndex === 1) {
      return {
        action_type: 'tap',
        target: 'ปุ่ม ยืนยันการลบ ข้อมูลถาวร',
        target_id: 'btn_confirm_delete',
        log_message: 'เตรียมลบข้อมูล (ต้องยืนยันความเสี่ยง)',
        is_completed: false,
      };
    }
    return {
      action_type: 'complete',
      target: 'เสร็จสิ้นการลบ',
      log_message: 'ลบข้อมูลสำเร็จเรียบร้อย',
      is_completed: true,
    };
  }

  if (lowerInst.includes('โอน') || lowerInst.includes('pay') || lowerInst.includes('confirm') || lowerInst.includes('ยืนยัน')) {
    if (stepIndex === 0) {
      return {
        action_type: 'tap',
        target: 'เลือกบัญชีผู้รับ',
        target_id: 'recipient_item',
        log_message: 'เลือกบัญชีเป้าหมาย',
        is_completed: false,
      };
    }
    if (stepIndex === 1) {
      return {
        action_type: 'tap',
        target: 'ปุ่ม ยืนยันการโอนเงิน',
        target_id: 'btn_transfer_confirm',
        log_message: 'กดปุ่มยืนยันการทำธุรกรรม (เสี่ยง)',
        is_completed: false,
      };
    }
    return {
      action_type: 'complete',
      target: 'โอนสำเร็จ',
      log_message: 'ทำธุรกรรมเสร็จสิ้น',
      is_completed: true,
    };
  }

  // Dynamic tree-aware mock: if tree has clickable elements, interact with them
  let targetDesc = 'เป้าหมายบนหน้าจอ';
  let targetId = null;
  if (screen_tree && typeof screen_tree === 'object') {
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
      targetDesc = node.text || node.content_description || node.label || node.id || 'ปุ่มบนหน้าจอ';
      targetId = node.id || null;
    }
  }

  // Sequential progression
  if (stepIndex === 0) {
    return {
      action_type: 'inspect_screen',
      target: targetDesc,
      target_id: targetId,
      log_message: `วิเคราะห์โครงสร้างหน้าจอ (${mode === 'text' ? 'Text Mode' : 'Vision Mode'})`,
      is_completed: false,
    };
  }

  if (stepIndex === 1) {
    return {
      action_type: 'tap',
      target: targetDesc,
      target_id: targetId,
      coordinates: mode === 'vision' ? { x: 0.5, y: 0.5 } : null,
      log_message: `กดเลือก ${targetDesc}`,
      is_completed: false,
    };
  }

  if (stepIndex === 2) {
    return {
      action_type: 'scroll_down',
      target: 'เลื่อนหน้าจอเพื่อค้นหาข้อมูลเพิ่มเติม',
      target_id: null,
      log_message: 'เลื่อนหน้าจอเพื่อค้นหาองค์ประกอบเป้าหมาย',
      is_completed: false,
    };
  }

  if (stepIndex === 3) {
    return {
      action_type: 'verify_screen',
      target: targetDesc,
      target_id: targetId,
      log_message: 'ตรวจสอบผลลัพธ์การเปลี่ยนแปลงบนหน้าจอ',
      is_completed: false,
    };
  }

  return {
    action_type: 'complete',
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
  // 1. Evaluate Tree Quality to determine preferred mode
  const treeQuality = check_tree_quality(screen_tree);
  const preferredMode = options.forced_mode || treeQuality.mode; // 'text' | 'vision'

  let action;
  let engineUsed = 'mock';

  // 2. Text Mode path
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
        action = runMockEngine({ instruction, screen_tree, screenshot, history, mode: 'text', options });
        engineUsed = 'mock_fallback';
      }
    } else {
      action = runMockEngine({ instruction, screen_tree, screenshot, history, mode: 'text', options });
      engineUsed = 'mock';
    }
  } else {
    // 3. Vision Mode path
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

  return {
    action_type: action.action_type || 'tap',
    target: action.target || 'target element',
    target_id: action.target_id || null,
    coordinates: action.coordinates || null,
    text: action.text || null,
    log_message: action.log_message || `ดำเนินการ ${action.action_type || 'tap'}`,
    is_completed: Boolean(action.is_completed),
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
