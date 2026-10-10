/**
 * Hollis Screen Control — Structural Diff Engine
 *
 * Computes structural differences between pre-action and post-action screen states
 * (DOM/Accessibility node hierarchies) to objectively evaluate verified_changed (0 or 1).
 */

/**
 * Extracts a normalized tree object from a state representation.
 * @param {any} state
 * @returns {any}
 */
function extractTree(state) {
  if (!state) return null;
  let raw = state;
  if (typeof state === 'object') {
    if (state.screen_tree !== undefined) raw = state.screen_tree;
    else if (state.tree !== undefined) raw = state.tree;
    else if (state.hierarchy !== undefined) raw = state.hierarchy;
    else if (state.root !== undefined) raw = state.root;
  }
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw.trim());
    } catch {
      // not JSON string
    }
  }
  return raw;
}

/**
 * Flattens an accessibility tree into a list of normalized node descriptors.
 *
 * @param {any} root
 * @returns {Array<{ key: string, text: string, className: string, clickable: boolean, bounds: string }>}
 */
function flattenTree(root) {
  if (!root) return [];
  let currentRoot = root;
  if (typeof currentRoot === 'string') {
    try {
      currentRoot = JSON.parse(currentRoot.trim());
    } catch {
      return [{ key: 'root_str', text: currentRoot.trim(), className: 'string', clickable: false, bounds: '' }];
    }
  }

  if (typeof currentRoot !== 'object' || currentRoot === null) {
    return [];
  }

  if (currentRoot.hierarchy && typeof currentRoot.hierarchy === 'object') {
    currentRoot = currentRoot.hierarchy;
  } else if (currentRoot.root && typeof currentRoot.root === 'object') {
    currentRoot = currentRoot.root;
  }

  const nodes = [];
  const visited = new Set();

  function walk(node, path, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 64 || visited.has(node)) {
      return;
    }
    visited.add(node);

    const key = node.id || node.resource_id || path;
    const text = (node.text || node.content_description || node.label || '').trim();
    const rawClass = node.class || node.type || '';
    const className = typeof rawClass === 'string' ? rawClass.split('.').pop() : '';
    const clickable = Boolean(node.clickable || node.is_clickable);
    const bounds = typeof node.bounds === 'object' ? JSON.stringify(node.bounds) : String(node.bounds || '');

    nodes.push({ key, text, className, clickable, bounds });

    const children = Array.isArray(node.children)
      ? node.children
      : Array.isArray(node.nodes)
        ? node.nodes
        : Array.isArray(node.child_nodes)
          ? node.child_nodes
          : [];

    for (let i = 0; i < children.length; i++) {
      walk(children[i], `${path}/${i}`, depth + 1);
    }
  }

  if (Array.isArray(currentRoot)) {
    for (let i = 0; i < currentRoot.length; i++) {
      walk(currentRoot[i], `root/${i}`, 0);
    }
  } else {
    walk(currentRoot, 'root', 0);
  }

  return nodes;
}

/**
 * Verifies whether an automated action caused an observable change on the screen
 * by computing a structural diff between state_before and state_after.
 *
 * @param {any} state_before - Screen state prior to action execution
 * @param {any} state_after - Screen state after action execution
 * @returns {{
 *   verified_changed: 0 | 1,
 *   has_changed: boolean,
 *   details: {
 *     before_node_count: number,
 *     after_node_count: number,
 *     changed_nodes: number,
 *     added_nodes: number,
 *     removed_nodes: number,
 *     reason: string
 *   }
 * }}
 */
export function verify_step(state_before, state_after) {
  // Edge cases: null/undefined checks
  if (!state_before && !state_after) {
    return {
      verified_changed: 0,
      has_changed: false,
      details: {
        before_node_count: 0,
        after_node_count: 0,
        changed_nodes: 0,
        added_nodes: 0,
        removed_nodes: 0,
        reason: 'Both before and after states are empty.',
      },
    };
  }

  if (!state_before || !state_after) {
    return {
      verified_changed: 1,
      has_changed: true,
      details: {
        before_node_count: state_before ? 1 : 0,
        after_node_count: state_after ? 1 : 0,
        changed_nodes: 1,
        added_nodes: state_after ? 1 : 0,
        removed_nodes: state_before ? 1 : 0,
        reason: 'One of the states is null while the other exists.',
      },
    };
  }

  // Check primitive strings if neither is a JSON tree
  if (typeof state_before === 'string' && typeof state_after === 'string') {
    let parsedBefore = null;
    let parsedAfter = null;
    try { parsedBefore = JSON.parse(state_before.trim()); } catch {}
    try { parsedAfter = JSON.parse(state_after.trim()); } catch {}

    if (parsedBefore && parsedAfter && typeof parsedBefore === 'object' && typeof parsedAfter === 'object') {
      // Both parse as JSON objects/arrays; continue to structural diff below
    } else {
      const isDifferent = state_before.trim() !== state_after.trim();
      return {
        verified_changed: isDifferent ? 1 : 0,
        has_changed: isDifferent,
        details: {
          before_node_count: 1,
          after_node_count: 1,
          changed_nodes: isDifferent ? 1 : 0,
          added_nodes: 0,
          removed_nodes: 0,
          reason: isDifferent ? 'String content changed.' : 'String content identical.',
        },
      };
    }
  }

  const treeBefore = extractTree(state_before);
  const treeAfter = extractTree(state_after);

  const nodesBefore = flattenTree(treeBefore);
  const nodesAfter = flattenTree(treeAfter);

  // If node counts differ significantly
  if (nodesBefore.length !== nodesAfter.length) {
    const diffCount = Math.abs(nodesBefore.length - nodesAfter.length);
    return {
      verified_changed: 1,
      has_changed: true,
      details: {
        before_node_count: nodesBefore.length,
        after_node_count: nodesAfter.length,
        changed_nodes: diffCount,
        added_nodes: Math.max(0, nodesAfter.length - nodesBefore.length),
        removed_nodes: Math.max(0, nodesBefore.length - nodesAfter.length),
        reason: `Node count changed from ${nodesBefore.length} to ${nodesAfter.length}.`,
      },
    };
  }

  // Node counts match; compare structural properties
  let changedNodes = 0;
  for (let i = 0; i < nodesBefore.length; i++) {
    const b = nodesBefore[i];
    const a = nodesAfter[i];

    if (
      b.key !== a.key ||
      b.text !== a.text ||
      b.className !== a.className ||
      b.clickable !== a.clickable ||
      b.bounds !== a.bounds
    ) {
      changedNodes++;
    }
  }

  if (changedNodes > 0) {
    return {
      verified_changed: 1,
      has_changed: true,
      details: {
        before_node_count: nodesBefore.length,
        after_node_count: nodesAfter.length,
        changed_nodes: changedNodes,
        added_nodes: 0,
        removed_nodes: 0,
        reason: `${changedNodes} nodes exhibited structural or content changes.`,
      },
    };
  }

  // Also check screenshot differences if present in states
  const screenshotBefore = typeof state_before === 'object' ? state_before?.screenshot : null;
  const screenshotAfter = typeof state_after === 'object' ? state_after?.screenshot : null;
  const hasScreenshotBefore = typeof screenshotBefore === 'string' && screenshotBefore.trim().length > 0;
  const hasScreenshotAfter = typeof screenshotAfter === 'string' && screenshotAfter.trim().length > 0;
  if (hasScreenshotBefore || hasScreenshotAfter) {
    if (screenshotBefore !== screenshotAfter) {
      return {
        verified_changed: 1,
        has_changed: true,
        details: {
          before_node_count: nodesBefore.length,
          after_node_count: nodesAfter.length,
          changed_nodes: 1,
          added_nodes: hasScreenshotAfter && !hasScreenshotBefore ? 1 : 0,
          removed_nodes: hasScreenshotBefore && !hasScreenshotAfter ? 1 : 0,
          reason: 'Screenshot image payload changed.',
        },
      };
    }
  }

  return {
    verified_changed: 0,
    has_changed: false,
    details: {
      before_node_count: nodesBefore.length,
      after_node_count: nodesAfter.length,
      changed_nodes: 0,
      added_nodes: 0,
      removed_nodes: 0,
      reason: 'No structural, textual, or visual difference detected between pre-action and post-action states.',
    },
  };
}

// Named alias
export const verifyStep = verify_step;
