/**
 * Hollis Screen Control — OpenRouter API Connector (Vision Mode)
 *
 * Connects to OpenRouter API targeting Qwen3-VL (or Qwen-2.5-VL)
 * accepting screenshot images in Base64 format when the accessibility tree is insufficient.
 */

const OPENROUTER_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';
const DEFAULT_VISION_MODEL = 'qwen/qwen-2.5-vl-72b-instruct';

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

/**
 * Calls OpenRouter Vision Model with image and instruction.
 *
 * @param {object} params
 * @param {string} params.apiKey - OpenRouter API key
 * @param {string} params.instruction - User command
 * @param {string} params.screenshot - Base64 encoded screenshot
 * @param {any} [params.screen_tree] - Optional partial accessibility tree
 * @param {Array} [params.history] - Action history
 * @param {string} [params.model] - Model name (default: qwen/qwen-2.5-vl-72b-instruct)
 * @param {number} [params.timeoutMs=20000] - Request timeout in ms
 * @returns {Promise<{
 *   action_type: string,
 *   target: string,
 *   coordinates: { x: number, y: number } | null,
 *   text: string | null,
 *   log_message: string,
 *   is_completed: boolean,
 *   raw_response?: any
 * }>}
 */
export async function callOpenRouterVisionModel({
  apiKey,
  instruction,
  screenshot,
  screen_tree,
  history = [],
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

  const systemPrompt = `You are Hollis, an Android UI Screen Automation Vision Agent.
You inspect the current screen screenshot and user instruction to identify UI controls and select the NEXT action.

You MUST respond ONLY with a valid JSON object strictly matching this schema:
{
  "action_type": "tap" | "type_text" | "scroll_down" | "scroll_up" | "back" | "home" | "complete",
  "target": "Visual description of the target UI element or button",
  "coordinates": { "x": 0.5, "y": 0.5 },
  "text": "Text to type if action_type is type_text, or null",
  "log_message": "Concise log message in Thai",
  "is_completed": true | false
}

Coordinates are normalized between 0.0 and 1.0 (x: horizontal fraction, y: vertical fraction).
If the user's task is already complete on screen, return "action_type": "complete" and "is_completed": true.
Do NOT enclose output in Markdown code fences; return raw JSON only.`;

  const historySummary = history.length > 0
    ? `\nPrevious actions taken:\n` + history.map((h, i) => `Step ${i + 1}: ${h.action?.action_type || h.action_type} - ${h.action?.target || h.log_message}`).join('\n')
    : '';

  const promptText = `User Goal: "${instruction}"
${historySummary}
Analyze the attached screen screenshot and return the next action JSON.`;

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

    let parsedAction;
    try {
      parsedAction = JSON.parse(content.trim());
    } catch {
      const match = content.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || content.match(/\{[\s\S]*\}/);
      if (match) {
        parsedAction = JSON.parse(match[1] ? match[1].trim() : match[0].trim());
      } else {
        throw new Error(`Failed to parse structured JSON from OpenRouter response: ${content.slice(0, 100)}`);
      }
    }

    return {
      action_type: parsedAction.action_type || 'tap',
      target: parsedAction.target || 'target element from vision',
      coordinates: parsedAction.coordinates || null,
      text: parsedAction.text || null,
      log_message: parsedAction.log_message || `ตรวจพบและดำเนินการ ${parsedAction.action_type || 'tap'} บน ${parsedAction.target || ''}`,
      is_completed: Boolean(parsedAction.is_completed),
      raw_response: data,
    };
  } finally {
    clearTimeout(timer);
  }
}
