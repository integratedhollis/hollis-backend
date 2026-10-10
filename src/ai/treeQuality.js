/**
 * Screen Tree Quality Evaluator for Hollis Backend.
 * Analyzes Android Accessibility Node Tree hierarchy to choose between
 * Text Mode (Groq / gpt-oss-120b) and Vision Mode (OpenRouter / Qwen3-VL).
 */

/**
 * Recursively traverses accessibility tree nodes and collects metrics.
 *
 * @param {any} node
 * @param {number} depth
 * @param {{ totalNodes: number, clickableNodes: number, textNodes: number, maxDepth: number }} stats
 */
function traverseTree(node, depth, stats, visited = new Set()) {
  if (!node || typeof node !== 'object' || depth > 64 || visited.has(node)) return;
  visited.add(node);

  stats.totalNodes++;
  if (depth > stats.maxDepth) {
    stats.maxDepth = depth;
  }

  // Check if node is interactive (clickable, editable, checkable)
  const isClickable =
    Boolean(node.clickable) ||
    Boolean(node.is_clickable) ||
    node.action === 'click' ||
    (Array.isArray(node.actions) && node.actions.includes('click'));

  const isEditable =
    Boolean(node.editable) ||
    Boolean(node.is_editable) ||
    (typeof node.class === 'string' && node.class.toLowerCase().includes('edittext'));

  const isCheckable =
    Boolean(node.checkable) ||
    Boolean(node.is_checkable);

  if (isClickable || isEditable || isCheckable) {
    stats.interactiveNodes++;
    if (isClickable) stats.clickableNodes++;
  }

  // Check if node has non-empty text or content description
  const text = (node.text || node.content_description || node.hint || node.label || '').toString().trim();
  if (text.length > 0) {
    stats.textNodes++;
  }

  // Recurse into children
  const children = node.children || node.nodes || node.child_nodes;
  if (Array.isArray(children)) {
    for (const child of children) {
      traverseTree(child, depth + 1, stats, visited);
    }
  }
}

/**
 * Evaluates accessibility tree quality to determine optimal AI processing mode.
 * Per Architecture Spec (Hybrid Fallback Trigger):
 * - If interactive nodes < 2 or Canvas/SurfaceView/empty tree -> Vision Mode
 * - Otherwise (>= 2 interactive nodes or sufficient hierarchy) -> Text Mode
 *
 * @param {any} screenTree - Accessibility tree hierarchy (JSON object or string)
 * @returns {{
 *   mode: 'text' | 'vision',
 *   sufficient: boolean,
 *   interactiveCount: number,
 *   interactive_nodes: number,
 *   clickableCount: number,
 *   clickable_nodes: number,
 *   textCount: number,
 *   text_elements: number,
 *   totalNodes: number,
 *   total_nodes: number,
 *   maxDepth: number,
 *   depth: number,
 *   reason: string
 * }}
 */
export function checkTreeQuality(screenTree) {
  let tree = screenTree;
  if (typeof tree === 'string') {
    try {
      tree = JSON.parse(tree.trim());
    } catch {
      tree = null;
    }
  }

  if (!tree || typeof tree !== 'object') {
    return {
      mode: 'vision',
      sufficient: false,
      interactiveCount: 0,
      interactive_nodes: 0,
      clickableCount: 0,
      clickable_nodes: 0,
      textCount: 0,
      text_elements: 0,
      totalNodes: 0,
      total_nodes: 0,
      maxDepth: 0,
      depth: 0,
      reason: 'Screen tree is empty, null, or malformed. Switching to Vision Mode.',
    };
  }

  // Canvas / SurfaceView override detection
  const isCanvas =
    Boolean(tree.is_canvas) ||
    Boolean(tree.is_surface_view) ||
    Boolean(tree.canvas) ||
    (typeof tree.class === 'string' && (tree.class.includes('SurfaceView') || tree.class.includes('TextureView') || tree.class.includes('GLSurfaceView')));

  if (isCanvas) {
    return {
      mode: 'vision',
      sufficient: false,
      interactiveCount: 0,
      interactive_nodes: 0,
      clickableCount: 0,
      clickable_nodes: 0,
      textCount: 0,
      text_elements: 0,
      totalNodes: 1,
      total_nodes: 1,
      maxDepth: 1,
      depth: 1,
      reason: 'Screen renders Canvas or SurfaceView (e.g. Flutter Canvas/Game). Switching to Vision Mode.',
    };
  }

  const root = tree.screen_elements || tree.elements || tree.nodes || tree.root || tree.hierarchy || tree;
  const stats = {
    totalNodes: 0,
    interactiveNodes: 0,
    clickableNodes: 0,
    textNodes: 0,
    maxDepth: 0,
  };
  const visited = new Set();

  if (Array.isArray(root)) {
    for (const item of root) {
      traverseTree(item, 1, stats, visited);
    }
  } else {
    traverseTree(root, 1, stats, visited);
  }

  // Hybrid Fallback Trigger: if interactive nodes < 2 (or 0 clickable & 0 text)
  if (stats.interactiveNodes < 2 && stats.clickableNodes < 2) {
    return {
      mode: 'vision',
      sufficient: false,
      interactiveCount: stats.interactiveNodes,
      interactive_nodes: stats.interactiveNodes,
      clickableCount: stats.clickableNodes,
      clickable_nodes: stats.clickableNodes,
      textCount: stats.textNodes,
      text_elements: stats.textNodes,
      totalNodes: stats.totalNodes,
      total_nodes: stats.totalNodes,
      maxDepth: stats.maxDepth,
      depth: stats.maxDepth,
      reason: `Insufficient interactive nodes (${stats.interactiveNodes} < 2). Switching to Vision Mode per specification.`,
    };
  }

  // Sufficient semantic information for Text Mode (>= 2 interactive nodes)
  return {
    mode: 'text',
    sufficient: true,
    interactiveCount: stats.interactiveNodes,
    interactive_nodes: stats.interactiveNodes,
    clickableCount: stats.clickableNodes,
    clickable_nodes: stats.clickableNodes,
    textCount: stats.textNodes,
    text_elements: stats.textNodes,
    totalNodes: stats.totalNodes,
    total_nodes: stats.totalNodes,
    maxDepth: stats.maxDepth,
    depth: stats.maxDepth,
    reason: `Sufficient tree hierarchy found (${stats.interactiveNodes} interactive, ${stats.textNodes} text nodes). Using Text Mode (Groq / gpt-oss-120b).`,
  };
}

// Named alias for snake_case callers
export const check_tree_quality = checkTreeQuality;
