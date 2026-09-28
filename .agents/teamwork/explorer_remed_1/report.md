# Remediation Recommendation Report: Finding 1 (TC-17 Malformed JSON Failure)

**Agent**: `explorer_remed_1`  
**Date**: 2026-09-28T04:35:00Z  
**Target Repository**: `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend`  
**Target Files**:
- `src/routes/websocket.js` (Lines 213–227)
- `API_DOCUMENTATION.md` (Section 3.3 & Section 3.5)
- `test_epic2.js` (Verification target TC-17)

---

## 1. Executive Summary

During the Epic 2 independent reviews, `reviewer_1`, `reviewer_2`, and `challenger_1` identified a blocking functional defect: when a WebSocket client sends a malformed (non-JSON) frame, `src/routes/websocket.js` catches the `SyntaxError` from `JSON.parse` and silently returns (`return;`). No `{ event: "error" }` response frame is transmitted back to the client.

This silent drop directly violates the behavioral contract defined in:
1. `TEST_READY.md` (Line 77, TC-17): *"Non-JSON text receives `{ event: "error" }` without server crash"*.
2. `spec_miner_1/report.md` (§ 4 E18 & § 6.2 Item 7): *"Client sends malformed non-JSON frame -> Server sends `{ "event": "error", "message": "Invalid JSON format" }` without crashing"*.
3. `test_epic2.js` (Lines 842–871, TC-17): The client dispatches `'This is not valid JSON string {{{'` and awaits an event where `m.event === 'error'` within 5,000ms.

Because no frame is emitted, `client.waitForMessage(...)` times out after 5,000ms, causing TC-17 to fail and preventing the milestone from satisfying the zero-failure acceptance criterion.

This report provides the exact root cause analysis, code diff specification for `src/routes/websocket.js`, and documentation update for `API_DOCUMENTATION.md`.

---

## 2. In-Depth Analysis of `test_epic2.js` (TC-17)

### 2.1 Test Definition (`test_epic2.js` lines 842–871)
```javascript
// TC-17: WebSocket resilient error handling: client sends malformed non-JSON frame
await runTest('TC-17', 'WebSocket error resilience: client sends non-JSON frame and receives { event: "error" }', async () => {
  const taskRes = await apiRequest('/api/tasks/start', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${shared.userA.accessToken}` },
    body: { instruction: 'ทดสอบ malformed frame resilience' },
  });
  assertStatus(taskRes, 201);
  const sessionId = taskRes.body.session_id;

  const wsUrl = getWsUrl(`/ws/tasks/${sessionId}?token=${shared.userA.accessToken}`);
  const client = new WsClient(wsUrl);
  await client.connect();

  await client.waitForMessage((m) => m && m.event === 'connected', 5000, 'connected event');

  // Send malformed raw text
  client.send('This is not valid JSON string {{{');

  // Server should respond with error frame
  const errorFrame = await client.waitForMessage(
    (m) => m && m.event === 'error',
    5000,
    'error event'
  );
  assert(errorFrame !== null, 'Client must receive error event for malformed input');

  client.close();
  await client.waitForClose();
});
```

### 2.2 Expected Contract & Protocol Requirements
1. **Event Name**: Must be strictly `"error"` (`m && m.event === 'error'`).
2. **Payload Structure**: Valid JSON object containing:
   ```json
   {
     "event": "error",
     "message": "Invalid JSON format"
   }
   ```
3. **Socket Lifecycle (Resilience)**:
   - The server **MUST NOT** close the WebSocket upon encountering a malformed frame.
   - The socket must remain open and operational so subsequent frames can still be exchanged, or until the client explicitly initiates a closure (`client.close(); await client.waitForClose()`).
   - This tests error resilience: server survives malformed data, informs the client, and keeps streaming.
4. **Heartbeat Non-JSON Compatibility**:
   - `src/routes/websocket.js` supports plain string `'ping'` (line 220). This convenience feature must continue to be preserved and respond with `{ event: "pong" }`.

---

## 3. Root Cause in `src/routes/websocket.js`

### Current Code (`src/routes/websocket.js` lines 213–227):
```javascript
213:   server.addEventListener('message', async (event) => {
214:     try {
215:       const rawData = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
216:       let data;
217:       try {
218:         data = JSON.parse(rawData);
219:       } catch {
220:         if (rawData.trim() === 'ping') {
221:           server.send(JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }));
222:         }
223:         return; // <--- DEFECT: Silently discards any non-JSON frame that is not 'ping'
224:       }
225: 
226:       if (!data || typeof data !== 'object') return; // <--- SECONDARY DEFECT: Silently discards non-object JSON
```

### Execution Trace when TC-17 Executes:
1. Client sends `'This is not valid JSON string {{{'`.
2. `rawData` is `'This is not valid JSON string {{{'`.
3. `JSON.parse(rawData)` throws `SyntaxError`.
4. Control enters `catch` block (line 219).
5. `rawData.trim() === 'ping'` evaluates to `false`.
6. Function hits `return;` at line 223.
7. Nothing is transmitted back to client.
8. `client.waitForMessage((m) => m && m.event === 'error', 5000)` times out after 5,000ms.
9. TC-17 fails with: `Timeout waiting for error event after 5000ms`.

---

## 4. Proposed Exact Fix for `src/routes/websocket.js`

### 4.1 Recommended Code Modification
In `src/routes/websocket.js`, replace lines 217–227 with:

```javascript
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
                message: 'Invalid JSON format',
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
```

### 4.2 Unified Diff Patch

```patch
--- a/src/routes/websocket.js
+++ b/src/routes/websocket.js
@@ -217,13 +217,29 @@ export async function handleWebSocketRoute(request, env, ctx, url) {
       try {
         data = JSON.parse(rawData);
       } catch {
         if (rawData.trim() === 'ping') {
           server.send(JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }));
+        } else {
+          try {
+            server.send(
+              JSON.stringify({
+                event: 'error',
+                message: 'Invalid JSON format',
+              })
+            );
+          } catch (_) {}
         }
         return;
       }
 
-      if (!data || typeof data !== 'object') return;
+      if (!data || typeof data !== 'object') {
+        try {
+          server.send(
+            JSON.stringify({
+              event: 'error',
+              message: 'Invalid message format',
+            })
+          );
+        } catch (_) {}
+        return;
+      }
```

### 4.3 Why this fix is safe and optimal
- **Non-blocking**: Maintains socket open state, fulfilling the resilience design requirement.
- **Defensive**: Handles both non-JSON string errors (`SyntaxError`) and non-object JSON payloads (`"hello"`, `123`, `null`).
- **Heartbeat preserved**: Raw text `'ping'` is still answered with `{ event: "pong" }`.
- **Exception safe**: Nested `try/catch` around `server.send` prevents socket state errors from escalating.

---

## 5. Required Specification Update for `API_DOCUMENTATION.md`

`API_DOCUMENTATION.md` Section 3.3 currently documents 5 server-to-client events:
1. `connected` (lines 313–322)
2. `log` (lines 324–338)
3. `finished` (lines 339–352)
4. `cancelled` (lines 353–364)
5. `pong` (lines 365–372)

The `error` event is completely undocumented. The following updates must be made:

### 5.1 Addition to Section 3.3 (`API_DOCUMENTATION.md`)
Insert after line 373:

```markdown
6. **Event: `error` (แจ้งเตือนข้อผิดพลาดของข้อความ / Invalid Message Format)**:
   ส่งเมื่อ Client ส่งข้อความที่ไม่ได้อยู่ในรูปแบบ JSON หรือ payload ไม่ถูกต้อง โดยที่การเชื่อมต่อ WebSocket ยังคงเปิดอยู่ ไม่ถูกตัดการเชื่อมต่อ (Resilient error handling)
   ```json
   {
     "event": "error",
     "message": "Invalid JSON format"
   }
   ```
   *ฟิลด์ข้อมูล*:
   * `event` (string): ค่าคงที่ `"error"`
   * `message` (string): รายละเอียดของข้อผิดพลาด เช่น `"Invalid JSON format"` หรือ `"Invalid message format"`

   *คำแนะนำ Android*: ใช้สำหรับดักจับข้อผิดพลาดในระดับ Application Payload บน WebSocket เมื่อส่งข้อมูลผิดรูปแบบ เพื่อแสดง Log หรือเตือนนักพัฒนา โดยไม่ต้องเริ่มต้นเชื่อมต่อ WebSocket ใหม่
```

### 5.2 Addition to Section 3.5 (Android Kotlin Sample Code)
In `API_DOCUMENTATION.md` lines 445–476 (`onMessage` handler), append the `"error"` branch to `when (json.optString("event"))`:

```kotlin
            "error" -> {
                val errMsg = json.optString("message")
                Log.w("HollisWS", "Server error warning: $errMsg")
            }
```

---

## 6. Verification and Validation Plan

### 6.1 Independent Verification Method
1. Start dev server:
   ```bash
   npx wrangler dev
   ```
2. Execute standalone Epic 2 test suite:
   ```bash
   node test_epic2.js --url http://127.0.0.1:8787
   ```
3. Verify TC-17 output:
   - TC-17 must pass in under 500ms (instead of timing out after 5,000ms).
   - Assertion `errorFrame !== null` succeeds.
   - Total test summary reports `Passed: 25`, `Failed: 0`.

### 6.2 Invalidation Conditions
- If the server closes the WebSocket with `server.close()` when emitting `{ event: "error" }`, TC-17 or resilient recovery scenarios will fail because the client expects the connection to remain open until explicitly closed by the client.
- If the event property is named something other than `"error"` (e.g. `type: "error"` or `status: "error"`), TC-17 predicate `m && m.event === 'error'` will fail.
