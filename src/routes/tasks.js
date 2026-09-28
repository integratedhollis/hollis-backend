/**
 * Task lifecycle and history management route handlers for Hollis Backend.
 *
 * Endpoints:
 * - POST /api/tasks/start          -> Start a new task session
 * - GET  /api/tasks                -> List task sessions (History with search/filter)
 * - GET  /api/tasks/:id            -> Task session summary
 * - GET  /api/tasks/:id/status     -> Current status of task session (polling fallback)
 * - POST /api/tasks/:id/cancel     -> Cancel an in-progress task session
 * - POST /api/tasks/:id/confirm    -> Confirm/Reject risky action
 * - GET  /api/tasks/:id/logs       -> Full step-by-step logs for session replay
 */

import { authenticate } from '../auth/middleware.js';
import { jsonResponse, errorResponse } from '../utils/response.js';

/**
 * Main dispatcher for all /api/tasks routes.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {URL} url
 * @param {string} method
 * @returns {Promise<Response>}
 */
export async function handleTasksRoute(request, env, url, method) {
  const authResult = await authenticate(request, env);
  if (authResult instanceof Response) {
    return authResult;
  }

  const { user } = authResult;
  const path = url.pathname;

  // 1. POST /api/tasks/start or POST /api/tasks (Start new task)
  if ((path === '/api/tasks/start' || path === '/api/tasks') && method === 'POST') {
    return await handleStartTask(request, env, user);
  }

  // 2. GET /api/tasks (List user tasks with query / filters)
  if (path === '/api/tasks' && method === 'GET') {
    return await handleListTasks(env, user, url);
  }

  // Parameterized routes: /api/tasks/:session_id[/subpath]
  const taskSubpathMatch = path.match(/^\/api\/tasks\/([^/]+)(?:\/(status|cancel|confirm|logs))?$/);
  if (!taskSubpathMatch) {
    return errorResponse('Route not found.', 404, 'not_found');
  }

  const sessionId = taskSubpathMatch[1];
  const subAction = taskSubpathMatch[2]; // undefined | 'status' | 'cancel' | 'confirm' | 'logs'

  if (!subAction) {
    if (method === 'GET') {
      return await handleGetTaskSummary(env, user, sessionId);
    }
    return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
  }

  if (subAction === 'status') {
    if (method !== 'GET') {
      return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
    }
    return await handleGetTaskStatus(env, user, sessionId);
  }

  if (subAction === 'cancel') {
    if (method !== 'POST') {
      return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
    }
    return await handleCancelTask(env, user, sessionId);
  }

  if (subAction === 'confirm') {
    if (method !== 'POST') {
      return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
    }
    return await handleConfirmTask(request, env, user, sessionId);
  }

  if (subAction === 'logs') {
    if (method !== 'GET') {
      return errorResponse('Method Not Allowed', 405, 'method_not_allowed');
    }
    return await handleGetTaskLogs(env, user, sessionId);
  }

  return errorResponse('Route not found.', 404, 'not_found');
}

/**
 * Handles starting a new task session.
 * POST /api/tasks/start
 */
async function handleStartTask(request, env, user) {
  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body.', 400, 'invalid_input');
  }

  if (!body || typeof body !== 'object' || typeof body.instruction !== 'string') {
    return errorResponse('instruction is required and must be a string.', 400, 'invalid_input');
  }

  const instruction = body.instruction.trim();
  if (instruction.length === 0) {
    return errorResponse('instruction cannot be empty.', 400, 'invalid_input');
  }

  const sessionId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO sessions (id, user_id, instruction, status, step_count, started_at)
     VALUES (?, ?, ?, 'running', 0, ?)`
  )
    .bind(sessionId, user.id, instruction, now)
    .run();

  return jsonResponse(
    {
      session_id: sessionId,
      status: 'running',
    },
    201
  );
}

/**
 * Handles listing tasks for the current user.
 * GET /api/tasks?status=&q=&limit=&offset=
 */
async function handleListTasks(env, user, url) {
  const statusParam = url.searchParams.get('status')?.trim();
  const searchParam = url.searchParams.get('q')?.trim();
  const pageParam = parseInt(url.searchParams.get('page') || '0', 10);
  let limit = parseInt(url.searchParams.get('limit') || '20', 10);
  let offset = parseInt(url.searchParams.get('offset') || '0', 10);

  if (isNaN(limit) || limit <= 0) limit = 20;
  if (limit > 100) limit = 100;

  if (pageParam > 0 && !url.searchParams.has('offset')) {
    offset = (pageParam - 1) * limit;
  }
  if (isNaN(offset) || offset < 0) offset = 0;

  const whereConditions = ['user_id = ?'];
  const bindValues = [user.id];

  if (statusParam) {
    whereConditions.push('status = ?');
    bindValues.push(statusParam);
  }

  if (searchParam) {
    whereConditions.push('instruction LIKE ?');
    bindValues.push(`%${searchParam}%`);
  }

  const whereClause = whereConditions.join(' AND ');

  // Fetch count
  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM sessions WHERE ${whereClause}`
  )
    .bind(...bindValues)
    .first();

  const total = countResult ? countResult.total : 0;

  // Fetch paginated sessions
  const rows = await env.DB.prepare(
    `SELECT id AS session_id, instruction, status, step_count, started_at, ended_at
     FROM sessions
     WHERE ${whereClause}
     ORDER BY started_at DESC
     LIMIT ? OFFSET ?`
  )
    .bind(...bindValues, limit, offset)
    .all();

  return jsonResponse({
    tasks: rows.results || [],
    total,
    limit,
    offset,
  });
}

/**
 * Handles fetching task summary.
 * GET /api/tasks/:session_id
 */
async function handleGetTaskSummary(env, user, sessionId) {
  const session = await env.DB.prepare(
    `SELECT id AS session_id, user_id, instruction, status, step_count, started_at, ended_at
     FROM sessions
     WHERE id = ? AND user_id = ?`
  )
    .bind(sessionId, user.id)
    .first();

  if (!session) {
    return errorResponse('Task session not found.', 404, 'task_not_found');
  }

  // Calculate duration in seconds
  let duration = 0;
  if (session.started_at) {
    const startTime = new Date(session.started_at).getTime();
    const endTime = session.ended_at ? new Date(session.ended_at).getTime() : Date.now();
    duration = Math.max(0, Math.round((endTime - startTime) / 1000));
  }

  return jsonResponse({
    session_id: session.session_id,
    instruction: session.instruction,
    status: session.status,
    step_count: Number(session.step_count) || 0,
    duration,
    created_at: session.started_at,
    started_at: session.started_at,
    ended_at: session.ended_at,
  });
}

/**
 * Handles fetching task status (Polling Fallback).
 * GET /api/tasks/:session_id/status
 */
async function handleGetTaskStatus(env, user, sessionId) {
  const session = await env.DB.prepare(
    `SELECT id AS session_id, status, step_count
     FROM sessions
     WHERE id = ? AND user_id = ?`
  )
    .bind(sessionId, user.id)
    .first();

  if (!session) {
    return errorResponse('Task session not found.', 404, 'task_not_found');
  }

  // Fetch the latest log message
  const lastStep = await env.DB.prepare(
    `SELECT step_no, log_message
     FROM task_steps
     WHERE session_id = ?
     ORDER BY step_no DESC
     LIMIT 1`
  )
    .bind(sessionId)
    .first();

  return jsonResponse({
    session_id: session.session_id,
    status: session.status,
    current_step: lastStep ? Number(lastStep.step_no) : Number(session.step_count) || 0,
    last_log: lastStep ? lastStep.log_message : null,
  });
}

/**
 * Handles cancelling an active task session.
 * POST /api/tasks/:session_id/cancel
 */
async function handleCancelTask(env, user, sessionId) {
  const session = await env.DB.prepare(
    `SELECT id, status FROM sessions WHERE id = ? AND user_id = ?`
  )
    .bind(sessionId, user.id)
    .first();

  if (!session) {
    return errorResponse('Task session not found.', 404, 'task_not_found');
  }

  // If task is already finalized, return current status
  const finalStatuses = ['completed', 'cancelled', 'stopped_loop', 'stopped_limit', 'failed'];
  if (finalStatuses.includes(session.status)) {
    return jsonResponse({
      session_id: session.id,
      status: session.status,
      message: 'Task is already completed or stopped.',
    });
  }

  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE sessions SET status = 'cancelled', ended_at = ? WHERE id = ?`
  )
    .bind(now, sessionId)
    .run();

  return jsonResponse({
    session_id: sessionId,
    status: 'cancelled',
  });
}

/**
 * Handles approving/rejecting a pending risk confirmation.
 * POST /api/tasks/:session_id/confirm
 */
async function handleConfirmTask(request, env, user, sessionId) {
  const session = await env.DB.prepare(
    `SELECT id FROM sessions WHERE id = ? AND user_id = ?`
  )
    .bind(sessionId, user.id)
    .first();

  if (!session) {
    return errorResponse('Task session not found.', 404, 'task_not_found');
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return errorResponse('Invalid JSON body.', 400, 'invalid_input');
  }

  if (!body || typeof body !== 'object' || typeof body.approved !== 'boolean') {
    return errorResponse('approved boolean field is required.', 400, 'invalid_input');
  }

  const { approved } = body;
  const now = new Date().toISOString();
  const responseValue = approved ? 'approved' : 'rejected';

  // Find the latest pending confirmation for this session
  const pendingConfirmation = await env.DB.prepare(
    `SELECT id FROM risk_confirmations
     WHERE session_id = ? AND user_response IS NULL
     ORDER BY rowid DESC
     LIMIT 1`
  )
    .bind(sessionId)
    .first();

  if (pendingConfirmation) {
    await env.DB.prepare(
      `UPDATE risk_confirmations
       SET user_response = ?, responded_at = ?
       WHERE id = ?`
    )
      .bind(responseValue, now, pendingConfirmation.id)
      .run();
  }

  return jsonResponse({
    session_id: sessionId,
    status: 'ok',
    approved,
  });
}

/**
 * Handles fetching full step logs for session replay.
 * GET /api/tasks/:session_id/logs
 */
async function handleGetTaskLogs(env, user, sessionId) {
  const session = await env.DB.prepare(
    `SELECT id FROM sessions WHERE id = ? AND user_id = ?`
  )
    .bind(sessionId, user.id)
    .first();

  if (!session) {
    return errorResponse('Task session not found.', 404, 'task_not_found');
  }

  const rows = await env.DB.prepare(
    `SELECT id, step_no, action_type, log_message, is_risky, verified_changed, created_at
     FROM task_steps
     WHERE session_id = ?
     ORDER BY step_no ASC`
  )
    .bind(sessionId)
    .all();

  const logs = (rows.results || []).map((step) => ({
    id: step.id,
    step_no: Number(step.step_no),
    action_type: step.action_type,
    log_message: step.log_message,
    is_risky: Boolean(step.is_risky),
    verified_changed: Boolean(step.verified_changed),
    created_at: step.created_at,
  }));

  return jsonResponse({
    session_id: sessionId,
    logs,
  });
}
