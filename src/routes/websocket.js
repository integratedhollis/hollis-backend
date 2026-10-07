/**
 * WebSocket Task Gateway and Screen Control AI Agent Loop for Hollis Backend.
 *
 * Route: WS /ws/tasks/:session_id
 *
 * Implements:
 * - RFC 6455 WebSocket handshake via Cloudflare Workers WebSocketPair
 * - JWT authentication via query parameter ?token= or Authorization header
 * - D1 task session verification and strict user isolation
 * - In-memory session registry integration for cross-request cancellation and risk confirmation
 * - 5-Step AI Agent Loop (Observe -> Decide -> Risk -> Act -> Verify)
 * - Support for interactive client events (observe, action_done, confirm) and autonomous mode
 * - Application-level Ping/Pong heartbeats
 * - Graceful connection termination, cancellation handling, loop detection, and step limit enforcer
 */

import { authenticateToken } from '../auth/middleware.js';
import { errorResponse } from '../utils/response.js';
import { registerSession, removeSession, cancelActiveSession } from '../utils/wsRegistry.js';
import { AgentLoop } from '../ai/agentLoop.js';

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

  const authData = await authenticateToken(token, env);
  if (!authData || !authData.user) {
    return errorResponse('Unauthorized', 401, 'unauthorized');
  }

  const user = authData.user;

  // 4. Verify session existence and user ownership in Cloudflare D1
  const session = await env.DB.prepare(
    `SELECT id, user_id, status, instruction, step_count FROM sessions WHERE id = ?`
  )
    .bind(sessionId)
    .first();

  if (!session || session.user_id !== user.id) {
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

  // Fetch user settings (confirmation_mode, max_step_limit)
  const userSettings = (await env.DB.prepare(
    `SELECT confirmation_mode, max_step_limit FROM user_settings WHERE user_id = ?`
  ).bind(user.id).first()) || {
    confirmation_mode: 'popup',
    max_step_limit: 20,
  };

  // 6. Create native Cloudflare Workers WebSocketPair
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);

  // Accept server-side WebSocket to receive/send frames
  server.accept();

  // Create AbortController for lifecycle and delay cancellation
  const abortController = new AbortController();

  const isInteractiveRequested =
    url.searchParams.get('mode') === 'interactive' ||
    url.searchParams.get('interactive') === 'true';

  // Instantiate 5-Step Agent Loop Controller
  const agentLoop = new AgentLoop({
    sessionId,
    userId: user.id,
    instruction: session.instruction,
    ws: server,
    env,
    abortController,
    settings: userSettings,
    initialStepCount: Number(session.step_count) || 0,
  });

  if (isInteractiveRequested) {
    agentLoop.isInteractive = true;
  }

  // Register session into in-memory wsRegistry for cross-request cancellation & confirmation
  registerSession(sessionId, {
    ws: server,
    abortController,
    userId: user.id,
    agentLoop,
  });

  // 7. Send initial connected event
  server.send(
    JSON.stringify({
      event: 'connected',
      session_id: sessionId,
      status: 'running',
      message: 'Connected to Hollis AI Agent Loop',
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
          .bind(now, sessionId, user.id)
          .run();

        cancelActiveSession(sessionId);
        return;
      }

      // Epic 3 Interactive Protocol: Observe frame
      if (data.event === 'observe') {
        await agentLoop.handleObserve(data);
        return;
      }

      // Epic 3 Interactive Protocol: Action Done frame
      if (data.event === 'action_done') {
        agentLoop.handleActionDone(data);
        return;
      }

      // Epic 3 Interactive Protocol: Risk confirmation
      if (data.event === 'confirm') {
        agentLoop.handleConfirm(data);
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

  // 9. Start autonomous execution if client has not declared interactive mode
  if (!isInteractiveRequested) {
    const autonomousPromise = agentLoop.startAutonomousIfNeeded(350);
    if (ctx && typeof ctx.waitUntil === 'function') {
      ctx.waitUntil(autonomousPromise);
    }
  }

  // 10. Complete WebSocket handshake with HTTP 101 Switching Protocols
  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
