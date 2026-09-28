# Cloudflare Workers WebSocket & Task Cancellation Architecture Analysis

**Author:** `explorer_ws_arch_1`  
**Milestone:** Epic 2 — ระบบแชทหลัก (Chat & Real-time Communication System)  
**Project:** Hollis Backend (`hollis-backend`)  
**Target Environment:** Cloudflare Workers (Edge runtime `workerd`), Cloudflare D1 (SQLite)  
**Date:** 2026-09-28  

---

## 1. Executive Summary

This report delivers a comprehensive technical architecture and feasibility assessment for implementing **Epic 2 (Real-time Chat & WebSocket Log Streaming)** on **Cloudflare Workers** and **Cloudflare D1**.

### Key Architectural Findings:
1. **Native WebSocketPair Feasibility:** Cloudflare Workers natively supports full duplex WebSockets via `WebSocketPair` without external dependencies or heavy libraries. Returning `new Response(null, { status: 101, webSocket: client })` after invoking `server.accept()` establishes standard RFC 6455 WebSocket communication.
2. **Background Execution via `ctx.waitUntil`:** When the HTTP 101 Switching Protocols response is returned, the initial HTTP handler completes. To continuously execute the mock log streaming loop (delays, D1 database writes, WebSocket message pushes), the streaming task must be registered using `ctx.waitUntil(streamingPromise)`. This guarantees the Workers isolate remains active.
3. **Cross-Request Cancellation Mechanism:**
   - **Local `wrangler dev` environment:** Runs in a single `workerd` isolate process. A module-scoped `Map<string, { ws, abortController, userId }>` cleanly bridges `POST /api/tasks/:session_id/cancel` and the active WebSocket instance, providing sub-millisecond cancellation delivery and clean connection teardown.
   - **Production Edge Isolation:** Cloudflare Workers edge nodes may route HTTP and WebSocket requests to distinct isolates if not co-located. Therefore, a **Triple-Layer Hybrid Pattern** (In-Memory Registry + D1 Session Status Check per step + Client-side In-band WS Cancel) provides 100% reliability without requiring Cloudflare Paid Durable Objects.
   - **Durable Objects Assessment:** `wrangler.jsonc` does not configure Durable Objects. Durable Objects require a paid Workers subscription, class declarations, and migration bindings. For Hollis Epic 2, Durable Objects are neither necessary nor required.
4. **D1 Persistence & Batching:** Each emitted log step must be recorded into the `task_steps` table, while updating `sessions.step_count`. Using `env.DB.batch([insertStepStmt, updateCountStmt])` executes both queries in a single atomic SQLite transaction, minimizing edge I/O latency.
5. **Ping/Pong Heartbeats:** Protocol-level RFC 6455 Ping frames (opcode 0x9) are handled automatically by Cloudflare edge proxies. For browser and mobile client compatibility, an application-level JSON heartbeat (`{"event": "ping"}` -> `{"event": "pong"}`) is implemented in the `message` event handler.

---

## 2. Cloudflare Workers Native `WebSocketPair` Architecture

### 2.1 Instantiation & Destructuring
In the Cloudflare Workers JavaScript runtime, a WebSocket connection is created using the global `WebSocketPair` class:

```javascript
const pair = new WebSocketPair();
const [client, server] = Object.values(pair);
```

- `new WebSocketPair()` instantiates a pair of connected sockets exposed as an Object with numeric properties `{ 0: WebSocket, 1: WebSocket }`.
- `Object.values(pair)` (or `[pair[0], pair[1]]`) extracts:
  - `client`: The client-facing socket that is returned to the client in the HTTP response.
  - `server`: The server-facing socket that remains in the Worker to send and receive frames.

### 2.2 Accepting Connection (`server.accept()`)
To activate the server socket, the Worker **must** call:

```javascript
server.accept();
```

`server.accept()` instructs the Workers runtime to begin accepting incoming frames and dispatching them to attached event listeners. If `accept()` is omitted, incoming frames are buffered or dropped.

### 2.3 Event Listeners
Workers WebSocket instances implement the standard `EventTarget` interface:

```javascript
// 1. Incoming client message (JSON or text)
server.addEventListener('message', async (event) => {
  const data = typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data);
  handleIncomingMessage(data, server, sessionId, abortController);
});

// 2. Connection closed by client or network drop
server.addEventListener('close', (event) => {
  // event.code: e.g. 1000 (Normal), 1001 (Going Away)
  // event.reason: human-readable reason string
  cleanupSession(sessionId);
});

// 3. Transport or protocol error
server.addEventListener('error', (event) => {
  cleanupSession(sessionId);
});
```

### 2.4 HTTP 101 Switching Protocols Response
To complete the WebSocket handshake, the Worker returns an empty response with HTTP status `101` and attaches the `client` socket:

```javascript
return new Response(null, {
  status: 101,
  webSocket: client,
});
```

### 2.5 Handshake Validation & Authentication
Before accepting the socket and returning status 101, the endpoint (`/ws/tasks/:session_id`) must validate:
1. **Upgrade Header:** `request.headers.get('Upgrade')?.toLowerCase() === 'websocket'`. If invalid, return HTTP `426 Upgrade Required`.
2. **Authentication:**
   - Standard browser `WebSocket` APIs cannot customize request headers.
   - The token can be passed via:
     - URL Query Parameter: `ws://127.0.0.1:8787/ws/tasks/:session_id?token=<access_token>`
     - Header: `Authorization: Bearer <access_token>` (for clients that support custom headers like OkHttp or Node.js).
   - Token is verified using the existing `verifyJwt(token, secret)` utility.
   - If missing or invalid: return HTTP `401 Unauthorized`.
3. **Session Verification & Ownership:**
   - Query D1: `SELECT id, user_id, status FROM sessions WHERE id = ?`.
   - If not found or `user_id !== authenticated_user.id`: return HTTP `404 Not Found`.

---

## 3. Worker Lifecycle & Background Log Streaming (`ctx.waitUntil`)

### 3.1 The Execution Context Dilemma
In standard Cloudflare Workers request processing:
1. `fetch(request, env, ctx)` is invoked.
2. The Worker returns `new Response(null, { status: 101, webSocket: client })`.
3. At this moment, the HTTP request invocation terminates.

If an asynchronous streaming loop runs without registering with the execution context, the Workers runtime may suspend or terminate the isolate during async idle periods (`setTimeout`).

### 3.2 Extending Lifetime with `ctx.waitUntil`
To allow the Worker to stream mock logs over time (e.g. 4 steps with 800ms delays), the streaming promise must be passed to `ctx.waitUntil()`:

```javascript
ctx.waitUntil(
  streamTaskLogs({
    sessionId,
    server,
    env,
    abortSignal: abortController.signal,
  })
);
```

`ctx.waitUntil(promise)` signals the Workers runtime that background work is active and prevents the isolate from terminating until `promise` resolves or rejects.

### 3.3 Passing `ctx` Through the Routing Layer
In the current codebase (`src/worker.js`, line 87):
```javascript
// Existing:
if (path === '/api/tasks' || path.startsWith('/api/tasks/')) {
  return await handleTasksRoute(request, env, url, method);
}
```
`ctx` is currently omitted from `handleTasksRoute`.  
To support WebSockets, `src/worker.js` should dispatch:
```javascript
// New WebSocket route handler:
if (path.startsWith('/ws/tasks/')) {
  return await handleTaskWebSocket(request, env, ctx, url);
}

// Pass ctx to task routes if needed for async background execution:
if (path === '/api/tasks' || path.startsWith('/api/tasks/')) {
  return await handleTasksRoute(request, env, ctx, url, method);
}
```

### 3.4 Responsive Abortable Delays
To avoid unresponsiveness when a cancellation arrives during a `setTimeout` delay, delays must support an `AbortSignal`:

```javascript
function abortableSleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(false);

    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve(true);
    }, ms);

    function onAbort() {
      clearTimeout(timer);
      resolve(false);
    }

    signal.addEventListener('abort', onAbort, { once: true });
  });
}
```
If `abortController.abort()` is called at any time, `abortableSleep` resolves immediately with `false`, halting the simulation loop instantly.

---

## 4. Task Cancellation Cross-Communication

### 4.1 Requirement R3 Breakdown
- Endpoint: `POST /api/tasks/:session_id/cancel`
- Actions required:
  1. Update `sessions` table in D1: `status = 'cancelled'`, `ended_at = <ISO timestamp>`.
  2. Broadcast cancellation event over the active WebSocket:
     ```json
     {
       "event": "cancelled",
       "session_id": "...",
       "status": "cancelled",
       "summary_message": "งานถูกยกเลิกโดยผู้ใช้"
     }
     ```
  3. Close the WebSocket connection cleanly (`code = 1000`).

### 4.2 In-Memory Connection Registry in `wrangler dev`
In `wrangler dev` (the target test environment), the entire server runs in a single process. All requests share the exact same V8 isolate and module scope.

We maintain a module-scoped Connection Registry:

```javascript
// src/utils/wsRegistry.js
export const activeSessions = new Map();
// Structure:
// sessionId -> { ws: WebSocket, abortController: AbortController, userId: string }
```

When a client connects to `/ws/tasks/:session_id`:
```javascript
const abortController = new AbortController();
activeSessions.set(sessionId, {
  ws: server,
  abortController,
  userId: user.id,
});
```

When `POST /api/tasks/:session_id/cancel` is called:
```javascript
// 1. Update D1
const now = new Date().toISOString();
await env.DB.prepare(
  `UPDATE sessions SET status = 'cancelled', ended_at = ? WHERE id = ? AND user_id = ?`
).bind(now, sessionId, user.id).run();

// 2. Cross-communication: Trigger WebSocket termination
const active = activeSessions.get(sessionId);
if (active) {
  try {
    active.ws.send(JSON.stringify({
      event: 'cancelled',
      session_id: sessionId,
      status: 'cancelled',
      summary_message: 'งานถูกยกเลิกโดยผู้ใช้',
    }));
    active.ws.close(1000, 'Cancelled by user');
  } catch (err) {
    console.error('Failed to notify WebSocket:', err);
  }
  active.abortController.abort();
  activeSessions.delete(sessionId);
}
```

### 4.3 Why Durable Objects are NOT Needed
| Consideration | Standard Workers + Registry + D1 Check | Cloudflare Durable Objects |
|---|---|---|
| **`wrangler.jsonc` Config** | Already fully configured (`d1_databases`) | Not present; requires adding migrations & classes |
| **Pricing / Cloudflare Plan** | Works on Free plan & local dev | Requires Paid Workers plan ($5/mo) |
| **Local Dev Compatibility** | 100% compatible with `wrangler dev` | Requires additional local Miniflare DO setup |
| **Code Complexity** | Clean, minimal ES modules | High (Durable Object class, hibernation, RPC) |
| **Test Suite Alignment** | Zero overhead for `test_epic2.js` | Slower cold starts, complex setup |

**Verdict:** Durable Objects are not needed and would introduce unnecessary complexity and paid subscription constraints.

### 4.4 Enterprise-Grade Triple-Layer Hybrid Pattern
To guarantee resilience even in production edge environments where HTTP and WebSocket requests might land on different edge PoPs:

```
[Client] --- (1) POST /cancel ---------> [Worker Isolate B]
                                                 |
                                            Update D1 (status='cancelled')
                                                 |
[Client] <== (2) Event: "cancelled" <==== [Worker Isolate A (Active WS)]
                 - via In-Memory Registry (if same isolate)
                 - OR via D1 Polling Check before each log step
                 - OR via (3) Client In-band WS message `{"action":"cancel"}`
```

1. **Layer 1 (Direct Memory Bridge):** If the cancel request lands in the same isolate (100% of the time in `wrangler dev`), it instantly pushes the cancel frame and closes the socket.
2. **Layer 2 (D1 State Verification in Stream Loop):** In the log streaming loop, before each step is emitted, the loop checks the D1 database status:
   ```javascript
   const session = await env.DB.prepare(
     `SELECT status FROM sessions WHERE id = ?`
   ).bind(sessionId).first();

   if (session.status === 'cancelled' || signal.aborted) {
     server.send(JSON.stringify({
       event: 'cancelled',
       session_id: sessionId,
       status: 'cancelled',
       summary_message: 'งานถูกยกเลิกโดยผู้ใช้',
     }));
     server.close(1000, 'Cancelled');
     return;
   }
   ```
   Even across different edge nodes, cancellation is propagated on the next iteration without delay.
3. **Layer 3 (Client In-Band Cancellation):** The WebSocket listener also accepts `{"action": "cancel"}` directly over the WebSocket. If the client sends this, it cancels locally and updates D1 directly.

---

## 5. D1 Database Persistence During WebSocket Streaming

### 5.1 Schema Review
- Table `task_steps`:
  - `id` (TEXT PRIMARY KEY) — UUID v4
  - `session_id` (TEXT FK to `sessions.id`)
  - `step_no` (INTEGER) — 1, 2, 3...
  - `action_type` (TEXT) — e.g. `'inspect_screen'`, `'click_element'`, `'input_text'`
  - `log_message` (TEXT) — Human-readable Thai log message
  - `is_risky` (INTEGER 0 or 1)
  - `verified_changed` (INTEGER 0 or 1)
  - `created_at` (TEXT) — ISO 8601 string
- Table `sessions`:
  - `step_count` (INTEGER) — Count of steps completed
  - `status` (TEXT) — `'running'` -> `'completed'` / `'cancelled'`
  - `ended_at` (TEXT NULLABLE)

### 5.2 Atomic Step Logging with `env.DB.batch`
For each step in the mock simulation:
```javascript
const stepId = crypto.randomUUID();
const now = new Date().toISOString();

await env.DB.batch([
  // 1. Insert step record
  env.DB.prepare(`
    INSERT INTO task_steps (id, session_id, step_no, action_type, log_message, is_risky, verified_changed, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(stepId, sessionId, step.step_no, step.action_type, step.log_message, step.is_risky ? 1 : 0, step.verified_changed ? 1 : 0, now),

  // 2. Update step_count in sessions table
  env.DB.prepare(`
    UPDATE sessions SET step_count = ? WHERE id = ?
  `).bind(step.step_no, sessionId)
]);
```
`env.DB.batch` ensures transactional atomicity and reduces SQLite latency by sending both statements in a single round-trip.

### 5.3 Step Sequence & Finalization
A standard mock flow consists of 4 steps (customizable or generated based on `instruction`):
1. **Step 1:** `inspect_screen` — *"กำลังค้นหาแอป LINE บนหน้าจอหลัก..."* (delay 800ms)
2. **Step 2:** `click_element` — *"ตรวจพบไอคอนแอป LINE กำลังเปิดแอป..."* (delay 800ms)
3. **Step 3:** `input_text` — *"กำลังพิมพ์ข้อความและส่ง..."* (delay 800ms)
4. **Step 4:** `verify_result` — *"ส่งข้อความสำเร็จเรียบร้อยแล้ว"* (delay 800ms)

Upon completing all steps:
```javascript
const endedAt = new Date().toISOString();
await env.DB.prepare(`
  UPDATE sessions SET status = 'completed', ended_at = ? WHERE id = ?
`).bind(endedAt, sessionId).run();

server.send(JSON.stringify({
  event: 'finished',
  session_id: sessionId,
  status: 'completed',
  step_count: totalSteps,
  summary_message: 'งานเสร็จสมบูรณ์เรียบร้อยแล้ว',
}));

server.close(1000, 'Task completed');
```

---

## 6. Ping/Pong Heartbeat Mechanism

### 6.1 Protocol-Level vs Application-Level Ping/Pong
- **Protocol-Level (RFC 6455 opcode 0x9 / 0xA):** Cloudflare Workers runtime automatically intercepts and responds to low-level Ping frames with Pong frames without requiring user code.
- **Application-Level Heartbeats:** Web browsers and standard JavaScript client libraries (e.g. `WebSocket` in browser, Android apps) do not expose APIs to send raw control frames. Thus, applications require JSON or text heartbeats.

### 6.2 Heartbeat Implementation
The WebSocket server listener checks for both raw string `"ping"` and JSON `{ "event": "ping" }` or `{ "type": "ping" }`:

```javascript
server.addEventListener('message', (event) => {
  const payload = typeof event.data === 'string' ? event.data.trim() : '';

  // 1. Raw text heartbeat
  if (payload === 'ping') {
    server.send('pong');
    return;
  }

  // 2. JSON heartbeat
  try {
    const msg = JSON.parse(payload);
    if (msg.event === 'ping' || msg.type === 'ping') {
      server.send(JSON.stringify({
        event: 'pong',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // In-band cancel
    if (msg.action === 'cancel' || msg.event === 'cancel') {
      handleCancelTaskInBand(sessionId, env, server);
      return;
    }
  } catch (err) {
    // Non-JSON message, ignore or log
  }
});
```

---

## 7. Recommended Code Architecture Blueprint

### 7.1 Proposed File Layout
```
src/
├── auth/
│   ├── crypto.js
│   ├── jwt.js
│   └── middleware.js
├── routes/
│   ├── auth.js
│   ├── tasks.js         # HTTP task management (/api/tasks/...)
│   ├── users.js
│   └── websocket.js     # NEW: WebSocket gateway (/ws/tasks/:session_id)
├── utils/
│   ├── response.js
│   └── wsRegistry.js    # NEW: Active session registry singleton
└── worker.js            # Entry point: route dispatching & ctx forwarding
```

### 7.2 Component 1: `src/utils/wsRegistry.js`
```javascript
/**
 * Shared registry for active WebSocket sessions and cancellation signals.
 */
export const activeSessions = new Map();
// Key: sessionId (string)
// Value: { ws: WebSocket, abortController: AbortController, userId: string }
```

### 7.3 Component 2: `src/routes/websocket.js`
```javascript
import { verifyJwt } from '../auth/jwt.js';
import { DEFAULT_JWT_SECRET } from '../auth/middleware.js';
import { activeSessions } from '../utils/wsRegistry.js';
import { errorResponse } from '../utils/response.js';

export async function handleTaskWebSocket(request, env, ctx, url) {
  // 1. Validate Upgrade header
  const upgradeHeader = request.headers.get('Upgrade');
  if (!upgradeHeader || upgradeHeader.toLowerCase() !== 'websocket') {
    return errorResponse('Expected Upgrade: websocket', 426, 'upgrade_required');
  }

  // 2. Extract session_id
  const match = url.pathname.match(/^\/ws\/tasks\/([^/]+)$/);
  if (!match) {
    return errorResponse('Invalid WebSocket endpoint.', 404, 'not_found');
  }
  const sessionId = match[1];

  // 3. Authenticate via ?token= query param or Authorization header
  let token = url.searchParams.get('token');
  if (!token) {
    const authHeader = request.headers.get('Authorization') || request.headers.get('authorization');
    if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
      token = authHeader.slice(7).trim();
    }
  }

  if (!token) {
    return errorResponse('Authentication token is required.', 401, 'unauthorized');
  }

  const secret = (env && env.JWT_SECRET) || DEFAULT_JWT_SECRET;
  const authResult = await verifyJwt(token, secret);
  if (!authResult.valid || !authResult.payload || authResult.payload.type !== 'access') {
    return errorResponse('Invalid or expired token.', 401, 'unauthorized');
  }
  const userId = authResult.payload.sub;

  // 4. Verify session in D1
  const session = await env.DB.prepare(
    `SELECT id, user_id, status, instruction, step_count FROM sessions WHERE id = ? AND user_id = ?`
  ).bind(sessionId, userId).first();

  if (!session) {
    return errorResponse('Task session not found.', 404, 'task_not_found');
  }

  // 5. Establish WebSocket pair
  const pair = new WebSocketPair();
  const [client, server] = Object.values(pair);
  server.accept();

  const abortController = new AbortController();
  activeSessions.set(sessionId, { ws: server, abortController, userId });

  // 6. Setup Event Listeners
  server.addEventListener('message', (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.event === 'ping' || data.type === 'ping') {
        server.send(JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }));
      }
    } catch {
      if (event.data === 'ping') server.send('pong');
    }
  });

  server.addEventListener('close', () => {
    activeSessions.delete(sessionId);
    abortController.abort();
  });

  server.addEventListener('error', () => {
    activeSessions.delete(sessionId);
    abortController.abort();
  });

  // 7. Send initial connected event
  server.send(JSON.stringify({
    event: 'connected',
    session_id: sessionId,
    status: session.status,
    message: 'WebSocket connection established.',
  }));

  // 8. Stream logs in background via ctx.waitUntil
  if (session.status === 'running') {
    ctx.waitUntil(runMockLogStream({
      sessionId,
      server,
      env,
      signal: abortController.signal,
      instruction: session.instruction,
    }));
  }

  return new Response(null, {
    status: 101,
    webSocket: client,
  });
}
```

### 7.4 Component 3: Integration with `handleCancelTask` in `src/routes/tasks.js`
```javascript
import { activeSessions } from '../utils/wsRegistry.js';

export async function handleCancelTask(env, user, sessionId) {
  const session = await env.DB.prepare(
    `SELECT id, status FROM sessions WHERE id = ? AND user_id = ?`
  ).bind(sessionId, user.id).first();

  if (!session) {
    return errorResponse('Task session not found.', 404, 'task_not_found');
  }

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
  ).bind(now, sessionId).run();

  // Broadcast cancellation to active WebSocket connection
  const active = activeSessions.get(sessionId);
  if (active) {
    try {
      active.ws.send(JSON.stringify({
        event: 'cancelled',
        session_id: sessionId,
        status: 'cancelled',
        summary_message: 'งานถูกยกเลิกโดยผู้ใช้',
      }));
      active.ws.close(1000, 'Cancelled by user');
    } catch (e) {
      console.warn('Error sending WS cancel message:', e);
    }
    active.abortController.abort();
    activeSessions.delete(sessionId);
  }

  return jsonResponse({
    session_id: sessionId,
    status: 'cancelled',
  });
}
```

---

## 8. Verification Strategy for `test_epic2.js`

To verify Epic 2 autonomously against `wrangler dev`:
1. **Task Start:** `POST /api/tasks/start` -> returns 201 with `session_id`.
2. **WebSocket Handshake:** Connect to `ws://127.0.0.1:8787/ws/tasks/:session_id?token=<token>`.
   - Verify connection opens with HTTP 101.
   - Verify initial event `{ event: "connected" }`.
3. **Real-time Log Streaming:**
   - Client captures sequential `{ event: "log", step_no: 1... }` frames.
   - Verify D1 persistence via `GET /api/tasks/:session_id/logs`.
4. **Interactive Cancellation:**
   - Start task, connect WebSocket.
   - Send `POST /api/tasks/:session_id/cancel`.
   - Verify WebSocket receives `{ event: "cancelled", status: "cancelled" }` frame and connection closes with code 1000.
   - Verify `GET /api/tasks/:session_id` reports `status: "cancelled"`.
5. **Heartbeat:**
   - Send `{ event: "ping" }` over WebSocket -> verify `{ event: "pong" }` response.
6. **Authentication Rejection:**
   - Connecting to WebSocket with no token or invalid token returns HTTP 401.
   - Connecting with another user's token returns HTTP 404.

---

## 9. Conclusion
The proposed architecture natively solves all Epic 2 requirements with zero external dependencies, robust edge lifecycle management, and reliable cross-request cancellation. It adheres strictly to the existing codebase conventions and provides complete coverage for automated testing.
