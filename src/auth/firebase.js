/**
 * Firebase ID Token verification module for Cloudflare Workers.
 * Native Web Crypto implementation using Google RS256 JWKS.
 *
 * Verifies tokens issued by Firebase Authentication (Google Login).
 */

const GOOGLE_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';

// In-memory JWKS cache across Worker invocations
let cachedJwks = null;
let jwksExpiresAt = 0;

/**
 * Fetches Google JWKS with Cache-Control TTL caching.
 * @param {boolean} forceRefresh
 * @returns {Promise<Array<any>>}
 */
async function getGoogleJwks(forceRefresh = false) {
  const now = Date.now();
  if (!forceRefresh && cachedJwks && now < jwksExpiresAt) {
    return cachedJwks;
  }

  const res = await fetch(GOOGLE_JWKS_URL, {
    headers: { 'Accept': 'application/json' },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch Google JWKS: HTTP ${res.status}`);
  }

  const data = await res.json();
  const keys = data.keys || [];

  // Determine TTL from Cache-Control header
  let maxAgeSeconds = 3600; // default 1 hour
  const cacheControl = res.headers.get('cache-control');
  if (cacheControl) {
    const match = cacheControl.match(/max-age=(\d+)/i);
    if (match) {
      maxAgeSeconds = Math.max(300, parseInt(match[1], 10));
    }
  }

  cachedJwks = keys;
  jwksExpiresAt = now + maxAgeSeconds * 1000;
  return keys;
}

/**
 * Decodes a base64url string into bytes (Uint8Array).
 * @param {string} str
 * @returns {Uint8Array}
 */
function base64UrlToBytes(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
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
 * Decodes a base64url string into a parsed JSON object.
 * @param {string} str
 * @returns {any}
 */
function base64UrlToJson(str) {
  const bytes = base64UrlToBytes(str);
  const text = new TextDecoder('utf-8').decode(bytes);
  return JSON.parse(text);
}

/**
 * Verifies a Firebase ID Token using Google JWKS and Web Crypto API.
 *
 * @param {string} token - The raw Firebase ID Token (JWT string)
 * @param {string} projectId - Firebase Project ID (e.g. 'hollis-edd21')
 * @returns {Promise<{ valid: boolean, payload?: any, error?: string }>}
 */
export async function verifyFirebaseIdToken(token, projectId) {
  if (!token || typeof token !== 'string') {
    return { valid: false, error: 'Token is missing or not a string.' };
  }

  const parts = token.trim().split('.');
  if (parts.length !== 3) {
    return { valid: false, error: 'Malformed JWT structure.' };
  }

  let header;
  let payload;
  try {
    header = base64UrlToJson(parts[0]);
    payload = base64UrlToJson(parts[1]);
  } catch (err) {
    return { valid: false, error: `Failed to decode JWT: ${err.message}` };
  }

  // 1. Verify Header attributes
  if (header.alg !== 'RS256') {
    return { valid: false, error: `Invalid header algorithm: expected RS256, got ${header.alg}` };
  }

  if (!header.kid) {
    return { valid: false, error: 'Missing kid (Key ID) in token header.' };
  }

  // 2. Fetch JWKS and locate matching public key
  let jwks = await getGoogleJwks(false);
  let jwk = jwks.find((k) => k.kid === header.kid);

  // If not found in cache, force refresh once in case key was just rotated by Google
  if (!jwk) {
    jwks = await getGoogleJwks(true);
    jwk = jwks.find((k) => k.kid === header.kid);
  }

  if (!jwk) {
    return { valid: false, error: `Matching Google public key with kid '${header.kid}' not found.` };
  }

  // 3. Verify Cryptographic Signature using Web Crypto API
  try {
    const cryptoKey = await crypto.subtle.importKey(
      'jwk',
      jwk,
      {
        name: 'RSASSA-PKCS1-v1_5',
        hash: 'SHA-256',
      },
      false,
      ['verify']
    );

    const signedData = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const signatureBytes = base64UrlToBytes(parts[2]);

    const isSignatureValid = await crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      cryptoKey,
      signatureBytes,
      signedData
    );

    if (!isSignatureValid) {
      return { valid: false, error: 'Invalid token signature.' };
    }
  } catch (err) {
    return { valid: false, error: `Signature verification error: ${err.message}` };
  }

  // 4. Validate Claims
  const now = Math.floor(Date.now() / 1000);
  const targetProjectId = projectId || 'hollis-edd21';

  // Expiration check
  if (typeof payload.exp !== 'number' || payload.exp <= now) {
    return { valid: false, error: 'Token has expired.' };
  }

  // Audience check
  if (payload.aud !== targetProjectId) {
    return {
      valid: false,
      error: `Invalid audience: token was issued for '${payload.aud}', expected '${targetProjectId}'.`,
    };
  }

  // Issuer check
  const expectedIssuer = `https://securetoken.google.com/${targetProjectId}`;
  if (payload.iss !== expectedIssuer) {
    return {
      valid: false,
      error: `Invalid issuer: token issuer is '${payload.iss}', expected '${expectedIssuer}'.`,
    };
  }

  // Subject (Firebase UID) check
  if (!payload.sub || typeof payload.sub !== 'string') {
    return { valid: false, error: 'Missing or invalid sub (Firebase UID) in payload.' };
  }

  // Auth time check (allow up to 5 minutes clock skew)
  if (payload.auth_time && typeof payload.auth_time === 'number' && payload.auth_time > now + 300) {
    return { valid: false, error: 'Token auth_time is in the future.' };
  }

  return {
    valid: true,
    payload: {
      uid: payload.sub,
      email: payload.email || `${payload.sub}@firebase.user`,
      name: payload.name || (payload.email ? payload.email.split('@')[0] : 'User'),
      picture: payload.picture || null,
      email_verified: Boolean(payload.email_verified),
    },
  };
}
