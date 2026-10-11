/**
 * Hollis Screen Control — shared prompt building for the Text (Groq) and Vision (OpenRouter) models.
 *
 * Both models get the same system rules and the same view of the world: the goal, which app is in
 * front, what is installed, what each previous step did (and whether it worked), and the current
 * screen. Keeping this in one place stops the two engines from drifting apart.
 */

/** Past steps shown in full; older ones are collapsed into one line to save tokens. */
const FULL_HISTORY_STEPS = 8;
/** Installed-app names listed in the prompt (the device sends at most a few hundred). */
const MAX_APPS_IN_PROMPT = 150;

export const SYSTEM_PROMPT = `You are Hollis, an agent that operates an Android phone for the user by calling exactly one tool per turn.

Each turn you receive: the user's goal, which app is in front, the apps installed on the phone, the outcome of every previous step, and the current screen as a numbered element list.

Element format: [id] Class "text" {desc} <hint> (traits). Traits: clickable, editable, checkable, checked, scrollable, selected, disabled.
Element ids are valid ONLY for the current screen. They are renumbered after every action, so never reuse an id from an earlier step.

RULES
1. To open an app, call open_app with the app name exactly as written in the installed-apps list. Never hunt for icons by swiping. If the app is not in the list, finish with status "failed" and say it is not installed.
2. After open_app, check "Current app" on the next turn. If it is not the app you wanted, look at the screen (a dialog, a login or a loading screen may be in front) and deal with it.
3. Read the previous-step outcomes before choosing. If a step ended in ERROR or "screen unchanged", do NOT repeat the same call. Choose a different element, scroll, go back, or tap by coordinates.
4. swipe_screen direction is the direction of the CONTENT you want to reveal: "DOWN" shows content further down the page (like scrolling down a feed), "UP" goes back toward the top, "LEFT"/"RIGHT" reveal content on that side. Only scroll when the element you need is not on screen (scrollable containers are marked "scrollable").
5. input_text needs the id of an editable element. After typing, submit with a visible search/send/enter button, then check the result.
6. If the screen is empty, loading, or mid-animation, call wait_and_poll once rather than guessing.
7. click_coordinate uses real pixels of the phone screen (the screen size is given). Use it only when the element list does not contain what you need.
8. Do exactly what the goal asks, nothing more. Do not buy, pay, send, delete or confirm anything the goal does not clearly request. Risky taps are confirmed with the user separately.
9. Call task_finish with status "success" ONLY when the current screen or current app visibly proves the goal is done. If you are not sure, take one more action that verifies it. Call task_finish with status "failed" when the goal cannot be done (login required, app missing, screen protected, repeated failures) and explain why.
10. The task_finish message must be one short sentence in Thai that states the real outcome.`;

/**
 * @param {any} tree Flat element array, or an object wrapping one (`screen_elements` / `elements`).
 * @returns {Array<object> | null} The flat element list, or null when the tree is nested/unknown.
 */
export function elementList(tree) {
  let root = tree;
  if (typeof root === 'string') {
    try {
      root = JSON.parse(root.trim());
    } catch {
      return null;
    }
  }
  if (Array.isArray(root)) return root;
  if (root && Array.isArray(root.screen_elements)) return root.screen_elements;
  if (root && Array.isArray(root.elements)) return root.elements;
  return null;
}

/** The element a tool call refers to, found by its `id` (falls back to array position). */
export function findElement(tree, id) {
  const list = elementList(tree);
  if (!list || id === undefined || id === null) return null;
  const wanted = Number(id);
  return (
    list.find((el, i) => el && typeof el === 'object' && Number(el.id !== undefined ? el.id : i) === wanted) || null
  );
}

/** Human-readable label of an element: its text, falling back to its description/hint. */
export function elementLabel(el) {
  if (!el || typeof el !== 'object') return '';
  return String(el.text || el.desc || el.content_description || el.label || el.hint || '').trim();
}

/**
 * @param {Array<{name: string, package: string}>} installedApps
 * @param {string | null | undefined} name
 * @returns {{name: string, package: string} | null} Exact (case-insensitive) label match only.
 */
export function resolveInstalledApp(installedApps, name) {
  if (!Array.isArray(installedApps) || !name) return null;
  const wanted = String(name).trim().toLowerCase();
  return installedApps.find((a) => a && String(a.name).trim().toLowerCase() === wanted) || null;
}

/** Display name for a package ("Play Store (com.android.vending)"), or just the package. */
export function describePackage(installedApps, pkg) {
  if (!pkg) return 'unknown';
  const app = Array.isArray(installedApps) ? installedApps.find((a) => a && a.package === pkg) : null;
  return app ? `${app.name} (${pkg})` : pkg;
}

function formatParams(params) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    // target_description is the model's own gloss on the element; the resolved label is clearer.
    if (k === 'target_description') continue;
    parts.push(`${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`);
  }
  return parts.join(', ');
}

/** One line per past step: what was called, what it was aimed at, whether it worked, what changed. */
function describeStep(h, installedApps) {
  const action = h.action || {};
  const tool = action.tool_name || action.action_type || 'unknown';
  const params = action.parameters || {};
  let call = `${tool}(${formatParams(params)})`;
  if (tool === 'click_element' || tool === 'input_text') {
    const label = elementLabel(findElement(h.state_before?.screen_tree, params.element_id));
    if (label) call += ` on "${label.slice(0, 60)}"`;
  } else if (tool === 'click_coordinate' && params.target_description) {
    call += ` on "${String(params.target_description).slice(0, 60)}"`;
  }

  const result = h.result || {};
  let outcome;
  if (result.status === 'error') {
    outcome = `ERROR${result.message ? `: ${String(result.message).slice(0, 160)}` : ''}`;
  } else if (result.status === 'timeout') {
    outcome = 'NO RESPONSE from the phone';
  } else {
    outcome = 'ok';
  }
  const effect = tool === 'wait_and_poll' ? '' : h.verified_changed ? '; screen changed' : '; screen unchanged';
  const where = result.package ? `; now in ${describePackage(installedApps, result.package)}` : '';
  return `${h.step_no}. ${call} -> ${outcome}${effect}${where}`;
}

/**
 * @param {Array<object>} history AgentLoop history entries
 * @param {Array<{name: string, package: string}>} installedApps
 * @returns {string}
 */
export function buildHistoryText(history, installedApps = []) {
  if (!Array.isArray(history) || history.length === 0) return 'Previous steps: none yet (this is the first step).';
  const recent = history.slice(-FULL_HISTORY_STEPS);
  const older = history.length - recent.length;
  const lines = recent.map((h) => describeStep(h, installedApps));
  const prefix = older > 0 ? `(${older} earlier steps omitted)\n` : '';
  return `Previous steps (oldest first):\n${prefix}${lines.join('\n')}`;
}

/**
 * The user-turn text shared by both engines.
 *
 * @param {object} p
 * @param {string} p.instruction
 * @param {string} p.screenText Pre-formatted element list
 * @param {Array<object>} [p.history]
 * @param {{package?: string, screen?: {w: number, h: number}, installed_apps?: Array<{name: string, package: string}>}} [p.context]
 * @param {string | null} [p.feedback] Why the previous attempt at this turn was rejected
 */
export function buildUserPrompt({ instruction, screenText, history = [], context = {}, feedback = null }) {
  const apps = Array.isArray(context.installed_apps) ? context.installed_apps : [];
  const lines = [`Goal: "${instruction}"`, ''];

  lines.push(`Current app: ${describePackage(apps, context.package)}`);
  if (context.screen?.w && context.screen?.h) {
    lines.push(`Screen size: ${context.screen.w}x${context.screen.h} px`);
  }
  if (apps.length > 0) {
    const names = [...new Set(apps.map((a) => a && a.name).filter(Boolean))].slice(0, MAX_APPS_IN_PROMPT);
    lines.push(`Installed apps: ${names.join(', ')}`);
  }
  lines.push('', buildHistoryText(history, apps), '', 'Current screen elements:', screenText, '');

  if (feedback) {
    lines.push(`Your previous answer for this turn was rejected: ${feedback}`, 'Choose a valid tool call.', '');
  }
  lines.push('Choose the next tool call.');
  return lines.join('\n');
}
