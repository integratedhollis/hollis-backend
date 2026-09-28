/**
 * WebSocket Task Gateway and Real-Time Mock Log Streaming for Hollis Backend.
 *
 * Route: WS /ws/tasks/:session_id
 *
 * Implements:
 * - RFC 6455 WebSocket handshake via Cloudflare Workers WebSocketPair
 * - JWT authentication via query parameter ?token= or Authorization header
 * - D1 task session verification and strict user isolation
 * - In-memory session registry integration for cross-request cancellation
 * - Background mock log streaming via ctx.waitUntil
 * - D1 batch persistence into task_steps and sessions.step_count
 * - Application-level Ping/Pong heartbeats
 * - Graceful connection termination and cancellation handling
 */

import { verifyJwt } from '../auth/jwt.js';
import { DEFAULT_JWT_SECRET } from '../auth/middleware.js';
import { errorResponse } from '../utils/response.js';
import { registerSession, removeSession, cancelActiveSession } from '../utils/wsRegistry.js';

/**
 * Sequential mock execution steps representing Android screen automation actions.
 */
const MOCK_STEPS = [
  {
    step_no: 1,
    action_type: 'init',
    log_message: 'Initializing screen capture',
    is_risky: 0,
    verified_changed: 1,
  },
  {
    step_no: 2,
    action_type: 'inspect_screen',
    log_message: 'Analyzing UI hierarchy',
    is_risky: 0,
    verified_changed: 1,
  },
  {
    step_no: 3,
    action_type: 'tap',
    log_message: 'Tapping target element',
    is_risky: 0,
    verified_changed: 1,
  },
  {
    step_no: 4,
    action_type: 'verify_screen',
    log_message: 'Verifying UI transition',
    is_risky: 0,
    verified_changed: 1,
  },
  {
    step_no: 5,
    action_type: 'complete',
    log_message: 'Task completed successfully',
    is_risky: 0,
    verified_changed: 1,
  },
];

/**
 * Delays execution for `ms` milliseconds, immediately resolving if `signal` is aborted.
 *
 * @param {number} ms
 * @param {AbortSignal} signal
 * @returns {Promise<boolean>} True if delay finished naturally, false if aborted
 */
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve(true);
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }

    if (signal) {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Main WebSocket route handler for /ws/tasks/:session_id.
 *
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {ExecutionContext} ctx
 * @param {URL} url
 * @returns {Promise<Response>}
 */
export async function handleWebSocketRoute(request, env, ctx, url) {
  // 1. Path format verification: /ws/tasks/:session_id
  const match = url.pathname.match(/^\/ws\/tasks\/([^/]+)$/);
  if (!match) {
    return errorResponse('Invalid WebSocket endpoint.', 404, 'not_found');
  }
  const sessionId = match[1];

  // 2. Check WebSocket Upgrade header
  const upgradeHeader = request.headers.get('Upgrade') || request.headers.get('upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return errorResponse('Expected WebSocket upgrade', 426);
  }

  // 3. Extract and validate authentication token
  let token = url.searchParams.get('token');
  if (!token) {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      token = authHeader.slice(7).trim();
    }
  }

  if (!token) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const secret = (env && env.JWT_SECRET) || DEFAULT_JWT_SECRET;
  const authResult = await verifyJwt(token, secret);
  if (!authResult.valid || !authResult.payload || authResult.payload.type !== 'access') {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const payload = authResult.payload;

  // 4. Verify session existence and user ownership in Cloudflare D1
  const session = await env.DB.prepare(
    `SELECT id, user_id, status, instruction, step_count FROM sessions WHERE id = ?`
  )
    .bind(sessionId)
    .first();

  if (!session || session.user_id !== payload.sub) {
    return errorResponse('Session not found', 404, 'not_found');
  }

  // 5. Handle sessions that are already completed or cancelled prior to connection
  if (session.status === 'cancelled') {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.send(
      JSON.stringify({
        event: 'cancelled',
        session_id: sessionId,
        status: 'cancelled',
        summary_message: 'งานถูกยกเลิกโดยผู้ใช้',
      })
    );
    server.close(1000, 'Session already cancelled');
    return new Response(null, { status: 101, webSocket: client });
  }

  if (session.status === 'completed') {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.send(
      JSON.stringify({
        event: 'finished',
        session_id: sessionId,
        status: 'completed',
        total_steps: Number(session.step_count) || 0,
        step_count: Number(session.step_count) || 0,
        summary_message: 'งานเสร็จสมบูรณ์เรียบร้อยแล้ว',
      })
    );
    server.close(1000, 'Session already completed');
    return new Response(null, { status: 101, webSocket: client });
  }

  // 6. Create native Cloudflare Workers WebSocketPair
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // Accept server-side WebSocket to receive/send frames
  server.accept();

  // Create AbortController for lifecycle and delay cancellation
  const abortController = new AbortController();

  // Register session into in-memory wsRegistry for cross-request cancellation
  registerSession(sessionId, {
    ws: server,
    abortController,
    userId: payload.sub,
  });

  // 7. Send initial connected event
  server.send(
    JSON.stringify({
      event: 'connected',
      session_id: sessionId,
      status: 'running',
      message: 'Connected to task log stream',
    })
  );

  // 8. Attach event listeners on server WebSocket
  server.addEventListener('message', async (event) => {
    try {
      const rawData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
      let data;
      try {
        data = JSON.parse(rawData);
      } catch {
        if (rawData.trim() === 'ping') {
          server.send(JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }));
        } else {
          try {
            server.send(
              JSON.stringify({
                event: 'error',
                message: 'Invalid message format',
              })
            );
          } catch (_) {}
        }
        return;
      }

      if (!data || typeof data !== 'object') {
        try {
          server.send(
            JSON.stringify({
              event: 'error',
              message: 'Invalid message format',
            })
          );
        } catch (_) {}
        return;
      }

      // Ping / Pong heartbeat
      if (data.event === 'ping' || data.type === 'ping') {
        server.send(
          JSON.stringify({
            event: 'pong',
            timestamp: new Date().toISOString(),
          })
        );
        return;
      }

      // In-band task cancellation from client
      if (data.event === 'cancel' || data.action === 'cancel') {
        const now = new Date().toISOString();
        await env.DB.prepare(
          `UPDATE sessions SET status = 'cancelled', ended_at = ? WHERE id = ? AND user_id = ?`
        )
          .bind(now, sessionId, payload.sub)
          .run();

        cancelActiveSession(sessionId);
        return;
      }
    } catch (err) {
      console.error(`[ws] Error handling message for session ${sessionId}:`, err);
    }
  });

  server.addEventListener('close', () => {
    removeSession(sessionId, server);
    abortController.abort();
  });

  server.addEventListener('error', (err) => {
    console.warn(`[ws] Socket error for session ${sessionId}:`, err);
    removeSession(sessionId, server);
    abortController.abort();
  });

  // 9. Start background mock log streaming via ctx.waitUntil
  const streamingPromise = streamMockLogs(
    sessionId,
    payload.sub,
    server,
    env,
    abortController.signal
  );

  if (ctx && typeof ctx.waitUntil === 'function') {
    ctx.waitUntil(streamingPromise);
  }

  // 10. Complete WebSocket handshake with HTTP 101 Switching Protocols
  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}

/**
 * Streams sequential mock log events into the WebSocket and persists each step to Cloudflare D1.
 *
 * @param {string} sessionId
 * @param {string} userId
 * @param {WebSocket} server
 * @param {Record<string, any>} env
 * @param {AbortSignal} signal
 * @returns {Promise<void>}
 */
async function streamMockLogs(sessionId, userId, server, env, signal) {
  try {
    // 1. Query existing progress from D1 before streaming to support seamless reconnection
    const sessionRow = await env.DB.prepare(
      `SELECT step_count, status FROM sessions WHERE id = ? AND user_id = ?`
    )
      .bind(sessionId, userId)
      .first();

    if (!sessionRow || sessionRow.status !== 'running') {
      removeSession(sessionId, server);
      return;
    }

    const maxStepRow = await env.DB.prepare(
      `SELECT COALESCE(MAX(step_no), 0) AS max_step FROM task_steps WHERE session_id = ?`
    )
      .bind(sessionId)
      .first();

    const startStep = Math.max(Number(sessionRow?.step_count) || 0, Number(maxStepRow?.max_step) || 0);
    const remainingSteps = MOCK_STEPS.filter((s) => s.step_no > startStep);

    for (const step of remainingSteps) {
      // Check if aborted before delay
      if (signal.aborted) {
        return;
      }

      // Delay ~400ms between steps (abortable)
      const delayFinished = await abortableSleep(400, signal);
      if (!delayFinished || signal.aborted) {
        return;
      }

      // Check D1 session status for edge isolate resilience
      const currentSession = await env.DB.prepare(
        `SELECT status FROM sessions WHERE id = ? AND user_id = ?`
      )
        .bind(sessionId, userId)
        .first();

      if (!currentSession || currentSession.status === 'cancelled') {
        try {
          server.send(
            JSON.stringify({
              event: 'cancelled',
              session_id: sessionId,
              status: 'cancelled',
              summary_message: 'งานถูกยกเลิกโดยผู้ใช้',
            })
          );
          server.close(1000, 'Task cancelled');
        } catch {}
        removeSession(sessionId, server);
        return;
      }

      if (currentSession.status !== 'running') {
        removeSession(sessionId, server);
        return;
      }

      // Persist step into task_steps and increment sessions.step_count via env.DB.batch
      const stepId = crypto.randomUUID();
      const timestamp = new Date().toISOString();

      await env.DB.batch([
        env.DB.prepare(
          `INSERT OR IGNORE INTO task_steps (id, session_id, step_no, action_type, log_message, is_risky, verified_changed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          stepId,
          sessionId,
          step.step_no,
          step.action_type,
          step.log_message,
          step.is_risky ? 1 : 0,
          step.verified_changed ? 1 : 0,
          timestamp
        ),
        env.DB.prepare(
          `UPDATE sessions SET step_count = ? WHERE id = ? AND status = 'running'`
        ).bind(step.step_no, sessionId),
      ]);

      // Check aborted before sending frame
      if (signal.aborted) {
        return;
      }

      // Send log frame over WebSocket
      try {
        server.send(
          JSON.stringify({
            event: 'log',
            session_id: sessionId,
            step_no: step.step_no,
            log_message: step.log_message,
            timestamp,
            is_risky: Boolean(step.is_risky),
            action_type: step.action_type,
          })
        );
      } catch (err) {
        console.warn(`[ws] Failed to send log step ${step.step_no} for session ${sessionId}:`, err);
        return;
      }
    }

    // Verify session state before finalizing
    if (signal.aborted) {
      return;
    }

    const finalSession = await env.DB.prepare(
      `SELECT status FROM sessions WHERE id = ? AND user_id = ?`
    )
      .bind(sessionId, userId)
      .first();

    if (!finalSession || finalSession.status !== 'running') {
      removeSession(sessionId, server);
      return;
    }

    // Finalize session in D1 atomically
    const endedAt = new Date().toISOString();
    const updateResult = await env.DB.prepare(
      `UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'running'`
    )
      .bind(endedAt, sessionId, userId)
      .run();

    if (updateResult && updateResult.meta && updateResult.meta.changes === 0) {
      removeSession(sessionId, server);
      return;
    }

    // Send finished frame and close socket cleanly
    try {
      server.send(
        JSON.stringify({
          event: 'finished',
          session_id: sessionId,
          status: 'completed',
          total_steps: MOCK_STEPS.length,
          step_count: MOCK_STEPS.length,
          summary_message: 'งานเสร็จสมบูรณ์เรียบร้อยแล้ว',
        })
      );
      server.close(1000, 'Task completed successfully');
    } catch (err) {
      console.warn(`[ws] Failed to send finished event for session ${sessionId}:`, err);
    }

    removeSession(sessionId, server);
  } catch (err) {
    console.error(`[ws] Unhandled error during mock log streaming for ${sessionId}:`, err);
    removeSession(sessionId, server);
  }
}
