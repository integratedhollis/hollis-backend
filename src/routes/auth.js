/**
 * Authentication route handlers for Hollis Backend.
 * Endpoints:
 * - POST /api/auth/register
 * - POST /api/auth/login
 * - POST /api/auth/verify-token
 * - POST /api/auth/logout
 */

import { hashPassword, verifyPassword } from '../auth/crypto.js';
import { signJwt, verifyJwt } from '../auth/jwt.js';
import { DEFAULT_JWT_SECRET } from '../auth/middleware.js';
import { jsonResponse, errorResponse } from '../utils/response.js';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Handles user registration.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {Promise<Response>}
 */
export async function handleRegister(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body.', 400, 'validation_failed');
  }

  const { username, email, password } = body || {};

  if (
    !username ||
    typeof username !== 'string' ||
    username.trim().length < 2 ||
    username.trim().length > 50 ||
    !email ||
    typeof email !== 'string' ||
    !EMAIL_REGEX.test(email.trim()) ||
    !password ||
    typeof password !== 'string' ||
    password.length < 8
  ) {
    return errorResponse(
      'Email, username, and password (min 8 characters) are required.',
      400,
      'validation_failed'
    );
  }

  const normalizedEmail = email.trim().toLowerCase();
  const normalizedUsername = username.trim();

  // Check if email already exists
  const existing = await env.DB.prepare(
    'SELECT id FROM users WHERE email = ? COLLATE NOCASE'
  )
    .bind(normalizedEmail)
    .first();

  if (existing) {
    return errorResponse('Email already registered', 400, 'email_already_registered');
  }

  const userId = crypto.randomUUID();
  const settingsId = crypto.randomUUID();
  const now = new Date().toISOString();
  const passwordHash = await hashPassword(password);

  // Atomic batch insertion for users and initial user_settings
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(userId, normalizedUsername, normalizedEmail, passwordHash, now),
    env.DB.prepare(
      'INSERT INTO user_settings (id, user_id, confirmation_mode, max_step_limit, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).bind(settingsId, userId, 'popup', 20, now),
  ]);

  const secret = env.JWT_SECRET || DEFAULT_JWT_SECRET;
  const accessToken = await signJwt(
    { sub: userId, username: normalizedUsername, email: normalizedEmail, type: 'access' },
    secret,
    3600
  );
  const refreshToken = await signJwt(
    { sub: userId, type: 'refresh' },
    secret,
    7 * 86400
  );

  return jsonResponse(
    {
      success: true,
      message: 'User registered successfully',
      user_id: userId,
      username: normalizedUsername,
      email: normalizedEmail,
      access_token: accessToken,
      refresh_token: refreshToken,
    },
    201
  );
}

/**
 * Handles user login.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {Promise<Response>}
 */
export async function handleLogin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body.', 400, 'missing_credentials');
  }

  const { email, password } = body || {};

  if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
    return errorResponse('Email and password are required.', 400, 'missing_credentials');
  }

  const normalizedEmail = email.trim().toLowerCase();

  const user = await env.DB.prepare(
    'SELECT id, username, email, password_hash FROM users WHERE email = ? COLLATE NOCASE'
  )
    .bind(normalizedEmail)
    .first();

  if (!user) {
    return errorResponse('Invalid email or password', 401, 'invalid_credentials');
  }

  const isValidPassword = await verifyPassword(password, user.password_hash);
  if (!isValidPassword) {
    return errorResponse('Invalid email or password', 401, 'invalid_credentials');
  }

  const secret = env.JWT_SECRET || DEFAULT_JWT_SECRET;
  const accessToken = await signJwt(
    { sub: user.id, username: user.username, email: user.email, type: 'access' },
    secret,
    3600
  );
  const refreshToken = await signJwt(
    { sub: user.id, type: 'refresh' },
    secret,
    7 * 86400
  );

  return jsonResponse({
    success: true,
    message: 'Login successful',
    user_id: user.id,
    username: user.username,
    email: user.email,
    access_token: accessToken,
    refresh_token: refreshToken,
  });
}

/**
 * Fast token validation endpoint for Android Splash Screen.
 * Accepts token in JSON body `{ token }` or in `Authorization: Bearer <token>` header.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {Promise<Response>}
 */
export async function handleVerifyToken(request, env) {
  let token = null;

  // Try extracting from body if Content-Type is JSON or body present
  const contentType = request.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    try {
      const body = await request.json();
      if (body && typeof body.token === 'string') {
        token = body.token.trim();
      }
    } catch {
      // Body is not valid JSON or empty, fall through to header
    }
  }

  // If not in body, check Authorization header
  if (!token) {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      token = authHeader.slice(7).trim();
    }
  }

  if (!token) {
    return jsonResponse({ valid: false });
  }

  const secret = env.JWT_SECRET || DEFAULT_JWT_SECRET;
  const result = await verifyJwt(token, secret);

  if (!result.valid || !result.payload || result.payload.type !== 'access') {
    return jsonResponse({ valid: false });
  }

  return jsonResponse({
    valid: true,
    user_id: result.payload.sub,
    email: result.payload.email,
    username: result.payload.username,
  });
}

/**
 * Handles client logout confirmation.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {Promise<Response>}
 */
export async function handleLogout(request, env) {
  return jsonResponse({
    success: true,
    message: 'Logged out successfully',
  });
}
