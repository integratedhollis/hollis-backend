/**
 * Authentication middleware for Cloudflare Workers.
 * Validates incoming Bearer JWT tokens and extracts authenticated user context.
 */

import { verifyJwt } from './jwt.js';
import { errorResponse } from '../utils/response.js';

export const DEFAULT_JWT_SECRET = 'hollis-default-dev-secret-key-do-not-use-in-prod-32bytes';

/**
 * Authenticates an incoming request by verifying its Bearer JWT access token.
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

  const secret = (env && env.JWT_SECRET) || DEFAULT_JWT_SECRET;
  const result = await verifyJwt(token, secret);

  if (!result.valid || !result.payload || result.payload.type !== 'access') {
    return errorResponse('Invalid or expired token.', 401, 'unauthorized');
  }

  return {
    user: {
      id: result.payload.sub,
      email: result.payload.email,
      username: result.payload.username,
    },
  };
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
