# Handoff Report: Independent Adversarial Review of Epic 2 (Chat & Real-time Communication)

- **Agent:** `reviewer_2` (Reviewer & Adversarial Critic)
- **Working Directory:** `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\reviewer_2`
- **Recipient:** `parent` (`a2366ee2-004e-4b90-a6ad-3e1401fad7ea`)
- **Date:** 2026-09-28T04:26:00Z
- **Verdict:** `Verdict: REQUEST_CHANGES`

---

## 1. Observation

1. **Test Suite Expectation vs. Implementation for Malformed Frames (TC-17)**:
   - In `test_epic2.js`, lines 843–871 (TC-17):
     ```javascript
     // Send malformed raw text
     client.send('This is not valid JSON string {{{');

     // Server should respond with error frame
     const errorFrame = await client.waitForMessage(
       (m) => m && m.event === 'error',
       5000,
       'error event'
     );
     assert(errorFrame !== null, 'Client must receive error event for malformed input');
     ```
   - In `TEST_READY.md`, line 77:
     `TC-17 | 2 | Malformed frame resilience | WS /ws/tasks/:id | Non-JSON text receives { event: "error" } without server crash | spec_miner_1/report.md § 6.2`
   - In `spec_miner_1/report.md`, lines 388–395:
     ```json
     {
       "event": "error",
       "message": "Invalid message format"
     }
     ```
   - In `src/routes/websocket.js`, lines 213–225:
     ```javascript
     server.addEventListener('message', async (event) => {
       try {
         const rawData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
         let data;
         try {
           data = JSON.parse(rawData);
         } catch {
           if (rawData.trim() === 'ping') {
             server.send(JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }));
           }
           return;
         }
     ```
     *Direct observation*: If `rawData` is `'This is not valid JSON string {{{'`, `JSON.parse` fails. The `catch` block checks for `'ping'` (which evaluates false) and immediately executes `return;`. No `{ event: "error" }` frame is ever transmitted.

2. **WebSocket Session Registry Teardown & Overwriting Behavior**:
   - In `src/utils/wsRegistry.js`, lines 15–27:
     ```javascript
     export const activeSessions = new Map();
     export function registerSession(sessionId, sessionData) {
       activeSessions.set(sessionId, sessionData);
       return sessionData;
     }
     ```
   - In `src/routes/websocket.js`, lines 196–200 & lines 256–259:
     ```javascript
     registerSession(sessionId, {
       ws: server,
       abortController,
       userId: payload.sub,
     });
     ...
     server.addEventListener('close', () => {
       removeSession(sessionId);
       abortController.abort();
     });
     ```
     *Direct observation*: If a client connects a second socket for the same `sessionId`, `registerSession` unconditionally overwrites the entry in `activeSessions` without closing or aborting the previous socket. When the earlier socket closes, its `close` handler triggers `removeSession(sessionId)`, purging the entry for the *second* socket.

3. **Database Schema Constraint on Reconnection & Concurrent Streaming**:
   - In `migrations/0001_initial_schema.sql`, line 52:
     ```sql
     UNIQUE (session_id, step_no)
     ```
   - In `src/routes/websocket.js`, lines 297–361 (`streamMockLogs`):
     ```javascript
     for (const step of MOCK_STEPS) {
       ...
       await env.DB.batch([
         env.DB.prepare(
           `INSERT INTO task_steps (id, session_id, step_no, action_type, log_message, is_risky, verified_changed, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
         ).bind(...)
       ]);
     ```
     *Direct observation*: `streamMockLogs` always starts iterating `MOCK_STEPS` from `step_no = 1`. If an in-progress session reconnects after partial execution (e.g. step 1 or 2 was already committed), D1 rejects the `INSERT` with SQLite error `UNIQUE constraint failed: task_steps.session_id, task_steps.step_no`.

4. **Task Finalization Overwrite Condition**:
   - In `src/routes/websocket.js`, lines 403–407:
     ```javascript
     const endedAt = new Date().toISOString();
     await env.DB.prepare(
       `UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ? AND user_id = ?`
     )
       .bind(endedAt, sessionId, userId)
       .run();
     ```
     *Direct observation*: The UPDATE statement does not include `AND status = 'running'`. If a cancellation via `POST /api/tasks/:session_id/cancel` commits between the pre-check at line 397 and line 404, the status is unconditionally overwritten to `'completed'`.

5. **Android Documentation Gaps**:
   - In `API_DOCUMENTATION.md`, section 3.3.1 (lines 311–373), events `connected`, `log`, `finished`, `cancelled`, and `pong` are defined, but the `error` event payload is completely absent.

6. **Integrity & Anti-Cheat Audit**:
   - Grep searches across `src/` for hardcoded test flags, test email domains (`hollis-test`), or bypassed logic returned 0 matches.
   - All cryptographic routines, JWT validations, D1 queries, and WebSocket frames utilize genuine Web APIs and standard Cloudflare Workers protocols.

---

## 2. Logic Chain

1. **From Observation 1 to TC-17 Failure**:
   - `test_epic2.js` TC-17 dispatches a malformed string (`'This is not valid JSON string {{{'`) over an active WebSocket and waits up to 5,000ms for a message with `m.event === 'error'`.
   - `src/routes/websocket.js` catches the `JSON.parse` error, checks for `'ping'`, and silently returns.
   - Because no frame is sent, `client.waitForMessage` in `test_epic2.js` will consistently time out after 5,000ms and fail.
   - Requirement AC-6 in `ORIGINAL_REQUEST.md` states: "`node test_epic2.js --url http://127.0.0.1:8787` passes all tests with 0 failures". Therefore, the project cannot achieve acceptance without resolving this discrepancy.

2. **From Observation 2 to Race Condition & Memory Registry Desynchronization**:
   - Mobile clients frequently re-establish connections upon network transitions (e.g. cellular to Wi-Fi).
   - If a new connection opens for an ongoing session without terminating the old socket, both sockets run `streamMockLogs` concurrently in the isolate.
   - When the old socket drops, its `close` listener invokes `removeSession(sessionId)`, evicting the *new* session from `activeSessions`.
   - A subsequent `POST /api/tasks/:session_id/cancel` call will query `activeSessions.get(sessionId)`, receive `undefined`, fail to push the cancellation frame, and fail to terminate the active socket.

3. **From Observation 3 to SQLite Unique Constraint Failure**:
   - Because `streamMockLogs` begins at step 1 regardless of `session.step_count`, reconnecting to an active session that has already emitted steps triggers a crash on `task_steps` `UNIQUE (session_id, step_no)`.
   - The error is trapped by the outer catch block (`[ws] Unhandled error during mock log streaming`), terminating the stream prematurely.

4. **From Observation 4 to State Inconsistency**:
   - Unconditional `UPDATE sessions SET status = 'completed'` without verifying `AND status = 'running'` creates a classic time-of-check to time-of-use (TOCTOU) race condition against asynchronous REST cancellation requests.

---

## 3. Caveats

- **Dev Server Execution**: The dev server command (`wrangler dev`) was not actively executing in this review session due to tool permission constraints. However, the identified defects were discovered through rigorous static analysis, direct AST trace against test assertions, and contract comparison between `test_epic2.js`, `TEST_READY.md`, `spec_miner_1/report.md`, and `src/routes/websocket.js`.
- **Single Edge Isolate Scope**: The in-memory `activeSessions` Map is local to the Workers isolate. In multi-region deployments, cross-isolate cancellation relies on the D1 poll check inside `streamMockLogs`, which is properly implemented.

---

## 4. Conclusion & Findings

### Verdict
`Verdict: REQUEST_CHANGES`

The implementation in `src/routes/websocket.js` and `src/utils/wsRegistry.js` has high code quality and correct multi-tenant security isolation, but contains 1 test-breaking bug and 2 significant concurrency/reconnection flaws that must be addressed by `worker_1`.

### Summary of Required Changes

#### Finding 1 [Critical] - Missing Error Frame on Malformed Input (TC-17 Timeout Failure)
- **Where**: `src/routes/websocket.js`, lines 219–224.
- **Why**: Malformed text input is silently discarded instead of returning `{ event: "error", message: "Invalid message format" }`. Causes TC-17 in `test_epic2.js` to time out and fail.
- **Suggestion**:
  ```javascript
  } catch {
    if (rawData.trim() === 'ping') {
      server.send(JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }));
      return;
    }
    try {
      server.send(JSON.stringify({
        event: 'error',
        message: 'Invalid message format',
      }));
    } catch {}
    return;
  }
  ```

#### Finding 2 [Major] - Duplicate WebSocket Connection Corrupts `activeSessions` and Orphan Streams
- **Where**: `src/routes/websocket.js`, lines 196–200 and `src/utils/wsRegistry.js`.
- **Why**: Reconnecting sockets overwrite `activeSessions` without closing prior sockets. The old socket's `close` handler subsequently deletes the new socket from the registry.
- **Suggestion**: Before `registerSession`, check if an active session exists. If found, abort its controller and close the old socket:
  ```javascript
  const existing = getSession(sessionId);
  if (existing) {
    try {
      existing.abortController?.abort();
      existing.ws?.close(1000, 'Replaced by new connection');
    } catch {}
    removeSession(sessionId);
  }
  ```

#### Finding 3 [Major] - Reconnection to In-Flight Session Causes D1 Unique Constraint Violation
- **Where**: `src/routes/websocket.js`, lines 297–310.
- **Why**: `streamMockLogs` always starts from step 1. If steps were already persisted, D1 throws `UNIQUE constraint failed: task_steps.session_id, task_steps.step_no`.
- **Suggestion**: Filter `MOCK_STEPS` based on current `session.step_count`:
  ```javascript
  const startStep = Number(session.step_count) || 0;
  const remainingSteps = MOCK_STEPS.filter((s) => s.step_no > startStep);
  for (const step of remainingSteps) { ... }
  ```

#### Finding 4 [Minor] - Atomic Task Finalization (Prevent Cancellation Overwrite)
- **Where**: `src/routes/websocket.js`, lines 403–407.
- **Why**: Protect against TOCTOU race conditions where cancellation commits just before finalization.
- **Suggestion**: Add `AND status = 'running'` to the SQL statement:
  ```sql
  UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ? AND user_id = ? AND status = 'running'
  ```

#### Finding 5 [Minor] - Document WebSocket Error Event in API Documentation
- **Where**: `API_DOCUMENTATION.md`, section 3.3.1.
- **Suggestion**: Add specification for `{ event: "error", message: string }`.

---

## 5. Verification Method

To verify these findings and confirm remediation:

1. **Verify TC-17 Defect**:
   - Inspect `test_epic2.js` line 863.
   - Inspect `src/routes/websocket.js` line 220. Note the absence of `server.send` with `event: 'error'`.
2. **Execute Full Test Suite**:
   ```bash
   node test_epic2.js --url http://127.0.0.1:8787
   ```
   Confirm TC-17 passes once Finding 1 is applied.
3. **Invalidation Conditions**:
   - If `test_epic2.js` TC-17 is modified to no longer expect `{ event: "error" }`, this finding would be invalidated (though that would violate specification contracts in `spec_miner_1/report.md` § 6.2).
