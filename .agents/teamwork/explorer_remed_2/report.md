# Remediation Architecture Report: Finding 2 & 3 (Duplicate WebSocket Connections & Registry Desynchronization)

- **Agent:** `explorer_remed_2` (Remediation Explorer & Systems Architect)
- **Target Repository:** `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend`
- **Working Directory:** `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\explorer_remed_2`
- **Date:** 2026-09-28T04:32:00Z
- **Reference Findings:** Reviewer 2 (Findings 2 & 3), Challenger 1 (Findings 2 & 3)
- **Files Under Scope:**
  - `src/utils/wsRegistry.js`
  - `src/routes/websocket.js`
  - `migrations/0001_initial_schema.sql`

---

## 1. Executive Summary

During Iteration 1 adversarial review of Epic 2 (Chat & Real-Time Communication System), Reviewer 2 and Challenger 1 identified two critical concurrency and lifecycle defects surrounding WebSocket reconnections:

1. **Finding 2 (Duplicate Connection Overwrite & Desynchronization):** When an active session reconnects (e.g. mobile client switching networks, page reload, or duplicate connection), `registerSession` unconditionally overwrites the in-memory `activeSessions` Map without aborting or closing the earlier socket. When the superseded socket closes, its `close` listener triggers `removeSession(sessionId)`, mistakenly evicting the *new* active connection from the registry. Subsequent REST cancellations (`POST /api/tasks/:id/cancel`) then fail to find or cancel the active session.
2. **Finding 3 (D1 Unique Constraint Collision on Reconnection):** `streamMockLogs` always starts iterating `MOCK_STEPS` from `step_no = 1`. If an in-progress session reconnects after partial execution (e.g. step 1 or 2 was committed), D1 rejects the step insert with SQLite error `UNIQUE constraint failed: task_steps.session_id, task_steps.step_no`, terminating the new stream prematurely.

This report establishes the exact, production-grade architectural strategy to eliminate these defects completely, including reference equality guards, safe teardown sequences, step progress resumption, and SQLite constraint resilience.

---

## 2. Root Cause Analysis (RCA)

### 2.1 Finding 2: In-Memory Registry Desynchronization & Leaked Sockets

#### File: `src/utils/wsRegistry.js` (lines 15–27, 45–47):
```javascript
export const activeSessions = new Map();

export function registerSession(sessionId, sessionData) {
  activeSessions.set(sessionId, sessionData); // Blind overwrite
  return sessionData;
}

export function removeSession(sessionId) {
  return activeSessions.delete(sessionId); // Blind eviction by sessionId only
}
```

#### File: `src/routes/websocket.js` (lines 196–200, 256–265):
```javascript
// Registration
registerSession(sessionId, {
  ws: server,
  abortController,
  userId: payload.sub,
});

// Event listeners
server.addEventListener('close', () => {
  removeSession(sessionId); // Closes over sessionId without reference verification
  abortController.abort();
});

server.addEventListener('error', (err) => {
  console.warn(`[ws] Socket error for session ${sessionId}:`, err);
  removeSession(sessionId);
  abortController.abort();
});
```

#### The Exact Race Condition Trace:
1. **Initial Connection (Socket A):**
   - Socket A completes handshake for `sessionId = "sess-1"`.
   - `registerSession("sess-1", { ws: wsA, abortController: acA, userId })` enters `activeSessions`.
   - `streamMockLogs` starts iterating for Socket A.
2. **Second Connection (Socket B - Reconnect):**
   - Client re-establishes connection for `sessionId = "sess-1"`.
   - Socket B completes handshake.
   - `registerSession("sess-1", { ws: wsB, abortController: acB, userId })` overwrites `activeSessions.get("sess-1")`.
   - Socket A is **not closed**, `acA` is **not aborted**.
   - Socket A continues running `streamMockLogs` concurrently with Socket B in the same isolate!
3. **Desynchronization Trigger (Socket A Closes):**
   - Socket A's connection terminates (either from network timeout, client closing the old connection, or server error).
   - Socket A's `'close'` event listener executes: `removeSession("sess-1")`.
   - `removeSession` deletes `"sess-1"` from `activeSessions`.
   - **Crucial Defect:** At this moment, `activeSessions.get("sess-1")` contained Socket B!
   - Now `activeSessions` has **zero** record of `"sess-1"`, despite Socket B being fully active and streaming.
4. **Catastrophic Failure on Cancellation:**
   - User issues REST `POST /api/tasks/sess-1/cancel`.
   - `handleCancelTask` in `src/routes/tasks.js` calls `cancelActiveSession("sess-1")`.
   - `cancelActiveSession` looks up `activeSessions.get("sess-1")` -> returns `undefined`.
   - Result: Socket B never receives `{ event: "cancelled" }`, `acB` is never aborted, and the active socket remains orphaned until task completion.

---

### 2.2 Finding 3: D1 SQLite Unique Constraint Collision on In-Flight Reconnection

#### File: `migrations/0001_initial_schema.sql` (line 52):
```sql
CREATE TABLE IF NOT EXISTS task_steps (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    step_no INTEGER NOT NULL,
    ...
    UNIQUE (session_id, step_no),
    ...
);
```

#### File: `src/routes/websocket.js` (lines 297–360):
```javascript
async function streamMockLogs(sessionId, userId, server, env, signal) {
  try {
    for (const step of MOCK_STEPS) { // Always iterates from step_no: 1
      ...
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO task_steps (id, session_id, step_no, action_type, log_message, is_risky, verified_changed, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(stepId, sessionId, step.step_no, ...)
      ]);
```

#### The Failure Trace:
1. Socket A streams Step 1 (`step_no: 1`) and Step 2 (`step_no: 2`). D1 persists rows `(sess-1, 1)` and `(sess-1, 2)`.
2. Socket A disconnects due to Wi-Fi jitter.
3. Socket B reconnects to `sess-1`. D1 status check confirms `status == 'running'`.
4. Socket B enters `streamMockLogs`.
5. Loop attempts to insert `MOCK_STEPS[0]` (`step_no: 1`).
6. D1 throws SQLite error: `UNIQUE constraint failed: task_steps.session_id, task_steps.step_no`.
7. Execution jumps to line 428 `catch (err)`: `[ws] Unhandled error during mock log streaming`.
8. The stream aborts, client receives no further logs, and the task never completes.

---

## 3. Remediation Strategy

### 3.1 Strategy for Finding 2: Safe Handover & Stale Eviction Prevention

To completely eliminate registry corruption and orphan streams, two coordinated mechanisms must be implemented:

#### Mechanism 1: Clean Pre-Registration Teardown (`registerSession`)
When a new connection arrives for an existing `sessionId`:
1. Check `activeSessions.has(sessionId)`.
2. Retrieve `existing = activeSessions.get(sessionId)`.
3. If `existing` exists and `existing.ws !== sessionData.ws`:
   - Immediately abort the previous controller: `existing.abortController?.abort()`.
   - Cleanly close the previous WebSocket: `existing.ws?.close(1000, 'Replaced by new connection')`.
   - Wrap both calls in defensive `try...catch` blocks to ensure stale or faulted sockets cannot interrupt the registration of the incoming socket.
4. Set the new session data into `activeSessions`: `activeSessions.set(sessionId, sessionData)`.

> **Order of Operations Rationale:**
> Calling `activeSessions.set(sessionId, sessionData)` ensures the registry is immediately updated with the new socket. Calling `abort()` stops the old stream loop at its next check (`signal.aborted` or `abortableSleep`), and `close(1000)` informs the old client cleanly.

#### Mechanism 2: Ownership Validation on Eviction (`removeSession`)
Enhance `removeSession` to accept an optional `ws` instance argument:
```javascript
export function removeSession(sessionId, ws = null) {
  const current = activeSessions.get(sessionId);
  if (!current) {
    return false;
  }
  // Guard against eviction race condition:
  // If a specific WebSocket instance is provided, only remove if the registered
  // session currently belongs to this WebSocket instance.
  if (ws && current.ws !== ws) {
    return false;
  }
  return activeSessions.delete(sessionId);
}
```

> **Why Object Reference Equality Works Perfectly:**
> In Cloudflare Workers, `new WebSocketPair()` creates distinct native `server` and `client` objects. When `removeSession(sessionId, server)` is called by Socket A's `'close'` or `'error'` listener, `current.ws` points to Socket B.
> Because `server_A !== server_B`, `removeSession` returns `false` and **does NOT evict Socket B**.
> When Socket B eventually closes, `current.ws === server_B`, and eviction proceeds normally.

#### Mechanism 3: Systematic Call-Site Update in `src/routes/websocket.js`
All cleanup locations in `websocket.js` must supply their `server` instance:
1. `server.addEventListener('close', () => { removeSession(sessionId, server); abortController.abort(); });`
2. `server.addEventListener('error', () => { removeSession(sessionId, server); abortController.abort(); });`
3. Inside `streamMockLogs(sessionId, userId, server, env, signal)`:
   - Line 330 (cancelled status check): `removeSession(sessionId, server)`
   - Line 335 (non-running status check): `removeSession(sessionId, server)`
   - Line 426 (successful completion cleanup): `removeSession(sessionId, server)`
   - Line 429 (unhandled error catch block): `removeSession(sessionId, server)`

---

### 3.2 Strategy for Finding 3: Resilient Stream Resumption & Conflict Handling

To support seamless reconnection to in-flight sessions without crashing D1 constraints:

#### Mechanism 1: Step Progress Resumption
At the beginning of `streamMockLogs`:
1. Query `sessions.step_count` for `sessionId`:
   ```javascript
   const initialSession = await env.DB.prepare(
     `SELECT status, step_count FROM sessions WHERE id = ? AND user_id = ?`
   ).bind(sessionId, userId).first();
   ```
2. If `initialSession.status !== 'running'`, exit immediately.
3. Compute `startStep = Number(initialSession.step_count) || 0`.
4. Filter `remainingSteps`:
   ```javascript
   const remainingSteps = MOCK_STEPS.filter((s) => s.step_no > startStep);
   ```
   - If `startStep === 0`: executes steps 1 through 5.
   - If `startStep === 2`: resumes with steps 3, 4, 5.
   - If `startStep >= 5`: skips the loop and proceeds directly to completion.

#### Mechanism 2: Database Conflict Resilience (`INSERT OR IGNORE`)
In `streamMockLogs` line 344:
Change `INSERT INTO task_steps` to:
```sql
INSERT OR IGNORE INTO task_steps (id, session_id, step_no, action_type, log_message, is_risky, verified_changed, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
```
This guarantees defense-in-depth: even in a multi-region edge scenario where two isolate loops briefly overlap before cross-region abort propagation, SQLite ignores duplicate `(session_id, step_no)` pairs instead of terminating the execution with an uncaught constraint violation.

#### Mechanism 3: Atomic Task Finalization Check
In `streamMockLogs` line 404:
Update the finalization SQL to:
```sql
UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'running'
```
This protects against TOCTOU race conditions where a concurrent REST cancellation occurred while the final step was persisting.

---

## 4. Exact Implementation Blueprint (Before vs. After)

### 4.1 Target File: `src/utils/wsRegistry.js`

#### Complete Proposed Implementation:
```javascript
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
    try {
      existing.abortController?.abort();
    } catch (err) {
      console.warn(`[wsRegistry] Failed to abort previous controller for ${sessionId}:`, err);
    }
    try {
      existing.ws?.close(1000, 'Replaced by new connection');
    } catch (err) {
      console.warn(`[wsRegistry] Failed to close previous WebSocket for ${sessionId}:`, err);
    }
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

  // 1. Send cancellation frame to client
  try {
    session.ws.send(
      JSON.stringify({
        event: 'cancelled',
        session_id: sessionId,
        status: 'cancelled',
        summary_message: 'งานถูกยกเลิกโดยผู้ใช้',
      })
    );
  } catch (err) {
    console.warn(`[wsRegistry] Failed to send cancel frame for session ${sessionId}:`, err);
  }

  // 2. Abort controller to halt any active delay or background task loop
  try {
    session.abortController?.abort();
  } catch (err) {
    console.warn(`[wsRegistry] Failed to abort controller for session ${sessionId}:`, err);
  }

  // 3. Close the WebSocket connection cleanly
  try {
    session.ws.close(1000, 'Task cancelled by user');
  } catch (err) {
    console.warn(`[wsRegistry] Failed to close WebSocket for session ${sessionId}:`, err);
  }

  // 4. Remove from active registry safely
  removeSession(sessionId, session.ws);
  return true;
}
```

---

### 4.2 Target File: `src/routes/websocket.js`

#### Code Changes Required:

1. **Event Listeners in `handleWebSocketRoute` (around lines 256–265):**
```javascript
  // BEFORE:
  server.addEventListener('close', () => {
    removeSession(sessionId);
    abortController.abort();
  });

  server.addEventListener('error', (err) => {
    console.warn(`[ws] Socket error for session ${sessionId}:`, err);
    removeSession(sessionId);
    abortController.abort();
  });

  // AFTER:
  server.addEventListener('close', () => {
    removeSession(sessionId, server);
    abortController.abort();
  });

  server.addEventListener('error', (err) => {
    console.warn(`[ws] Socket error for session ${sessionId}:`, err);
    removeSession(sessionId, server);
    abortController.abort();
  });
```

2. **Step Progress Resumption & Conflict Handling in `streamMockLogs` (around lines 297–431):**
```javascript
async function streamMockLogs(sessionId, userId, server, env, signal) {
  try {
    // 1. Query initial session state to support seamless mid-flight reconnection
    const initialSession = await env.DB.prepare(
      `SELECT status, step_count FROM sessions WHERE id = ? AND user_id = ?`
    )
      .bind(sessionId, userId)
      .first();

    if (!initialSession || initialSession.status !== 'running') {
      removeSession(sessionId, server);
      return;
    }

    const startStep = Number(initialSession.step_count) || 0;
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

      // Persist step into task_steps with INSERT OR IGNORE and increment sessions.step_count
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
          `UPDATE sessions SET step_count = ? WHERE id = ?`
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
      return;
    }

    // Finalize session in D1 with atomic status check
    const endedAt = new Date().toISOString();
    await env.DB.prepare(
      `UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'running'`
    )
      .bind(endedAt, sessionId, userId)
      .run();

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
```

---

## 5. Lifecycle & Concurrency Verification Matrix

| Transition Event | Pre-Remediation State | Post-Remediation State | Verified Invariant |
|---|---|---|---|
| **Socket B connects while Socket A is active** | Socket A runs concurrently; Socket B overwrites map entry | Socket A controller aborted; Socket A closed (code 1000); Socket B registered | Zero duplicate background execution; Socket A halted immediately |
| **Socket A fires `close` event after Socket B connects** | `removeSession("sess-1")` deleted Socket B from map | `removeSession("sess-1", serverA)` compares `serverA !== serverB` and returns `false` | Socket B remains registered in `activeSessions` |
| **User calls `POST /api/tasks/:id/cancel` after reconnect** | Lookup failed (returned `undefined`), Socket B never cancelled | Lookup finds Socket B, delivers `{ event: "cancelled" }`, aborts, closes cleanly | Zero orphaned sockets; REST cancel always succeeds |
| **Socket B reconnects at Step 2 (`step_count = 2`)** | Socket B attempts step 1, crashes with `UNIQUE constraint failed` | `remainingSteps` filters to steps 3, 4, 5; `INSERT OR IGNORE` guards batch | Socket B receives remaining steps and completes normally |
| **User calls Cancel just as Step 5 finishes** | Status overwritten from `cancelled` to `completed` | `UPDATE ... AND status = 'running'` ignores update if status changed | Cancellation status is immutable |

---

## 6. Verification Plan & Test Commands

To verify the proposed implementation after application by `worker_1`:

1. **Standalone Epic 2 Test Suite:**
   ```bash
   node test_epic2.js --url http://127.0.0.1:8787
   ```
   *Expectation:* 25 of 25 tests pass with 0 failures (including TC-17 once Finding 1 is applied, and all cancellation tests TC-18, TC-19, TC-20).

2. **Adversarial & Stress Test Suite:**
   ```bash
   node test_adversarial_epic2.js --url http://127.0.0.1:8787
   ```
   *Expectation:* All 8 adversarial tests pass:
   - `ADV-01`: Rapid 10x connection churn without memory leaks or registry desync.
   - `ADV-02`: Midway socket abort cleanly handles background isolate termination.
   - `ADV-08`: 4 concurrent sessions across 2 users verify zero cross-talk and isolated cancellations.

3. **Dedicated Reconnection Verification Script:**
   Verify duplicate connection handover:
   - Connect Client A to task `sess_reconnect_1`.
   - Wait for Step 1 log frame.
   - Connect Client B to task `sess_reconnect_1`.
   - Assert Client A receives `close` with code 1000 and reason `'Replaced by new connection'`.
   - Issue `POST /api/tasks/sess_reconnect_1/cancel`.
   - Assert Client B receives `{ event: "cancelled" }` frame and closes.

---

## 7. Conclusion

The remediation strategy formulated above directly resolves Finding 2 and Finding 3. It establishes complete lifecycle integrity, guarantees atomic registry synchronization, and eliminates all SQLite constraint collisions during WebSocket reconnection.
