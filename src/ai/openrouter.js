/**
 * Hollis Screen Control — OpenRouter API Connector (Vision Mode)
 *
 * Connects to OpenRouter API targeting Qwen3-VL (or Qwen-2.5-VL), used when the accessibility
 * tree is too thin to act on. The model sees the screenshot plus whatever elements were readable
 * and answers with the SAME 8 tools as Text Mode, so every engine speaks one protocol.
 */

import { HOLLIS_TOOLS, formatElementsToOneLine, normalizeToolAction } from './groq.js';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';

const OPENROUTER_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_VISION_MODEL = 'qwen/qwen-2.5-vl-72b-instruct';

const TOOL_NAMES = HOLLIS_TOOLS.map((t) => t.function.name);

/**
 * Normalizes image input to a valid Base64 Data URL.
 * @param {string} screenshot
 * @returns {string}
 */
function normalizeImageUrl(screenshot) {
  if (!screenshot || typeof screenshot !== 'string') return '';
  const trimmed = screenshot.trim();
  if (trimmed.startsWith('data:image/')) {
    return trimmed;
  }
  // Assume jpeg/png base64 payload
  return `data:image/jpeg;base64,${trimmed}`;
}

/** One line per tool: name(param: type) — what it does. The vision model has no tool-calling schema. */
function describeToolsForPrompt() {
  return HOLLIS_TOOLS.map((t) => {
    const { name, description, parameters } = t.function;
    const required = new Set(parameters.required || []);
    const args = Object.entries(parameters.properties || {})
      .map(([k, v]) => {
        const kind = v.enum ? v.enum.join('|') : v.type;
        return `${k}${required.has(k) ? '' : '?'}: ${kind}`;
      })
      .join(', ');
    return `- ${name}(${args}) — ${description}`;
  }).join('\n');
}

/** Pulls the first JSON object out of a model reply (plain, fenced, or surrounded by prose). */
function parseJsonReply(content) {
  const text = content.trim();
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    const braces = text.match(/\{[\s\S]*\}/);
    const candidate = fenced ? fenced[1] : braces ? braces[0] : null;
    if (!candidate) {
      throw new Error(`Failed to parse structured JSON from OpenRouter response: ${text.slice(0, 100)}`);
    }
    return JSON.parse(candidate.trim());
  }
}

/**
 * Calls the OpenRouter vision model with the screenshot and returns a normalized tool action.
 *
 * `click_coordinate` x/y are returned exactly as the model gave them: fractions of the screenshot
 * (0.0–1.0). The caller converts them to device pixels, because only it knows the screen size.
 *
 * @param {object} params
 * @param {string} params.apiKey - OpenRouter API key
 * @param {string} params.instruction - User command
 * @param {string} params.screenshot - Base64 encoded screenshot
 * @param {any} [params.screen_tree] - Whatever elements were readable (may be empty)
 * @param {Array} [params.history] - AgentLoop history
 * @param {object} [params.context] - { package, screen, installed_apps }
 * @param {string | null} [params.feedback] - Why the previous attempt this turn was rejected
 * @param {string} [params.model] - Model name (default: qwen/qwen-2.5-vl-72b-instruct)
 * @param {number} [params.timeoutMs=20000] - Request timeout in ms
 * @returns {Promise<object>} Normalized action (see normalizeToolAction)
 */
export async function callOpenRouterVisionModel({
  apiKey,
  instruction,
  screenshot,
  screen_tree,
  history = [],
  context = {},
  feedback = null,
  model = DEFAULT_VISION_MODEL,
  timeoutMs = 20000,
}) {
  if (!apiKey) {
    throw new Error('OpenRouter API Key is required.');
  }

  if (!screenshot) {
    throw new Error('Screenshot image is required for Vision Mode.');
  }

  const imageUrl = normalizeImageUrl(screenshot);

  const systemPrompt = `${SYSTEM_PROMPT}

You are looking at a SCREENSHOT of the phone, because the accessibility element list is too thin to act on alone.
Available tools:
${describeToolsForPrompt()}

Reply with ONLY one raw JSON object (no markdown, no prose):
{"tool_name": "<tool>", "parameters": { ... }, "log_message": "<short Thai sentence describing this step>"}
For click_coordinate, give x and y as FRACTIONS of the screenshot, each between 0.0 and 1.0 (x=0.5, y=0.5 is the centre), not pixels.`;

  const promptText = `${buildUserPrompt({
    instruction,
    screenText: formatElementsToOneLine(screen_tree, undefined, context?.screen),
    history,
    context,
    feedback,
  })}\n\nThe screenshot of the current screen is attached.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    {
      role: 'user',
      content: [
        { type: 'text', text: promptText },
        { type: 'image_url', image_url: { url: imageUrl } },
      ],
    },
  ];

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(OPENROUTER_COMPLETIONS_URL, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://hollis.app',
        'X-Title': 'Hollis Screen Control Vision Agent',
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.1,
      }),
      signal: controller.signal,
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw new Error(`OpenRouter API returned HTTP ${res.status}: ${errorText}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content;
    if (!content) {
      throw new Error('OpenRouter API returned empty response content.');
    }

    const parsed = parseJsonReply(content);
    const toolName = parsed.tool_name || parsed.action_type;
    if (!TOOL_NAMES.includes(toolName)) {
      throw new Error(`OpenRouter model chose an unknown tool: ${JSON.stringify(toolName)}`);
    }
    const params = parsed.parameters && typeof parsed.parameters === 'object' ? { ...parsed.parameters } : {};

    const action = normalizeToolAction(toolName, params, data);
    if (parsed.log_message && toolName !== 'task_finish') {
      action.log_message = String(parsed.log_message);
    }
    return action;
  } finally {
    clearTimeout(timer);
  }
}
