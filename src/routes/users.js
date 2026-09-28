/**
 * User profile and settings route handlers for Hollis Backend.
 * Endpoints:
 * - GET /api/users/me
 * - PUT /api/users/settings
 */

import { authenticate } from '../auth/middleware.js';
import { jsonResponse, errorResponse } from '../utils/response.js';

const ALLOWED_CONFIRMATION_MODES = ['popup', 'push', 'none'];

/**
 * Handles GET /api/users/me
 * Returns user profile and automation settings for the authenticated user.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {Promise<Response>}
 */
export async function handleGetMe(request, env) {
  const authResult = await authenticate(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const { user } = authResult;

  const row = await env.DB.prepare(
    `SELECT u.id AS user_id, u.username, u.email, u.created_at,
            s.confirmation_mode, s.max_step_limit, s.updated_at
     FROM users u
     LEFT JOIN user_settings s ON u.id = s.user_id
     WHERE u.id = ?`
  )
    .bind(user.id)
    .first();

  if (!row) {
    return errorResponse('User not found.', 404, 'user_not_found');
  }

  return jsonResponse({
    user_id: row.user_id,
    username: row.username,
    email: row.email,
    created_at: row.created_at,
    settings: {
      confirmation_mode: row.confirmation_mode || 'popup',
      max_step_limit: Number(row.max_step_limit) || 20,
      updated_at: row.updated_at || row.created_at,
    },
  });
}

/**
 * Handles PUT /api/users/settings
 * Updates confirmation_mode and/or max_step_limit for the authenticated user.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @returns {Promise<Response>}
 */
export async function handleUpdateSettings(request, env) {
  const authResult = await authenticate(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const { user } = authResult;

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body.', 400, 'invalid_input');
  }

  if (!body || typeof body !== 'object') {
    return errorResponse('Request body must be an object.', 400, 'invalid_input');
  }

  const { confirmation_mode, max_step_limit } = body;

  if (confirmation_mode === undefined && max_step_limit === undefined) {
    return errorResponse(
      'At least one setting (confirmation_mode or max_step_limit) must be provided.',
      400,
      'invalid_input'
    );
  }

  if (
    confirmation_mode !== undefined &&
    (!ALLOWED_CONFIRMATION_MODES.includes(confirmation_mode))
  ) {
    return errorResponse(
      "confirmation_mode must be 'popup', 'push', or 'none'.",
      400,
      'invalid_input'
    );
  }

  if (
    max_step_limit !== undefined &&
    (typeof max_step_limit !== 'number' ||
      !Number.isInteger(max_step_limit) ||
      max_step_limit <= 0 ||
      max_step_limit > 1000)
  ) {
    return errorResponse(
      'max_step_limit must be a positive integer.',
      400,
      'invalid_input'
    );
  }

  const now = new Date().toISOString();

  // Check if settings record already exists
  const existingSettings = await env.DB.prepare(
    'SELECT id, confirmation_mode, max_step_limit FROM user_settings WHERE user_id = ?'
  )
    .bind(user.id)
    .first();

  if (!existingSettings) {
    const newSettingsId = crypto.randomUUID();
    await env.DB.prepare(
      'INSERT INTO user_settings (id, user_id, confirmation_mode, max_step_limit, updated_at) VALUES (?, ?, ?, ?, ?)'
    )
      .bind(
        newSettingsId,
        user.id,
        confirmation_mode !== undefined ? confirmation_mode : 'popup',
        max_step_limit !== undefined ? max_step_limit : 20,
        now
      )
      .run();
  } else {
    const newMode = confirmation_mode !== undefined ? confirmation_mode : existingSettings.confirmation_mode;
    const newLimit = max_step_limit !== undefined ? max_step_limit : existingSettings.max_step_limit;

    await env.DB.prepare(
      'UPDATE user_settings SET confirmation_mode = ?, max_step_limit = ?, updated_at = ? WHERE user_id = ?'
    )
      .bind(newMode, newLimit, now, user.id)
      .run();
  }

  const updated = await env.DB.prepare(
    'SELECT confirmation_mode, max_step_limit, updated_at FROM user_settings WHERE user_id = ?'
  )
    .bind(user.id)
    .first();

  return jsonResponse({
    success: true,
    message: 'Settings updated',
    settings: {
      user_id: user.id,
      confirmation_mode: updated.confirmation_mode,
      max_step_limit: Number(updated.max_step_limit),
      updated_at: updated.updated_at,
    },
  });
}
