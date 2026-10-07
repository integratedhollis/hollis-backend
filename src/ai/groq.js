/**
 * Hollis Screen Control — Groq Cloud API Connector (Text Mode)
 *
 * Connects to Groq Cloud API using OpenAI-compatible chat completions
 * targeting gpt-oss-120b with JSON mode structured output.
 */

const GROQ_COMPLETIONS_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-oss-120b';

/**
 * Compacts and formats an accessibility screen tree into a token-efficient prompt string.
 *
 * @param {any} screenTree
 * @param {number} [maxNodes=50]
 * @returns {string}
 */
export function formatTreeForPrompt(screenTree, maxNodes = 50) {
  if (!screenTree) return 'No accessibility tree provided.';

  let root = screenTree;
  if (typeof screenTree === 'string') {
    try {
      root = JSON.parse(screenTree);
    } catch {
      return screenTree.slice(0, 500);
    }
  }

  const items = [];
  const visited = new Set();

  function collect(node, depth = 0) {
    if (!node || typeof node !== 'object' || items.length >= maxNodes || depth > 64) return;
    if (visited.has(node)) return; // Cycle protection
    visited.add(node);

    const id = node.id || node.resource_id || '';
    const text = (node.text || node.content_description || node.label || '').trim();
    const cls = (node.class || node.type || '').split('.').pop();
    const clickable = Boolean(node.clickable || node.is_clickable);

    if (text || clickable || id) {
      items.push({
        id: id || undefined,
        class: cls || undefined,
        text: text || undefined,
        clickable: clickable || undefined,
        bounds: node.bounds || undefined,
      });
    }

    const children = node.children || node.nodes || node.child_nodes;
    if (Array.isArray(children)) {
      for (const child of children) {
        collect(child, depth + 1);
      }
    }
  }

  if (Array.isArray(root)) {
    for (const item of root) collect(item, 0);
  } else {
    collect(root, 0);
  }

  return JSON.stringify(items, null, 2);
}

/**
 * Calls Groq API in Text Mode with JSON structured output.
 *
 * @param {object} params
 * @param {string} params.apiKey - Groq API key
 * @param {string} params.instruction - High-level user command (e.g. "เปิด LINE แล้วส่งข้อความ...")
 * @param {any} [params.screen_tree] - Screen accessibility hierarchy
 * @param {Array} [params.history] - Array of previous steps
 * @param {string} [params.model] - Model identifier (default: gpt-oss-120b)
 * @param {number} [params.timeoutMs=15000] - Request timeout in ms
 * @returns {Promise<{
 *   action_type: string,
 *   target: string,
 *   target_id: string | null,
 *   text: string | null,
 *   log_message: string,
 *   is_completed: boolean,
 *   raw_response?: any
 * }>}
 */
export async function callGroqTextModel({
  apiKey,
  instruction,
  screen_tree,
  history = [],
  model = DEFAULT_MODEL,
  timeoutMs = 15000,
}) {
  if (!apiKey) {
    throw new Error('Groq API Key is required.');
  }

  const systemPrompt = `You are Hollis, an autonomous Android UI screen automation agent.
Your task is to examine the user instruction and the current screen accessibility hierarchy, then decide the NEXT single atomic action.

You MUST respond ONLY with a valid JSON object strictly matching this schema:
{
  "action_type": "tap" | "type_text" | "scroll_down" | "scroll_up" | "back" | "home" | "complete",
  "target": "Short human description of target element or button",
  "target_id": "resource_id or id if available, or null",
  "text": "Text to type if action_type is type_text, or null",
  "log_message": "Concise progress log message in Thai",
  "is_completed": true | false
}

Rules:
- If the user's overall goal is already fully achieved, set "action_type": "complete" and "is_completed": true.
- Otherwise, select the single most appropriate UI element to interact with next.
- Return ONLY the JSON object. Do not include markdown formatting or extra text.`;

  const formattedTree = formatTreeForPrompt(screen_tree);
  const historySummary = history.length > 0
    ? `\nPrevious steps taken:\n` + history.map((h, i) => `Step ${i + 1}: ${h.action?.action_type || h.action_type} - ${h.action?.target || h.log_message}`).join('\n')
    : '';

  const userContent = `User Goal: "${instruction}"
${historySummary}
Current Screen Accessibility Tree:
${formattedTree}

What is the next action?`;

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
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`Groq API returned HTTP ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('Groq API returned empty response content.');
    }

    let parsedAction;
    try {
      parsedAction = JSON.parse(content.trim());
    } catch {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
      if (match) {
        parsedAction = JSON.parse(match[1] ? match[1].trim() : match[0].trim());
      } else {
        throw new Error(`Failed to parse structured JSON from Groq response: ${content.slice(0, 100)}`);
      }
    }

    return {
      action_type: parsedAction.action_type || 'tap',
      target: parsedAction.target || 'target element',
      target_id: parsedAction.target_id || null,
      text: parsedAction.text || null,
      log_message: parsedAction.log_message || `ดำเนินการ ${parsedAction.action_type || 'tap'} บน ${parsedAction.target || ''}`,
      is_completed: Boolean(parsedAction.is_completed),
      raw_response: data,
    };
  } finally {
    clearTimeout(timer);
  }
}
