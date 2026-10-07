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

  // Check if node is interactive/clickable
  const isClickable =
    Boolean(node.clickable) ||
    Boolean(node.is_clickable) ||
    node.action === 'click' ||
    (Array.isArray(node.actions) && node.actions.includes('click'));

  if (isClickable) {
    stats.clickableNodes++;
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
 *
 * @param {any} screenTree - Accessibility tree hierarchy (JSON object or string)
 * @returns {{
 *   mode: 'text' | 'vision',
 *   sufficient: boolean,
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

  const root = tree.nodes || tree.root || tree.hierarchy || tree;
  const stats = {
    totalNodes: 0,
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

  // If tree has virtually no actionable elements (e.g. WebView, games, camera canvas)
  if (stats.clickableNodes === 0 && stats.textNodes === 0) {
    return {
      mode: 'vision',
      sufficient: false,
      clickableCount: stats.clickableNodes,
      clickable_nodes: stats.clickableNodes,
      textCount: stats.textNodes,
      text_elements: stats.textNodes,
      totalNodes: stats.totalNodes,
      total_nodes: stats.totalNodes,
      maxDepth: stats.maxDepth,
      depth: stats.maxDepth,
      reason: 'No clickable elements or text found in tree (likely WebView/Canvas/Game). Switching to Vision Mode.',
    };
  }

  // Sufficient semantic information for Text Mode
  return {
    mode: 'text',
    sufficient: true,
    clickableCount: stats.clickableNodes,
    clickable_nodes: stats.clickableNodes,
    textCount: stats.textNodes,
    text_elements: stats.textNodes,
    totalNodes: stats.totalNodes,
    total_nodes: stats.totalNodes,
    maxDepth: stats.maxDepth,
    depth: stats.maxDepth,
    reason: `Sufficient tree hierarchy found (${stats.clickableNodes} clickable, ${stats.textNodes} text nodes). Using Text Mode (Groq / gpt-oss-120b).`,
  };
}

// Named alias for snake_case callers
export const check_tree_quality = checkTreeQuality;
