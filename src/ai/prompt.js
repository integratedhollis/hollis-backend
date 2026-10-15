/**
 * Hollis Screen Control — shared prompt building for the Text (Groq / Workers AI) and Vision (OpenRouter) models.
 *
 * Both models get the same system rules and the same view of the world: the goal, which app is in
 * front, what is installed, what each previous step really did (which element it hit, whether it
 * worked, what the screen shows now), and the current screen. Keeping this in one place stops the
 * engines from drifting apart.
 */

/** Past steps shown in full; older ones are collapsed into one line to save tokens. */
const FULL_HISTORY_STEPS = 8;
/** Only the most recent steps spell out what the screen looks like afterwards. */
const SCREEN_SUMMARY_STEPS = 3;
/** Installed-app names listed in the prompt (the device sends at most a few hundred). */
const MAX_APPS_IN_PROMPT = 150;

export const SYSTEM_PROMPT = `You are Hollis, an agent that operates an Android phone for the user by calling exactly one tool per turn.

Each turn you receive: the user's goal, which app is in front, the apps installed on the phone, what every previous step actually did, and the current screen as a numbered element list.

Element format: [id] Class "label" {desc} <hint> #resource_id @position (traits).
- "label" is the text on the element. A button is named after the text inside it, so [12] View "Search apps & games" (clickable) IS the search bar: tap that id, not a separate label next to it.
- An element without a label is an icon or a bare area. Judge it by its #resource_id and @position (rows: top, upper, middle, lower, bottom; columns: left, center, right). A back arrow sits top-left; a tab bar sits at the bottom; a search field is normally near the top.
- Traits: clickable, editable, checkable, checked, scrollable, selected, disabled.
Element ids are valid ONLY for the current screen. They are renumbered after every action, so never reuse an id from an earlier step.

RULES
1. To open an app, call open_app with the app name exactly as written in the installed-apps list. Never hunt for icons by swiping. If the app is not in the list, finish with status "failed" and say it is not installed.
2. After open_app, check "Current app" on the next turn. If it is not the app you wanted, look at the screen (a dialog, a login or a loading screen may be in front) and deal with it.
3. Read the previous-step outcomes before choosing. If a step ended in ERROR or "screen unchanged", do NOT repeat the same call. Choose a different element, scroll, go back, or tap by coordinates.
4. Previous steps tell you which element each tap really hit and what the screen shows afterwards. If a step says you are back on an earlier screen, or the screen shows something you did not intend, that tap hit the wrong element: do not repeat it, pick a different one.
5. click_element: set element_label to the label of the element you chose, copied exactly from the list ("" if it has none). Choose carefully between elements with similar labels (for example a "Search" tab at the bottom versus a search field at the top) by using their @position.
6. swipe_screen direction is the direction of the CONTENT you want to reveal: "DOWN" shows content further down the page (like scrolling down a feed), "UP" goes back toward the top, "LEFT"/"RIGHT" reveal content on that side. Only scroll when the element you need is not on screen (scrollable containers are marked "scrollable").
7. input_text needs the id of an editable element. If that field already shows the text you need, do not type it again. Typing is not the same as doing the task: submit it with a visible search/send/enter button or a suggestion row, then check that the result is on screen.
8. If the screen is empty, loading, or mid-animation, call wait_and_poll once rather than guessing.
9. click_coordinate uses real pixels of the phone screen (the screen size is given). Use it only when the element list does not contain what you need.
10. Do exactly what the goal asks, nothing more. Do not buy, pay, send, delete or confirm anything the goal does not clearly request. Risky taps are confirmed with the user separately.
11. Call task_finish with status "success" ONLY when the current screen or current app visibly proves the goal is done (for a search: the results are showing, not just the typed query or a suggestion list). If you are not sure, take one more action that verifies it. Call task_finish with status "failed" when the goal cannot be done (login required, app missing, screen protected, repeated failures) and explain why.
12. The task_finish message must be one short sentence in Thai that states the real outcome.`;

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

const POSITION_ROWS = ['top', 'upper', 'middle', 'lower', 'bottom'];

/**
 * Coarse place of an element on the screen ("top-left", "bottom-center", "upper full-width"), which is
 * what tells a tab bar from a search field when several elements share a name.
 *
 * @param {{ bounds?: number[] }} el `bounds` = [left, top, right, bottom] in screen pixels
 * @param {{ w: number, h: number } | null | undefined} screen
 * @returns {string} '' when bounds or screen size are unknown
 */
export function positionWord(el, screen) {
  const b = el?.bounds;
  if (!Array.isArray(b) || b.length !== 4 || !(screen?.w > 0) || !(screen?.h > 0)) return '';
  const [l, t, r, bottom] = b.map(Number);
  if (![l, t, r, bottom].every(Number.isFinite)) return '';
  const cx = (l + r) / 2 / screen.w;
  const cy = (t + bottom) / 2 / screen.h;
  const row = POSITION_ROWS[Math.min(4, Math.max(0, Math.floor(cy * 5)))];
  if ((r - l) / screen.w > 0.8) return `${row} full-width`;
  return `${row}-${cx < 0.33 ? 'left' : cx < 0.67 ? 'center' : 'right'}`;
}

/** Lower-cases, drops punctuation/quotes and collapses spaces so labels can be compared loosely. */
function normalizeLabel(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[…"'`“”‘’.,:;!?()[\]{}<>·|/\\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Whether the label the model copied agrees with the element's real label. Containment in either
 * direction counts, so a partly copied or truncated label still passes; only a different element fails.
 */
export function labelsMatch(claimed, actual) {
  const a = normalizeLabel(claimed);
  const b = normalizeLabel(actual);
  if (!a || !b) return false;
  return a === b || a.includes(b) || b.includes(a);
}

/** "Back" / "an unlabeled element #navigate_up @top-left": what the tool call really targets. */
export function describeElement(el, screen) {
  if (!el) return '';
  const label = elementLabel(el);
  const parts = [label ? `"${label.slice(0, 60)}"` : 'an unlabeled element'];
  if (el.vid) parts.push(`#${el.vid}`);
  const pos = positionWord(el, screen);
  if (pos) parts.push(`@${pos}`);
  return parts.join(' ');
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

/** Content fingerprint of a screen, used to notice when a tap brought us back to a screen we already saw. */
export function screenSignature(tree) {
  const list = elementList(tree);
  if (!list || list.length === 0) return null;
  return list
    .map((el) => `${el?.class || ''}|${el?.text || ''}|${el?.desc || ''}|${el?.checked ? 1 : 0}${el?.selected ? 1 : 0}`)
    .join('\n');
}

/** The first few labels on a screen, in tree order: enough for the model to recognise where it landed. */
export function summarizeScreen(tree, max = 6) {
  const list = elementList(tree);
  if (!list) return '';
  const seen = new Set();
  const labels = [];
  for (const el of list) {
    const label = elementLabel(el);
    if (!label || seen.has(label)) continue;
    seen.add(label);
    labels.push(`"${label.length > 32 ? `${label.slice(0, 32)}…` : label}"`);
    if (labels.length >= max) break;
  }
  return labels.join(', ');
}

function formatParams(params, { hideElementId = false } = {}) {
  if (!params || typeof params !== 'object') return '';
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    // The target's real label is shown separately; these two are the model's own words about it.
    if (k === 'target_description' || k === 'element_label') continue;
    // Ids are renumbered on every screen, so an old id would only invite "that id failed, avoid it".
    if (k === 'element_id' && hideElementId) continue;
    parts.push(`${k}=${typeof v === 'string' ? JSON.stringify(v) : v}`);
  }
  return parts.join(', ');
}

/**
 * One line per past step: what was called, which element it REALLY hit (versus what was intended),
 * whether it worked, and what the screen looks like afterwards.
 */
function describeStep(h, { installedApps, screen, returnedTo, showScreen }) {
  const action = h.action || {};
  const tool = action.tool_name || action.action_type || 'unknown';
  const params = action.parameters || {};
  const target =
    tool === 'click_element' || tool === 'input_text'
      ? describeElement(findElement(h.state_before?.screen_tree, params.element_id), screen)
      : '';
  let call = `${tool}(${formatParams(params, { hideElementId: Boolean(target) })})`;
  if (target) call += ` on ${target}`;
  const intent = params.target_description || (tool === 'click_element' ? params.element_label : '');
  if (intent && (tool === 'click_element' || tool === 'click_coordinate' || tool === 'input_text')) {
    call += ` (you meant: "${String(intent).slice(0, 60)}")`;
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

  let effect = '';
  if (tool !== 'wait_and_poll') {
    effect = h.verified_changed ? '; screen changed' : '; screen unchanged';
  }
  if (returnedTo) effect += `; back on the SAME screen as before step ${returnedTo}`;
  const where = result.package ? `; now in ${describePackage(installedApps, result.package)}` : '';
  const shows = showScreen && h.verified_changed ? summarizeScreen(h.state_after?.screen_tree) : '';
  return `${h.step_no}. ${call} -> ${outcome}${effect}${where}${shows ? `; screen now shows: ${shows}` : ''}`;
}

/**
 * @param {Array<object>} history AgentLoop history entries
 * @param {{ installed_apps?: Array<{name: string, package: string}>, screen?: {w: number, h: number} }} [context]
 * @returns {string}
 */
export function buildHistoryText(history, context = {}) {
  if (!Array.isArray(history) || history.length === 0) return 'Previous steps: none yet (this is the first step).';
  const installedApps = Array.isArray(context.installed_apps) ? context.installed_apps : [];

  // The first step that started from each screen, to spot a tap that brought us back to one of them.
  const firstSeenAt = new Map();
  const returned = new Map();
  for (const h of history) {
    const before = screenSignature(h.state_before?.screen_tree);
    if (before && !firstSeenAt.has(before)) firstSeenAt.set(before, h.step_no);
    const after = screenSignature(h.state_after?.screen_tree);
    if (h.verified_changed && after && firstSeenAt.has(after) && firstSeenAt.get(after) !== h.step_no) {
      returned.set(h.step_no, firstSeenAt.get(after));
    }
  }

  const recent = history.slice(-FULL_HISTORY_STEPS);
  const older = history.length - recent.length;
  const lines = recent.map((h) =>
    describeStep(h, {
      installedApps,
      screen: context.screen,
      returnedTo: returned.get(h.step_no),
      showScreen: history.length - history.indexOf(h) <= SCREEN_SUMMARY_STEPS,
    })
  );
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
  lines.push('', buildHistoryText(history, context), '', 'Current screen elements:', screenText, '');

  if (feedback) {
    lines.push(`Your previous answer for this turn was rejected: ${feedback}`, 'Choose a valid tool call.', '');
  }
  lines.push('Choose the next tool call.');
  return lines.join('\n');
}
