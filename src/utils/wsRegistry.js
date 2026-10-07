/**
 * In-memory WebSocket Session Registry for Hollis Backend.
 *
 * Tracks active WebSocket connections in memory:
 * sessionId -> { ws: WebSocket, abortController: AbortController, userId: string }
 *
 * Provides lifecycle coordination between REST cancellation endpoints
 * and active duplex WebSocket connections.
 */

/**
 * Registry mapping sessionId to active session metadata.
 * @type {Map<string, { ws: WebSocket, abortController: AbortController, userId: string }>}
 */
export const activeSessions = new Map();

/**
 * Registers an active WebSocket session in the registry.
 * If an active session already exists for this sessionId (duplicate connection or reconnect),
 * cleanly aborts and closes the previous connection before storing the new session.
 *
 * @param {string} sessionId
 * @param {{ ws: WebSocket, abortController: AbortController, userId: string }} sessionData
 * @returns {{ ws: WebSocket, abortController: AbortController, userId: string }}
 */
export function registerSession(sessionId, sessionData) {
  const existing = activeSessions.get(sessionId);

  // Store new session in registry first
  activeSessions.set(sessionId, sessionData);

  // If a previous connection existed for this sessionId, cleanly abort and close it
  if (existing && existing.ws !== sessionData.ws) {
    if (existing.agentLoop) {
      existing.agentLoop.isSuperseded = true;
    }
    try {
      existing.abortController?.abort();
    } catch (err) {
      console.warn(`[wsRegistry] Failed to abort previous controller for ${sessionId}:`, err);
    }
    try {
      existing.ws?.close(1000, 'Replaced by new connection');
    } catch (_) {}
  }

  return sessionData;
}

/**
 * Retrieves an active WebSocket session by its session ID.
 *
 * @param {string} sessionId
 * @returns {{ ws: WebSocket, abortController: AbortController, userId: string } | undefined}
 */
export function getSession(sessionId) {
  return activeSessions.get(sessionId);
}

/**
 * Removes a session from the active registry.
 * If `ws` is provided, only removes the entry if it currently matches `ws`.
 * This prevents stale close events from superseded connections from evicting newly established active connections.
 *
 * @param {string} sessionId
 * @param {WebSocket} [ws] Optional WebSocket instance to verify before removal
 * @returns {boolean} True if a session was present and removed, false otherwise
 */
export function removeSession(sessionId, ws = null) {
  const current = activeSessions.get(sessionId);
  if (!current) {
    return false;
  }

  // Guard against evicting a newer active connection
  if (ws && current.ws !== ws) {
    return false;
  }

  return activeSessions.delete(sessionId);
}

/**
 * Cancels an active session:
 * 1. Pushes a JSON cancellation frame over the active WebSocket connection.
 * 2. Aborts the associated AbortController signal to stop pending async loops.
 * 3. Closes the WebSocket cleanly with code 1000.
 * 4. Removes the session from the in-memory registry.
 *
 * @param {string} sessionId
 * @returns {boolean} True if an active session was found and cancelled, false otherwise
 */
export function cancelActiveSession(sessionId) {
  const session = activeSessions.get(sessionId);
  if (!session) {
    return false;
  }

  // 1. Abort controller to signal the active WebSocket loop
  try {
    session.abortController?.abort();
  } catch (err) {
    console.warn(`[wsRegistry] Failed to abort controller for session ${sessionId}:`, err);
  }

  // 2. Attempt to push cancellation frame directly if running in same isolate
  try {
    session.ws.send(
      JSON.stringify({
        event: 'cancelled',
        session_id: sessionId,
        status: 'cancelled',
        summary_message: 'งานถูกยกเลิกโดยผู้ใช้',
      })
    );
  } catch (_) {}

  // 3. Attempt clean WebSocket closure
  try {
    session.ws.close(1000, 'Task cancelled by user');
  } catch (_) {}

  // 4. Remove from active registry safely
  removeSession(sessionId, session.ws);
  return true;
}
