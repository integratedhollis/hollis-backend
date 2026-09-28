# Handoff Report: Finding 1 (TC-17 Malformed JSON Failure Analysis)

**Author**: `explorer_remed_1` (Teamwork Explorer)  
**Date**: 2026-09-28T04:36:00Z  
**Target Repository**: `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend`  
**Working Directory**: `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\explorer_remed_1`  
**Recipient**: `parent` (`a2366ee2-004e-4b90-a6ad-3e1401fad7ea`)  
**Milestone**: Epic 2 Remediation - Finding 1 Investigation  
**Deliverable File**: `.agents/teamwork/explorer_remed_1/report.md`  

---

## 1. Observation

1. **Test Assertion in `test_epic2.js` (lines 858–867)**:
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

2. **Server Message Listener in `src/routes/websocket.js` (lines 213–225)**:
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

3. **Specification in `spec_miner_1/report.md`**:
   - Line 141 (§ 4 E18):
     `WS /ws/tasks/:id | Client sends malformed non-JSON frame | Server sends { "event": "error", "message": "Invalid JSON format" } without crashing`
   - Lines 388–395 (§ 6.2 Item 7):
     ```json
     {
       "event": "error",
       "message": "Invalid message format"
     }
     ```

4. **Test Readiness Matrix in `TEST_READY.md` (line 77)**:
   `TC-17 | 2 | Malformed frame resilience | WS /ws/tasks/:id | Non-JSON text receives { event: "error" } without server crash | spec_miner_1/report.md § 6.2`

5. **API Documentation Gap in `API_DOCUMENTATION.md` (lines 311–373)**:
   Section 3.3 documents `connected`, `log`, `finished`, `cancelled`, and `pong`, but completely omits `{ event: "error" }`.

---

## 2. Logic Chain

1. From **Observation 1**, `test_epic2.js` line 859 sends a non-JSON string `'This is not valid JSON string {{{'` to the server via WebSocket and invokes `client.waitForMessage((m) => m && m.event === 'error', 5000)`.
2. From **Observation 2**, `src/routes/websocket.js` line 218 attempts `JSON.parse(rawData)` on the incoming string, which throws a `SyntaxError`.
3. Inside the `catch` block (lines 219–224), the code checks `if (rawData.trim() === 'ping')`. Since `'This is not valid JSON string {{{'` does not equal `'ping'`, the condition evaluates to `false`.
4. Line 223 executes `return;` without calling `server.send(...)`.
5. Because no message is transmitted by the server, `client.waitForMessage` never detects a frame where `m.event === 'error'`.
6. After 5,000ms, the waiter rejects with `Timeout waiting for error event after 5000ms`.
7. Therefore, TC-17 deterministically fails, violating Acceptance Criterion AC-6 in `ORIGINAL_REQUEST.md` requiring `node test_epic2.js` to pass with 0 failures.
8. From **Observations 3 & 4**, both the architecture specification and test matrix specify that the server must emit `{ event: "error", message: "Invalid JSON format" }` (or `"Invalid message format"`) and keep the socket open (resilient error handling).
9. From **Observation 5**, `API_DOCUMENTATION.md` lacks documentation for `{ event: "error" }`, which must be updated alongside the code fix.

---

## 3. Caveats

- **Scope Boundary**: This investigation focuses strictly on Finding 1 (TC-17 malformed JSON failure) as requested in the mission. Related concurrency/reconnection findings identified by reviewers (duplicate socket registration and D1 unique constraint replay) are addressed by companion tasks.
- **Read-Only Constraint**: In compliance with the explorer archetype and user mission directives, no source code or documentation files outside `.agents/teamwork/explorer_remed_1/` were modified.
- **Dev Server Execution**: The local dev server command was not dynamically executed during this investigation because interactive terminal permissions were not granted; however, the logic failure is 100% deterministic and statically proven by direct code trace.

---

## 4. Conclusion

1. **Root Cause**: `src/routes/websocket.js` lines 218–224 lacks an `else` branch in the JSON parse error handler to transmit an error frame before returning.
2. **Actionable Fix**:
   - Update `src/routes/websocket.js` lines 217–227 to emit `{ event: "error", message: "Invalid JSON format" }` on parse error, and `{ event: "error", message: "Invalid message format" }` on non-object JSON payloads.
   - Do NOT close the WebSocket (`server.close()`) to maintain resilient error handling.
3. **Documentation Update**:
   - Update `API_DOCUMENTATION.md` Section 3.3 to add Event 6 `error` schema.
   - Update `API_DOCUMENTATION.md` Section 3.5 to include the `error` event handler in the OkHttp Android Kotlin sample.
4. **Deliverable**:
   Detailed analysis and diff patch are saved in `.agents/teamwork/explorer_remed_1/report.md`.

---

## 5. Verification Method

1. **Files to Inspect**:
   - `src/routes/websocket.js` lines 217–235
   - `API_DOCUMENTATION.md` Section 3.3 and 3.5
   - `test_epic2.js` lines 842–871
2. **Execution Command**:
   ```bash
   node test_epic2.js --url http://127.0.0.1:8787
   ```
3. **Pass Criteria**:
   - TC-17 passes in `< 500ms` without timeout.
   - `errorFrame !== null` is true.
   - `errorFrame.event === 'error'` is true.
4. **Invalidation Conditions**:
   - If the server closes the socket upon sending `{ event: "error" }`, TC-17 or downstream tests will fail.
   - If the event field is named other than `event: "error"`.
