/**
 * Hollis Screen Control — Risk Evaluation Engine
 *
 * Scans proposed actions and target descriptions against sensitive keywords
 * (money transfer, deletion, checkout, confirmation, message sending)
 * to intercept dangerous operations and trigger user confirmation workflows.
 */

/**
 * Standard risky keywords in Thai and English.
 */
export const DEFAULT_RISK_KEYWORDS = [
  // Thai sensitive keywords
  'ส่ง',
  'ลบ',
  'โอน',
  'ยืนยัน',
  'จ่าย',
  'ซื้อ',
  'ชำระ',
  'ถอน',
  'สั่งซื้อ',

  // English sensitive keywords
  'pay',
  'delete',
  'buy',
  'confirm',
  'send',
  'transfer',
  'remove',
  'purchase',
  'checkout',
  'withdraw',
  'order',
];

/**
 * Evaluates whether an automated screen action is potentially risky.
 *
 * @param {string | object | null | undefined} action - Proposed action or text string
 * @param {object} [options] - Optional configuration
 * @param {string[]} [options.customKeywords] - Additional or override risk keywords
 * @returns {{
 *   is_risky: boolean,
 *   matched_keyword: string | null,
 *   reason: string | null
 * }}
 */
export function check_risk(action, options = {}) {
  if (!action) {
    return {
      is_risky: false,
      matched_keyword: null,
      reason: null,
    };
  }

  const keywords = Array.isArray(options.customKeywords) && options.customKeywords.length > 0
    ? options.customKeywords
    : DEFAULT_RISK_KEYWORDS;

  // Recursively extract all strings from action representation
  const extractedStrings = [];
  const visited = new Set();

  function extractText(obj, depth = 0) {
    if (!obj || depth > 8) return;
    if (typeof obj === 'string') {
      const trimmed = obj.trim();
      if (trimmed) extractedStrings.push(trimmed);
      return;
    }
    if (typeof obj !== 'object') return;
    if (visited.has(obj)) return;
    visited.add(obj);

    if (Array.isArray(obj)) {
      for (const item of obj) extractText(item, depth + 1);
      return;
    }

    for (const val of Object.values(obj)) {
      if (typeof val === 'string') {
        const trimmed = val.trim();
        if (trimmed) extractedStrings.push(trimmed);
      } else if (typeof val === 'object' && val !== null) {
        extractText(val, depth + 1);
      }
    }
  }

  extractText(action);
  const normalized = extractedStrings.join(' ').toLowerCase();

  for (const keyword of keywords) {
    const kw = keyword.toLowerCase().trim();
    if (!kw) continue;

    const isAscii = /^[\x00-\x7F]+$/.test(kw);
    if (isAscii) {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const leftBoundary = /^\w/.test(kw) ? '\\b' : '(?:^|\\s)';
      const rightBoundary = /\w$/.test(kw) ? '\\b' : '(?:$|\\s)';
      const wordRegex = new RegExp(`${leftBoundary}${escaped}${rightBoundary}`, 'i');
      if (wordRegex.test(normalized)) {
        return {
          is_risky: true,
          matched_keyword: keyword,
          reason: `Action contains sensitive keyword "${keyword}" requiring user confirmation.`,
        };
      }
    } else {
      if (normalized.includes(kw)) {
        return {
          is_risky: true,
          matched_keyword: keyword,
          reason: `Action contains sensitive keyword "${keyword}" requiring user confirmation.`,
        };
      }
    }
  }

  return {
    is_risky: false,
    matched_keyword: null,
    reason: null,
  };
}

// Named alias
export const checkRisk = check_risk;
