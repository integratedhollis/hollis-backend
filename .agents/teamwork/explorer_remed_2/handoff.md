# Handoff Report: Remediation Strategy for Finding 2 & 3

- **Agent:** `explorer_remed_2` (Remediation Explorer & Systems Architect)
- **Recipient:** `parent` (`a2366ee2-004e-4b90-a6ad-3e1401fad7ea`)
- **Working Directory:** `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\explorer_remed_2`
- **Date:** 2026-09-28T04:33:00Z
- **Handoff Type:** Hard (Task Complete)

---

## 1. Observation

1. **Unconditional Map Overwrite in Session Registry**:
   - In `src/utils/wsRegistry.js` (lines 15, 24–27):
     ```javascript
     export const activeSessions = new Map();
     export function registerSession(sessionId, sessionData) {
       activeSessions.set(sessionId, sessionData);
       return sessionData;
     }
     ```
   - In `src/routes/websocket.js` (lines 196–200):
     ```javascript
     registerSession(sessionId, {
       ws: server,
       abortController,
       userId: payload.sub,
     });
     ```
   - Direct observation: When a client connects a second socket for the same `sessionId`, `registerSession` unconditionally overwrites the map entry without calling `abort()` on the previous controller or `close()` on the previous WebSocket.

2. **Blind Eviction in `removeSession` and Event Listeners**:
   - In `src/utils/wsRegistry.js` (lines 45–47):
     ```javascript
     export function removeSession(sessionId) {
       return activeSessions.delete(sessionId);
     }
     ```
   - In `src/routes/websocket.js` (lines 256–265):
     ```javascript
     server.addEventListener('close', () => {
       removeSession(sessionId);
       abortController.abort();
     });

     server.addEventListener('error', (err) => {
       console.warn(`[ws] Socket error for session ${sessionId}:`, err);
       removeSession(sessionId);
       abortController.abort();
     });
     ```
   - Direct observation: When an earlier socket closes, its `close` handler triggers `removeSession(sessionId)`, deleting the registry entry even if a new active connection was registered for that `sessionId`.

3. **Database Unique Constraint on Task Steps**:
   - In `migrations/0001_initial_schema.sql` (lines 42–56, specifically line 52):
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
   - In `src/routes/websocket.js` (lines 297–360):
     ```javascript
     async function streamMockLogs(sessionId, userId, server, env, signal) {
       try {
         for (const step of MOCK_STEPS) {
           ...
           await env.DB.batch([
             env.DB.prepare(
               `INSERT INTO task_steps (id, session_id, step_no, action_type, log_message, is_risky, verified_changed, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
             ).bind(...)
     ```
   - Direct observation: `streamMockLogs` always iterates `MOCK_STEPS` from `step_no = 1`. If an in-progress session reconnects after partial execution (e.g. step 1 was committed), D1 rejects the insert with `UNIQUE constraint failed: task_steps.session_id, task_steps.step_no` and crashes the stream.

4. **Task Finalization Overwrite**:
   - In `src/routes/websocket.js` (lines 403–407):
     ```javascript
     await env.DB.prepare(
       `UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ? AND user_id = ?`
     )
       .bind(endedAt, sessionId, userId)
       .run();
     ```
   - Direct observation: The UPDATE statement lacks `AND status = 'running'`, creating a TOCTOU race condition against asynchronous REST cancellations.

---

## 2. Logic Chain

1. **From Observation 1 & 2 to Registry Desynchronization & Orphan Streams**:
   - When a client reconnects or opens a duplicate socket (Socket B) while Socket A is active, `registerSession` places Socket B in `activeSessions`.
   - Socket A is neither aborted nor closed, causing both Socket A and Socket B to stream logs simultaneously in the edge isolate.
   - When Socket A eventually drops or terminates, its `'close'` event listener executes `removeSession(sessionId)`.
   - Because `removeSession` only takes `sessionId`, it deletes `activeSessions.get(sessionId)` — which at that moment points to Socket B.
   - A subsequent `POST /api/tasks/:session_id/cancel` queries `activeSessions.get(sessionId)`, receives `undefined`, fails to push the cancellation frame, and fails to stop Socket B.
   - *Remediation logic*: In `registerSession`, abort and cleanly close (`code: 1000, reason: 'Replaced by new connection'`) the existing socket before setting the new one. In `removeSession(sessionId, ws = null)`, check reference equality (`if (ws && current.ws !== ws) return false`). Update all call sites in `websocket.js` to pass `server`.

2. **From Observation 3 to SQLite Unique Constraint Failure**:
   - When an active session reconnects after step 1 or 2 is committed, `handleWebSocketRoute` allows connection because `session.status` is `'running'`.
   - `streamMockLogs` starts from `MOCK_STEPS[0]` (`step_no: 1`) and executes `INSERT INTO task_steps ... VALUES (..., sessionId, 1, ...)`.
   - SQLite enforces `UNIQUE (session_id, step_no)` on `task_steps`.
   - The query throws an exception, hits the outer `catch (err)` block (`[ws] Unhandled error during mock log streaming`), and aborts the new stream prematurely.
   - *Remediation logic*: At the start of `streamMockLogs`, query `initialSession.step_count` from D1 and filter `remainingSteps = MOCK_STEPS.filter(s => s.step_no > startStep)`. In addition, change the SQL statement to `INSERT OR IGNORE INTO task_steps` for layered defense against cross-isolate race conditions.

3. **From Observation 4 to Status Inconsistency**:
   - If a cancellation request commits while the final step is streaming, an unconditional `UPDATE sessions SET status = 'completed'` overwrites `'cancelled'` with `'completed'`.
   - *Remediation logic*: Add `AND status = 'running'` to the UPDATE query.

---

## 3. Caveats

- **Scope Boundary**: Investigation was conducted in read-only mode per mission rules. Code changes were formulated as exact before-and-after blueprints in `report.md` for application by `worker_1`.
- **Finding 1 Relationship**: While this investigation focused on Findings 2 & 3, Finding 1 (missing `{ event: "error" }` frame on malformed JSON) remains a distinct blocker for TC-17 in `src/routes/websocket.js` (lines 218–224) and should be applied by `worker_1` concurrently.

---

## 4. Conclusion

The exact remediation strategy for Findings 2 & 3 has been fully designed and documented in:
`c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\explorer_remed_2\report.md`

### Summary of Solutions:
1. **Finding 2 (Duplicate WebSocket Connections & Registry Desync):**
   - **`wsRegistry.js` `registerSession`**: Detect existing session for `sessionId`, abort its controller (`existing.abortController?.abort()`), close its socket (`existing.ws?.close(1000, 'Replaced by new connection')`), and update `activeSessions`.
   - **`wsRegistry.js` `removeSession(sessionId, ws = null)`**: Add reference equality guard (`if (ws && current.ws !== ws) return false`).
   - **`websocket.js`**: Update `'close'` and `'error'` listeners and all `streamMockLogs` cleanups to pass `server` (`removeSession(sessionId, server)`).
2. **Finding 3 (Reconnection Unique Constraint Collision):**
   - **`websocket.js` `streamMockLogs`**: Query initial `step_count` from D1, filter `remainingSteps = MOCK_STEPS.filter(s => s.step_no > startStep)`.
   - **D1 Resilient Insert**: Use `INSERT OR IGNORE INTO task_steps` inside `env.DB.batch`.
   - **Atomic Completion**: Add `AND status = 'running'` to task completion UPDATE statement.

---

## 5. Verification Method

To independently verify the implementation:

1. **Inspect Blueprint File**:
   View `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\explorer_remed_2\report.md` for exact before/after code blocks.

2. **Automated E2E Suite Execution**:
   Once applied by `worker_1`:
   ```bash
   node test_epic2.js --url http://127.0.0.1:8787
   ```
   *Expected Result*: 25/25 tests pass (with 0 failures).

3. **Adversarial Stress Suite Execution**:
   ```bash
   node test_adversarial_epic2.js --url http://127.0.0.1:8787
   ```
   *Expected Result*: All 8 stress tests pass, specifically confirming zero regressions on `ADV-01` (rapid connection churn) and `ADV-02` (midway abort).

4. **Invalidation Conditions**:
   - If `removeSession` removes sessions without checking `ws` identity, stale close events will continue evicting active connections under reconnection churn.
   - If `streamMockLogs` does not filter by `step_count > startStep`, reconnecting to an in-flight session will consistently crash on `UNIQUE constraint failed: task_steps.session_id, task_steps.step_no`.
