/**
 * Hollis Screen Control — Groq Cloud API Connector (Text Mode)
 *
 * Connects to Groq Cloud API using OpenAI-compatible Tool Calling (Function Calling)
 * targeting gpt-oss-120b with strict 7-tool schema per Mobile Agent Specification.
 */

import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

const GROQ_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
// Groq's id carries the vendor prefix; the bare "gpt-oss-120b" is answered with HTTP 404 model_not_found.
const DEFAULT_MODEL = 'openai/gpt-oss-120b';

/** Accepts the bare gpt-oss names (an easy slip in GROQ_MODEL) and returns the id Groq expects. */
export function resolveGroqModel(model) {
  const name = (model || '').trim();
  if (!name) return DEFAULT_MODEL;
  return /^gpt-oss-/i.test(name) ? `openai/${name}` : name;
}

/**
 * 7 Standard Tools Schema per Specification Document.
 */
export const HOLLIS_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'click_element',
      description: 'สั่งกดปุ่มหรือ View ตามรหัส element_id ที่ได้จาก UI Tree (เป็นวิธีที่มีความแม่นยำสูงสุด)',
      parameters: {
        type: 'object',
        properties: {
          element_id: { type: 'integer', description: 'รหัสตัวเลขลำดับของ Element บนหน้าจอ (0, 1, 2, ...)' },
          target_description: { type: 'string', description: 'คำอธิบายสั้นๆ ขององค์ประกอบที่กด เช่น ปุ่มส่งเงิน' },
        },
        required: ['element_id'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'click_coordinate',
      description: 'สั่งแตะพิกัดหน้าจอโดยตรง ใช้เมื่อ UI Tree มองไม่เห็น Node หรือทำงานกับ Canvas (x, y เป็นพิกเซลจริงของหน้าจอ ตามขนาดจอที่ระบุ)',
      parameters: {
        type: 'object',
        properties: {
          x: { type: 'integer', description: 'พิกัดแนวนอน X บนหน้าจอ (px)' },
          y: { type: 'integer', description: 'พิกัดแนวตั้ง Y บนหน้าจอ (px)' },
          target_description: { type: 'string', description: 'คำอธิบายตำแหน่งที่แตะ' },
        },
        required: ['x', 'y'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'input_text',
      description: 'สั่งกรอกข้อความลงในช่อง EditText โดยตรงผ่านกลไก Set Text Argument',
      parameters: {
        type: 'object',
        properties: {
          element_id: { type: 'integer', description: 'รหัสตัวเลขประจำช่องกรอกข้อความ' },
          text: { type: 'string', description: 'ข้อความที่ต้องการกรอก' },
        },
        required: ['element_id', 'text'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'swipe_screen',
      description: 'เลื่อนหน้าจอเพื่อดูเนื้อหาที่อยู่นอกจอ direction คือทิศทางของเนื้อหาที่ต้องการเห็น: DOWN = ดูเนื้อหาด้านล่างต่อ (เหมือนเลื่อนลง), UP = ย้อนกลับขึ้นด้านบน, LEFT/RIGHT = ดูเนื้อหาด้านซ้าย/ขวา',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['UP', 'DOWN', 'LEFT', 'RIGHT'], description: 'ทิศทางของเนื้อหาที่ต้องการเห็น (DOWN = เห็นเนื้อหาด้านล่าง)' },
        },
        required: ['direction'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'system_navigation',
      description: 'สั่งกดปุ่มควบคุมของระบบปฏิบัติการ เช่น กดย้อนกลับ หรือกลับหน้าโฮม',
      parameters: {
        type: 'object',
        properties: {
          action: { type: 'string', enum: ['BACK', 'HOME', 'RECENTS'], description: 'การกระทำของระบบ' },
        },
        required: ['action'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'wait_and_poll',
      description: 'สั่งหยุดรอให้หน้าจอโหลดข้อมูล แอนิเมชันเสร็จสิ้น หรือรอผลลัพธ์ของเครือข่าย',
      parameters: {
        type: 'object',
        properties: {
          duration_ms: { type: 'integer', minimum: 500, maximum: 3000, description: 'ระยะเวลาที่หยุดรอเป็นมิลลิวินาที (500-3000)' },
        },
        required: ['duration_ms'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'task_finish',
      description: 'แจ้งสิ้นสุดภารกิจ พร้อมข้อความสรุปผลลัพธ์สำหรับแจ้งผู้ใช้ผ่านหน้าจอหรือเสียง',
      parameters: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['success', 'failed'], description: 'สถานะความสำเร็จของภารกิจ' },
          message: { type: 'string', description: 'ข้อความสรุปผลลัพธ์ภาษาไทยแจ้งผู้ใช้' },
        },
        required: ['status', 'message'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'open_app',
      description: 'สั่งเปิดแอปพลิเคชันบนอุปกรณ์ Android ผ่าน Launch Intent หรือ Package Manager เช่น LINE, YouTube, Shopee, Settings เพื่อความรวดเร็วและแม่นยำแทนการสไลด์หาไอคอนบนหน้าจอหลัก',
      parameters: {
        type: 'object',
        properties: {
          app_name: { type: 'string', description: 'ชื่อแอปพลิเคชันที่ต้องการเปิด เช่น "LINE", "YouTube", "Shopee", "Settings"' },
          package_name: { type: 'string', description: 'ชื่อ Android Package Name (ถ้าทราบ) เช่น "jp.naver.line.android", "com.google.android.youtube"' },
        },
        required: ['app_name'],
      },
    },
  },
];

/**
 * Formats pruned accessibility elements into a token-efficient One-line String format per Specification.
 * Example output:
 * [0] Button "ส่งเงิน" (clickable)
 * [1] EditText "ค้นหาเพื่อน" (editable)
 *
 * @param {any} screenTree - Accessibility tree or pruned element array
 * @param {number} [maxNodes=60]
 * @returns {string}
 */
export function formatElementsToOneLine(screenTree, maxNodes = 60) {
  if (!screenTree) return 'No accessibility elements provided.';

  let root = screenTree;
  if (typeof screenTree === 'string') {
    try {
      root = JSON.parse(screenTree.trim());
    } catch {
      return screenTree.slice(0, 500);
    }
  }

  // If already an array of pruned elements (e.g. from Frontend Semantic Pruning)
  const elementList = Array.isArray(root)
    ? root
    : Array.isArray(root.screen_elements)
      ? root.screen_elements
      : Array.isArray(root.elements)
        ? root.elements
        : null;

  if (elementList) {
    const lines = [];
    for (let i = 0; i < Math.min(elementList.length, maxNodes); i++) {
      const el = elementList[i];
      if (!el || typeof el !== 'object') continue;
      const id = el.id !== undefined ? el.id : i;
      const type = (el.class || el.type || 'View').split('.').pop();
      const text = String(el.text || el.content_description || el.label || '').trim();
      const desc = String(el.desc || '').trim();
      const hint = String(el.hint || '').trim();
      const traits = [];
      if (el.clickable || el.is_clickable) traits.push('clickable');
      if (el.editable || el.is_editable || type.toLowerCase().includes('edittext')) traits.push('editable');
      if (el.checkable || el.is_checkable) traits.push('checkable');
      if (el.checked) traits.push('checked');
      if (el.scrollable) traits.push('scrollable');
      if (el.selected) traits.push('selected');
      if (el.enabled === false) traits.push('disabled');

      const traitStr = traits.length > 0 ? ` (${traits.join(', ')})` : '';
      const textStr = text ? ` "${text}"` : '';
      const descStr = desc && desc !== text ? ` {${desc}}` : '';
      const hintStr = hint && hint !== text ? ` <${hint}>` : '';
      lines.push(`[${id}] ${type}${textStr}${descStr}${hintStr}${traitStr}`);
    }
    return lines.length > 0 ? lines.join('\n') : 'Empty element tree';
  }

  // Recursive tree traversal fallback for nested trees
  const items = [];
  const visited = new Set();
  let counter = 0;

  function collect(node, depth = 0) {
    if (!node || typeof node !== 'object' || items.length >= maxNodes || depth > 64) return;
    if (visited.has(node)) return;
    visited.add(node);

    const text = (node.text || node.content_description || node.label || node.hint || '').trim();
    const cls = (node.class || node.type || 'View').split('.').pop();
    const isClickable = Boolean(node.clickable || node.is_clickable);
    const isEditable = Boolean(node.editable || node.is_editable || cls.toLowerCase().includes('edittext'));

    if (text || isClickable || isEditable || node.id !== undefined) {
      const id = node.id !== undefined ? node.id : counter++;
      const traits = [];
      if (isClickable) traits.push('clickable');
      if (isEditable) traits.push('editable');
      const traitStr = traits.length > 0 ? ` (${traits.join(', ')})` : '';
      const textStr = text ? ` "${text}"` : '';
      items.push(`[${id}] ${cls}${textStr}${traitStr}`);
    }

    const children = node.children || node.nodes || node.child_nodes;
    if (Array.isArray(children)) {
      for (const child of children) {
        collect(child, depth + 1);
      }
    }
  }

  const treeRoot = root.nodes || root.root || root.hierarchy || root;
  if (Array.isArray(treeRoot)) {
    for (const item of treeRoot) collect(item, 0);
  } else {
    collect(treeRoot, 0);
  }

  return items.length > 0 ? items.join('\n') : 'Empty accessibility hierarchy';
}

// Named alias
export const formatTreeForPrompt = formatElementsToOneLine;

/**
 * Normalizes tool call result into standard action object.
 *
 * @param {string} toolName
 * @param {object} args
 * @param {any} [rawResponse]
 * @returns {object}
 */
export function normalizeToolAction(toolName, args, rawResponse = null) {
  let logMessage = '';
  let isCompleted = false;

  switch (toolName) {
    case 'click_element':
      logMessage = `กดปุ่มหรือโหนด ID [${args.element_id}]${args.target_description ? ' (' + args.target_description + ')' : ''}`;
      break;
    case 'click_coordinate':
      logMessage = `แตะพิกัดหน้าจอ (${args.x}, ${args.y})${args.target_description ? ' (' + args.target_description + ')' : ''}`;
      break;
    case 'input_text':
      logMessage = `พิมพ์ข้อความ "${args.text}" ลงในช่อง [${args.element_id}]`;
      break;
    case 'swipe_screen':
      logMessage = `เลื่อนหน้าจอไปทาง ${args.direction}`;
      break;
    case 'system_navigation':
      logMessage = `กดปุ่มระบบ ${args.action}`;
      break;
    case 'wait_and_poll':
      logMessage = `หยุดรอหน้าจอ ${args.duration_ms} ms`;
      break;
    case 'task_finish':
      logMessage = args.message || (args.status === 'success' ? 'ภารกิจเสร็จสมบูรณ์เรียบร้อย' : 'ภารกิจสิ้นสุด');
      isCompleted = true;
      break;
    case 'open_app':
      logMessage = `เปิดแอปพลิเคชัน ${args.app_name}${args.package_name ? ' (' + args.package_name + ')' : ''}`;
      break;
    default:
      logMessage = `เรียกใช้เครื่องมือ ${toolName}`;
  }

  return {
    action_type: toolName,
    tool_name: toolName,
    parameters: args,
    app_name: args.app_name || null,
    package_name: args.package_name || null,
    element_id: args.element_id !== undefined ? args.element_id : null,
    target: args.app_name ? `เปิดแอป ${args.app_name}` : (args.target_description || args.text || (args.element_id !== undefined ? `Element [${args.element_id}]` : toolName)),
    target_id: args.element_id !== undefined ? String(args.element_id) : null,
    coordinates: args.x !== undefined && args.y !== undefined ? { x: args.x, y: args.y } : null,
    text: args.text || null,
    direction: args.direction || null,
    nav_action: args.action || null,
    duration_ms: args.duration_ms || null,
    log_message: logMessage,
    is_completed: isCompleted,
    raw_response: rawResponse,
  };
}

/**
 * Executes a single completion request to Groq API with Tool Calling.
 */
async function executeGroqRequest({ apiKey, model, messages, temperature = 0.1, timeoutMs = 15000, reasoningEffort = null }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(GROQ_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages,
        tools: HOLLIS_TOOLS,
        tool_choice: 'required',
        temperature,
        // gpt-oss only: bounds how long the model thinks before answering.
        ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Groq API returned HTTP ${res.status}: ${errorText}`);
    }

    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Calls Groq API in Text Mode with strict Tool Calling and Validation Retry Guard.
 *
 * @param {object} params
 * @param {string} params.apiKey - Groq API key
 * @param {string} params.instruction - User command
 * @param {any} [params.screen_tree] - Screen accessibility elements
 * @param {Array} [params.history] - Array of previous steps
 * @param {string} [params.model] - Model identifier (default: openai/gpt-oss-120b)
 * @param {number} [params.timeoutMs=15000] - Request timeout in ms
 * @returns {Promise<object>} Normalized Action Object
 */
export async function callGroqTextModel({
  apiKey,
  instruction,
  screen_tree,
  history = [],
  context = {},
  feedback = null,
  model = DEFAULT_MODEL,
  reasoningEffort = 'medium',
  timeoutMs = 15000,
}) {
  if (!apiKey) {
    throw new Error('Groq API Key is required.');
  }
  model = resolveGroqModel(model);

  const userContent = buildUserPrompt({
    instruction,
    screenText: formatElementsToOneLine(screen_tree),
    history,
    context,
    feedback,
  });

  // Only gpt-oss models accept reasoning_effort; other models would reject the request.
  const effort = /gpt-oss/i.test(model) ? reasoningEffort : null;

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  // Attempt 1 with temperature 0.1
  let data;
  let toolCall = null;
  let parsedArgs = null;

  try {
    data = await executeGroqRequest({ apiKey, model, messages, temperature: 0.1, timeoutMs, reasoningEffort: effort });
    const choice = data.choices?.[0];
    const message = choice?.message;

    if (message?.tool_calls && message.tool_calls.length > 0) {
      toolCall = message.tool_calls[0].function;
      parsedArgs = JSON.parse(toolCall.arguments || '{}');
    }
  } catch (err) {
    // Validation Guard: Retry 1 time immediately with temperature 0.0 per specification
    console.warn('[Groq] Attempt 1 failed or invalid tool call, retrying with temperature 0.0:', err.message);
  }

  // If Attempt 1 failed or yielded no tool call -> Retry 1 time at temperature 0.0
  if (!toolCall || !parsedArgs) {
    try {
      data = await executeGroqRequest({ apiKey, model, messages, temperature: 0.0, timeoutMs, reasoningEffort: effort });
      const choice = data.choices?.[0];
      const message = choice?.message;

      if (message?.tool_calls && message.tool_calls.length > 0) {
        toolCall = message.tool_calls[0].function;
        parsedArgs = JSON.parse(toolCall.arguments || '{}');
      } else if (message?.content) {
        // Fallback: check if model returned JSON in content
        const match = message.content.match(/\{[\s\S]*\}/);
        if (match) {
          const parsed = JSON.parse(match[0]);
          const name = parsed.tool_name || parsed.action_type || 'click_element';
          return normalizeToolAction(name, parsed, data);
        }
      }
    } catch (retryErr) {
      throw new Error(`Groq Tool Calling failed after temperature 0.0 retry: ${retryErr.message}`);
    }
  }

  if (!toolCall || !parsedArgs) {
    throw new Error('Groq model failed to return a valid tool call after retry.');
  }

  return normalizeToolAction(toolCall.name, parsedArgs, data);
}

