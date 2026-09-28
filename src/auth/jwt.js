/**
 * Pure Web Crypto-based JSON Web Token (JWT) implementation (HS256).
 * Zero external or Node.js dependencies. Pure standard Web APIs.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Converts a Uint8Array to a Base64URL string (RFC 7515).
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64Url(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Converts a Base64URL string to a Uint8Array.
 * @param {string} str
 * @returns {Uint8Array}
 */
export function base64UrlToBytes(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Encodes a UTF-8 string to a Base64URL string.
 * @param {string} str
 * @returns {string}
 */
export function stringToBase64Url(str) {
  return bytesToBase64Url(textEncoder.encode(str));
}

/**
 * Decodes a Base64URL string to a UTF-8 string.
 * @param {string} str
 * @returns {string}
 */
export function base64UrlToString(str) {
  return textDecoder.decode(base64UrlToBytes(str));
}

/**
 * Signs a JWT payload with HMAC-SHA256 (HS256).
 *
 * @param {Record<string, any>} payload - Payload claims
 * @param {string} secret - Secret key for HMAC signing
 * @param {number} [expiresInSeconds=3600] - Expiration duration in seconds (default: 1 hour)
 * @returns {Promise<string>} Signed JWT string `<header>.<payload>.<signature>`
 */
export async function signJwt(payload, secret, expiresInSeconds = 3600) {
  if (!secret || typeof secret !== 'string') {
    throw new Error('JWT secret must be a non-empty string.');
  }

  const now = Math.floor(Date.now() / 1000);
  const claims = {
    ...payload,
    iat: payload.iat ?? now,
  };

  if (expiresInSeconds > 0 && claims.exp === undefined) {
    claims.exp = now + expiresInSeconds;
  }

  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = stringToBase64Url(JSON.stringify(header));
  const encodedPayload = stringToBase64Url(JSON.stringify(claims));
  const data = textEncoder.encode(`${encodedHeader}.${encodedPayload}`);

  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, data);
  const encodedSignature = bytesToBase64Url(new Uint8Array(signature));

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * Verifies a JWT token signature and expiration.
 *
 * @param {string} token - Signed JWT string
 * @param {string} secret - Secret key for verification
 * @returns {Promise<{ valid: boolean, payload?: Record<string, any>, error?: string }>}
 */
export async function verifyJwt(token, secret) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token must be a non-empty string.' };
  }
  if (!secret || typeof secret !== 'string') {
    return { valid: false, error: 'JWT secret must be a non-empty string.' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Malformed token structure: expected 3 parts.' };
  }

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  try {
    const headerStr = base64UrlToString(encodedHeader);
    const header = JSON.parse(headerStr);
    if (header.alg !== 'HS256' || header.typ !== 'JWT') {
      return { valid: false, error: 'Unsupported algorithm or token type.' };
    }

    const key = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const data = textEncoder.encode(`${encodedHeader}.${encodedPayload}`);
    const signature = base64UrlToBytes(encodedSignature);

    const isValid = await crypto.subtle.verify('HMAC', key, signature, data);
    if (!isValid) {
      return { valid: false, error: 'Invalid token signature.' };
    }

    const payloadStr = base64UrlToString(encodedPayload);
    const payload = JSON.parse(payloadStr);
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp !== undefined && payload.exp < now) {
      return { valid: false, error: 'Token has expired.' };
    }
    if (payload.nbf !== undefined && payload.nbf > now) {
      return { valid: false, error: 'Token is not yet valid.' };
    }

    return {
      valid: true,
      payload,
      ...payload,
    };
  } catch (err) {
    return { valid: false, error: err.message || 'Token verification failed.' };
  }
}
