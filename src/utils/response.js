/**
 * Standardized HTTP response utilities with CORS support for Hollis Backend.
 */

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

/**
 * Creates a JSON HTTP response.
 * @param {any} data
 * @param {number} status
 * @param {Record<string, string>} customHeaders
 * @returns {Response}
 */
export function jsonResponse(data, status = 200, customHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...customHeaders,
    },
  });
}

/**
 * Creates an error HTTP response with standardized error and message properties.
 * @param {string} message Human-readable error message
 * @param {number} status HTTP status code (default: 400)
 * @param {string|null} errorCode Machine-readable error code (e.g. 'validation_failed')
 * @param {Record<string, string>} customHeaders
 * @returns {Response}
 */
export function errorResponse(message, status = 400, errorCode = null, customHeaders = {}) {
  const body = {
    error: errorCode || message,
    message: message,
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      ...CORS_HEADERS,
      ...customHeaders,
    },
  });
}

/**
 * Returns a 204 No Content response for CORS preflight OPTIONS requests.
 * @returns {Response}
 */
export function corsPreflightResponse() {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
}
