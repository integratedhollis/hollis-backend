/**
 * Authentication middleware for Cloudflare Workers.
 * Supports dual-mode authentication:
 * 1. Primary: Firebase ID Token (Google Login via Firebase Auth) with automatic JIT User Provisioning in D1
 * 2. Fallback: Native HS256 JWT tokens
 */

import { verifyJwt } from './jwt.js';
import { verifyFirebaseIdToken } from './firebase.js';
import { errorResponse } from '../utils/response.js';

export const DEFAULT_JWT_SECRET = 'hollis-default-dev-secret-key-do-not-use-in-prod-32bytes';

/**
 * Just-in-Time (JIT) provisioning or retrieval of a Firebase user in D1.
 *
 * @param {D1Database} db
 * @param {{ uid: string, email: string, name?: string }} firebasePayload
 * @returns {Promise<{ id: string, username: string, email: string }>}
 */
export async function getOrCreateFirebaseUser(db, firebasePayload) {
  const email = (firebasePayload.email || `${firebasePayload.uid}@firebase.user`).toLowerCase();
  const displayName = firebasePayload.name || email.split('@')[0] || 'Firebase User';

  // 1. Look up existing user by email
  const existing = await db
    .prepare('SELECT id, username, email FROM users WHERE email = ?')
    .bind(email)
    .first();

  if (existing) {
    return existing;
  }

  // 2. User doesn't exist yet -> Just-In-Time Provisioning!
  const newUserId = crypto.randomUUID();
  const now = new Date().toISOString();

  await db
    .prepare(
      'INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(newUserId, displayName, email, 'FIREBASE_AUTH', now)
    .run();

  // Create default user_settings
  const newSettingsId = crypto.randomUUID();
  await db
    .prepare(
      'INSERT INTO user_settings (id, user_id, confirmation_mode, max_step_limit, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
    .bind(newSettingsId, newUserId, 'popup', 20, now)
    .run();

  return {
    id: newUserId,
    username: displayName,
    email: email,
  };
}

/**
 * Authenticates a raw token string against Firebase ID Token (primary) or Custom JWT (fallback).
 *
 * @param {string} token
 * @param {Record<string, any>} env
 * @returns {Promise<{ user: { id: string, email: string, username?: string, firebase_uid?: string, picture?: string|null, auth_provider: string } } | null>}
 */
export async function authenticateToken(token, env) {
  if (!token || typeof token !== 'string') {
    return null;
  }

  const trimmedToken = token.trim();
  const projectId = env?.FIREBASE_PROJECT_ID || 'hollis-edd21';

  // 1. Try Firebase ID Token verification (Google Sign-In)
  try {
    const firebaseResult = await verifyFirebaseIdToken(trimmedToken, projectId);
    if (firebaseResult.valid && firebaseResult.payload) {
      const dbUser = await getOrCreateFirebaseUser(env.DB, firebaseResult.payload);
      return {
        user: {
          id: dbUser.id,
          email: dbUser.email,
          username: dbUser.username,
          firebase_uid: firebaseResult.payload.uid,
          picture: firebaseResult.payload.picture || null,
          auth_provider: 'firebase',
        },
      };
    }
  } catch (err) {
    console.warn('Firebase token verification error, attempting fallback:', err.message);
  }

  // 2. Fallback: Custom JWT verification (HS256)
  try {
    const secret = (env && env.JWT_SECRET) || DEFAULT_JWT_SECRET;
    const jwtResult = await verifyJwt(trimmedToken, secret);
    if (jwtResult.valid && jwtResult.payload && jwtResult.payload.type === 'access') {
      return {
        user: {
          id: jwtResult.payload.sub,
          email: jwtResult.payload.email,
          username: jwtResult.payload.username,
          auth_provider: 'jwt',
        },
      };
    }
  } catch (err) {
    console.warn('Custom JWT verification error:', err.message);
  }

  return null;
}

/**
 * Authenticates an incoming request by verifying its Bearer token.
 * Returns `{ user: { id, email, username } }` on success, or a 401 `Response` on failure.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {Promise<{ user: { id: string, email: string, username?: string } } | Response>}
 */
export async function authenticate(request, env) {
  const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
  if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
    return errorResponse('Missing or malformed Authorization header.', 401, 'unauthorized');
  }

  const token = authHeader.slice(7).trim();
  if (!token) {
    return errorResponse('Missing or malformed Authorization header.', 401, 'unauthorized');
  }

  const authData = await authenticateToken(token, env);
  if (!authData || !authData.user) {
    return errorResponse('Invalid or expired authentication token.', 401, 'unauthorized');
  }

  return authData;
}

/**
 * Convenience wrapper returning `{ user, response }` tuple.
 * If authentication fails, `user` is null and `response` is the 401 Response.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {Promise<{ user: { id: string, email: string, username?: string } | null, response: Response | null }>}
 */
export async function requireAuth(request, env) {
  const authResult = await authenticate(request, env);
  if (authResult instanceof Response) {
    return { user: null, response: authResult };
  }
  return { user: authResult.user, response: null };
}
