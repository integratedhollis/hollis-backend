# Hollis Backend — Epic 2 Specification & Requirements Document
**Epic 2: ระบบแชทหลัก (Chat & Real-time Communication System)**

- **Target System**: Hollis Backend on Cloudflare Workers & Cloudflare D1 (SQLite)
- **Authoritative Source**: `.agents/ORIGINAL_REQUEST.md` (§ `## 2026-09-28T03:53:53Z`), `API_DOCUMENTATION.md`, `migrations/0001_initial_schema.sql`
- **Specification Miner**: `spec_miner_1`
- **Status**: Complete & Verified

---

## 1. Executive Summary & Specification Scope

Epic 2 delivers the core interactive foundation for the Hollis AI-driven Android screen automation system. It bridges the Android Client with the Cloudflare Workers edge environment via a dual-channel architecture:
1. **REST APIs**: Fast, stateless commands for creating automation sessions (`POST /api/tasks/start`), querying execution status fallback (`GET /api/tasks/:session_id/status`), and issuing termination directives (`POST /api/tasks/:session_id/cancel`).
2. **WebSocket Gateway**: Persistent, low-latency duplex streaming channel (`WS /ws/tasks/:session_id`) using Cloudflare Workers native `WebSocketPair` to stream step-by-step progress logs in real-time, maintain client health via heartbeats, and instantly broadcast cancellation events.
3. **Cloudflare D1 Persistence**: Atomically tracks session state machine (`running` -> `completed` / `cancelled`) in the `sessions` table and records every automation log step in the `task_steps` table for immediate UI rendering and historical audit replay.

---

## 2. Requirements Breakdown (R1 – R4)

### Requirement R1: Task Start & Session Creation
* **R1.1 Task Initiation (`POST /api/tasks/start`)**:
  * Accepts a JSON payload containing `{ "instruction": string }` from an authenticated Android client.
  * Validates user authentication via standard `Authorization: Bearer <access_token>`.
  * Validates instruction: non-null, string type, non-empty after trimming whitespace.
  * Generates an application-layer UUID v4 `session_id`.
  * Inserts a record into the D1 `sessions` table with status `'running'`, `step_count = 0`, `started_at = <ISO 8601>`, and `ended_at = NULL`.
  * Returns HTTP 201 Created with JSON `{ "session_id": string, "status": "running" }`.
* **R1.2 Polling Fallback (`GET /api/tasks/:session_id/status`)**:
  * Provides an HTTP polling fallback mechanism for Android clients when WebSocket is disrupted or unavailable.
  * Authenticates user and enforces strict user isolation (returns HTTP 404 if session does not exist or belongs to another user).
  * Queries `sessions` for `status` and `step_count`.
  * Queries `task_steps` for the latest log message (`ORDER BY step_no DESC LIMIT 1`).
  * Returns HTTP 200 OK with `{ "session_id": string, "status": string, "current_step": number, "last_log": string | null }`.

### Requirement R2: WebSocket Gateway & Mock Log Streaming
* **R2.1 Native WebSocket Gateway (`WS /ws/tasks/:session_id`)**:
  * Exposes endpoint `/ws/tasks/:session_id` using Cloudflare Workers native `WebSocketPair`.
  * Validates WebSocket upgrade headers (`Upgrade: websocket`).
  * Enforces authentication: extracts access token from query parameter `?token=<access_token>` or handshake header `Authorization: Bearer <token>`.
  * Rejects unauthorized requests immediately with HTTP 401 Unauthorized before WebSocket upgrade.
  * Verifies `session_id` exists in D1 and matches the authenticated user ID (`user.id`). Rejects non-existent or cross-user sessions with HTTP 404 Not Found before WebSocket upgrade.
  * Upgrades connection cleanly via HTTP 101 Switching Protocols.
* **R2.2 Connection Initialization Event**:
  * Immediately upon connection, sends initial connected event:
    ```json
    { "event": "connected", "session_id": "<session_id>", "message": "Connected to task log stream" }
    ```
* **R2.3 Mock Log Streaming & Persistence**:
  * Streams sequential progress events representing automated screen actions:
    * Step 1: Finding target app (`"กำลังค้นหาแอป LINE บนหน้าจอหลัก..."`)
    * Step 2: Tapping app icon (`"เปิดแอปพลิเคชัน LINE สำเร็จ"`)
    * Step 3: Inputting text into chat (`"พิมพ์ข้อความในช่องแชท..."`)
    * Step 4: Verification and delivery (`"ส่งข้อความสำเร็จเรียบร้อยแล้ว"`)
  * For each step:
    * Inserts record into D1 `task_steps` table (`id`, `session_id`, `step_no`, `action_type`, `log_message`, `is_risky`, `verified_changed`, `created_at`).
    * Updates D1 `sessions.step_count` to reflect latest `step_no`.
    * Dispatches JSON event over WebSocket:
      ```json
      { "event": "log", "session_id": "<session_id>", "step_no": 1, "action_type": "find_element", "log_message": "กำลังค้นหาแอป LINE บนหน้าจอหลัก...", "timestamp": "2026-09-28T10:50:00.000Z" }
      ```
* **R2.4 Completion Event**:
  * Upon completing all mock steps, updates `sessions` table in D1 (`status = 'completed'`, `step_count = 4`, `ended_at = <ISO 8601>`).
  * Dispatches `finished` event to client:
    ```json
    { "event": "finished", "session_id": "<session_id>", "status": "completed", "step_count": 4, "summary_message": "ส่งข้อความสำเร็จเรียบร้อยแล้ว" }
    ```
  * Closes WebSocket cleanly (code `1000`, reason `"Task completed"`).
* **R2.5 Heartbeat Ping/Pong**:
  * Handles `{ "event": "ping" }` or `{ "type": "ping" }` from client, responding with `{ "event": "pong", "timestamp": "<ISO 8601>" }`.

### Requirement R3: Task Cancellation & Connection Termination
* **R3.1 REST Cancellation Endpoint (`POST /api/tasks/:session_id/cancel`)**:
  * Allows in-flight task cancellation invoked by Android client (e.g. user pressing "Stop" button).
  * Validates Bearer token and ensures session exists and belongs to the requesting user (404 otherwise).
  * If task is already in a terminal state (`completed`, `cancelled`, etc.), returns HTTP 200 with current status.
  * If active (`running`), updates D1 `sessions` table: `status = 'cancelled'`, `ended_at = <ISO 8601>`.
  * Returns HTTP 200 OK with `{ "session_id": "<session_id>", "status": "cancelled" }`.
* **R3.2 Real-time Termination Coordination**:
  * Broadcasts cancellation event over active WebSocket connection:
    ```json
    { "event": "cancelled", "session_id": "<session_id>", "status": "cancelled", "summary_message": "งานถูกยกเลิกโดยผู้ใช้" }
    ```
  * Terminates active WebSocket cleanly (code `1000`, reason `"Task cancelled"`).
  * Halts any pending mock log emission timers/loops immediately.

### Requirement R4: API Documentation & Automated Test Suite
* **R4.1 Complete API Documentation**:
  * Maintain up-to-date documentation in `API_DOCUMENTATION.md` detailing all Epic 2 endpoints, request/response formats, error codes, WebSocket JSON event contracts, and Android integration guides.
* **R4.2 Standalone Test Suite (`test_epic2.js`)**:
  * Provide an automated test script `test_epic2.js` executable via `node test_epic2.js --url http://127.0.0.1:8787`.
  * Zero external runtime npm dependencies (pure Node.js native `fetch`, native `WebSocket`, `crypto`).
  * Must verify all acceptance criteria and pass with 0 failures.

---

## 3. Features Discovered Table

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Tasks (Epic 2) | Start Task Session | Creates a new running automation session in D1 | Headers: `Authorization: Bearer <token>`, Body: `{ "instruction": string }` | HTTP 201 `{ "session_id": string, "status": "running" }` | 400 Bad Request on invalid body; 401 Unauthorized on invalid token | `ORIGINAL_REQUEST.md` § R1, `src/routes/tasks.js` |
| 2 | Tasks (Epic 2) | Polling Status Fallback | Retrieves current status and latest step log for a task | Path: `:session_id`, Headers: `Authorization: Bearer <token>` | HTTP 200 `{ "session_id": string, "status": string, "current_step": number, "last_log": string \| null }` | 401 on missing/bad token; 404 on unknown session or cross-user access | `ORIGINAL_REQUEST.md` § R1, `API_DOCUMENTATION.md` § 3 |
| 3 | WebSocket (Epic 2) | WebSocket Upgrade & Auth | Establishes duplex WebSocket connection using `WebSocketPair` | URL: `/ws/tasks/:session_id?token=<token>`, Headers: `Upgrade: websocket` | HTTP 101 Switching Protocols with WebSocket handle | 401 on missing/invalid token; 404 on non-existent/cross-user session | `ORIGINAL_REQUEST.md` § R2, `API_DOCUMENTATION.md` § 3.2 |
| 4 | WebSocket (Epic 2) | Connected Event | Emits initial connection acknowledgment event | Incoming WebSocket connection established | JSON `{ "event": "connected", "session_id": string, "message": string }` | Drops connection on failure | `ORIGINAL_REQUEST.md` § R2, `API_DOCUMENTATION.md` § 3.2 |
| 5 | WebSocket (Epic 2) | Mock Log Streaming | Streams real-time progress events and logs steps to D1 `task_steps` | Active WebSocket session | JSON `{ "event": "log", "session_id": string, "step_no": number, "action_type": string, "log_message": string, "timestamp": string }` | Halts streaming on client disconnect or cancellation | `ORIGINAL_REQUEST.md` § R2, `API_DOCUMENTATION.md` § 3.2 |
| 6 | WebSocket (Epic 2) | Task Completion Event | Emits completion event when all steps finish; updates `sessions` to `completed` | Reaching final automation step | JSON `{ "event": "finished", "session_id": string, "status": "completed", "step_count": number, "summary_message": string }` | N/A | `API_DOCUMENTATION.md` § 3.2 |
| 7 | WebSocket (Epic 2) | Ping/Pong Heartbeat | Keeps edge connection alive across timeouts | JSON `{ "event": "ping" }` or `{ "type": "ping" }` | JSON `{ "event": "pong", "timestamp": string }` | Ignored if malformed | `ORIGINAL_REQUEST.md` § R2 |
| 8 | Tasks (Epic 2) | In-Flight Task Cancel | Cancels active task, marks D1 as `cancelled`, and terminates WebSocket | Path: `:session_id`, Headers: `Authorization: Bearer <token>` | HTTP 200 `{ "session_id": string, "status": "cancelled" }` | 401 on missing token; 404 on unknown or cross-user session | `ORIGINAL_REQUEST.md` § R3, `src/routes/tasks.js` |
| 9 | WebSocket (Epic 2) | Cancellation Broadcast | Emits cancellation event over active WebSocket and closes socket | Cancel API invoked or WebSocket cancel frame received | JSON `{ "event": "cancelled", "session_id": string, "status": "cancelled", "summary_message": string }` | Socket closed with code 1000 | `ORIGINAL_REQUEST.md` § R3, `API_DOCUMENTATION.md` § 3.2 |
| 10 | Testing (Epic 2) | Standalone Epic 2 Test Suite | Node.js test script verifying task start, WebSocket streaming, and cancellation | CLI: `node test_epic2.js --url http://127.0.0.1:8787` | Exit code 0, test execution summary table | Exit code 1 with failure details on assertion failure | `ORIGINAL_REQUEST.md` § R4 |
| 11 | Tasks (Discovered) | Task Session Summary | Retrieves summary details and duration for a task | Path: `GET /api/tasks/:session_id` | HTTP 200 `{ "session_id", "instruction", "status", "step_count", "duration", "started_at", "ended_at" }` | 401 on bad token; 404 if not found/unauthorized | `src/routes/tasks.js` |
| 12 | Tasks (Discovered) | List Tasks History | Lists tasks with pagination (`limit`, `offset`), status filter, keyword search | `GET /api/tasks?status=&q=&limit=&offset=` | HTTP 200 `{ "tasks": [...], "total": number, "limit": number, "offset": number }` | 401 on bad token | `src/routes/tasks.js` |
| 13 | Tasks (Discovered) | Task Steps Replay | Retrieves all recorded steps for session replay | `GET /api/tasks/:session_id/logs` | HTTP 200 `{ "session_id": string, "logs": [...] }` | 401 on bad token; 404 if not found/unauthorized | `src/routes/tasks.js` |
| 14 | Tasks (Discovered) | Risk Confirmation Response | Approves or rejects a risky action step | `POST /api/tasks/:session_id/confirm`, Body: `{ "approved": boolean }` | HTTP 200 `{ "session_id": string, "status": "ok", "approved": boolean }` | 400 on invalid body; 404 if not found/unauthorized | `src/routes/tasks.js` |
| 15 | System (Discovered) | Health & Discovery | Returns service status and active phase | `GET /health` or `GET /` | HTTP 200 `{ "status": "ok", "service": "hollis-backend", "phase": number }` | 500 on unhandled error | `src/worker.js` |

---

## 4. Edge Cases & Boundary Conditions

| # | Feature | Input / Condition | Expected & Observed Behavior |
|---|---------|-------------------|------------------------------|
| E1 | `POST /api/tasks/start` | Missing `Authorization` header | HTTP 401 Unauthorized `{ "error": "unauthorized", "message": "Missing or malformed Authorization header." }` |
| E2 | `POST /api/tasks/start` | Expired or tampered JWT access token | HTTP 401 Unauthorized `{ "error": "unauthorized", "message": "Invalid or expired token." }` |
| E3 | `POST /api/tasks/start` | JWT with `type: "refresh"` instead of `"access"` | HTTP 401 Unauthorized `{ "error": "unauthorized", "message": "Invalid or expired token." }` |
| E4 | `POST /api/tasks/start` | Non-JSON body or malformed JSON | HTTP 400 Bad Request `{ "error": "invalid_input", "message": "Invalid JSON body." }` |
| E5 | `POST /api/tasks/start` | Empty JSON `{}` or missing `instruction` field | HTTP 400 Bad Request `{ "error": "invalid_input", "message": "instruction is required and must be a string." }` |
| E6 | `POST /api/tasks/start` | Non-string `instruction` (e.g. `{ "instruction": 12345 }`) | HTTP 400 Bad Request `{ "error": "invalid_input", "message": "instruction is required and must be a string." }` |
| E7 | `POST /api/tasks/start` | Whitespace-only `instruction` (e.g. `{ "instruction": "   " }`) | HTTP 400 Bad Request `{ "error": "invalid_input", "message": "instruction cannot be empty." }` |
| E8 | `POST /api/tasks/start` | Non-POST HTTP method (e.g. `PUT`, `DELETE`) | HTTP 405 Method Not Allowed `{ "error": "method_not_allowed", "message": "Method Not Allowed" }` |
| E9 | `GET /api/tasks/:id/status` | Non-existent UUID `session_id` | HTTP 404 Not Found `{ "error": "task_not_found", "message": "Task session not found." }` |
| E10 | `GET /api/tasks/:id/status` | `session_id` created by User A requested by User B | HTTP 404 Not Found (User Isolation: never leak another user's session existence) |
| E11 | `GET /api/tasks/:id/status` | Newly created session with no steps in `task_steps` | HTTP 200 OK `{ "session_id": "...", "status": "running", "current_step": 0, "last_log": null }` |
| E12 | `WS /ws/tasks/:id` | Handshake without token in query param or header | Rejection prior to upgrade with HTTP 401 Unauthorized |
| E13 | `WS /ws/tasks/:id` | Handshake with invalid/expired token | Rejection prior to upgrade with HTTP 401 Unauthorized |
| E14 | `WS /ws/tasks/:id` | Handshake for non-existent session | Rejection prior to upgrade with HTTP 404 Not Found |
| E15 | `WS /ws/tasks/:id` | Handshake for session belonging to another user | Rejection prior to upgrade with HTTP 404 Not Found |
| E16 | `WS /ws/tasks/:id` | Connecting to already `cancelled` or `completed` session | Upgrade succeeds; immediately sends `{ event: "cancelled" }` or `{ event: "finished" }`, then closes socket (code 1000) |
| E17 | `WS /ws/tasks/:id` | Client abruptly closes socket mid-stream | Server gracefully detects `close` event, clears streaming timers, and avoids unhandled promise rejections |
| E18 | `WS /ws/tasks/:id` | Client sends malformed non-JSON frame | Server sends `{ "event": "error", "message": "Invalid JSON format" }` without crashing |
| E19 | `WS /ws/tasks/:id` | Client sends `{ "event": "ping" }` | Server replies `{ "event": "pong", "timestamp": "..." }` |
| E20 | `POST /api/tasks/:id/cancel` | Non-existent `session_id` | HTTP 404 Not Found `{ "error": "task_not_found", "message": "Task session not found." }` |
| E21 | `POST /api/tasks/:id/cancel` | Cross-user cancellation attempt | HTTP 404 Not Found `{ "error": "task_not_found", "message": "Task session not found." }` |
| E22 | `POST /api/tasks/:id/cancel` | Cancelling already cancelled session | HTTP 200 OK `{ "session_id": "...", "status": "cancelled", "message": "Task is already completed or stopped." }` (Idempotent) |
| E23 | `POST /api/tasks/:id/cancel` | Cancelling already completed session | HTTP 200 OK `{ "session_id": "...", "status": "completed", "message": "Task is already completed or stopped." }` (Idempotent) |
| E24 | `POST /api/tasks/:id/cancel` | Active running session with live WebSocket | D1 status updated to `cancelled`, `ended_at` set, WebSocket receives `{ event: "cancelled" }` and closes with code 1000 |

---

## 5. Detailed REST API Specifications

### 5.1 Start Task Session
* **Endpoint**: `POST /api/tasks/start` (alias: `POST /api/tasks`)
* **Headers**:
  * `Authorization`: `Bearer <access_token>` (Required)
  * `Content-Type`: `application/json` (Required)
* **Request Body**:
  ```json
  {
    "instruction": "เปิดแอป LINE แล้วส่งข้อความหาสมศรีว่า ถึงแล้วนะ"
  }
  ```
* **Success Response (201 Created)**:
  * Headers: `Content-Type: application/json; charset=utf-8`
  * Body:
    ```json
    {
      "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
      "status": "running"
    }
    ```
* **Error Responses**:
  * `400 Bad Request` (Missing instruction):
    ```json
    {
      "error": "invalid_input",
      "message": "instruction is required and must be a string."
    }
    ```
  * `400 Bad Request` (Empty instruction):
    ```json
    {
      "error": "invalid_input",
      "message": "instruction cannot be empty."
    }
    ```
  * `401 Unauthorized` (Invalid/missing token):
    ```json
    {
      "error": "unauthorized",
      "message": "Missing or malformed Authorization header."
    }
    ```
  * `405 Method Not Allowed`:
    ```json
    {
      "error": "method_not_allowed",
      "message": "Method Not Allowed"
    }
    ```

---

### 5.2 Polling Status Fallback
* **Endpoint**: `GET /api/tasks/:session_id/status`
* **Headers**:
  * `Authorization`: `Bearer <access_token>` (Required)
* **Path Parameters**:
  * `session_id`: UUID string (Required)
* **Success Response (200 OK)**:
  * Headers: `Content-Type: application/json; charset=utf-8`
  * Body:
    ```json
    {
      "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
      "status": "running",
      "current_step": 1,
      "last_log": "กำลังค้นหาแอป LINE บนหน้าจอหลัก..."
    }
    ```
* **Error Responses**:
  * `401 Unauthorized`:
    ```json
    {
      "error": "unauthorized",
      "message": "Invalid or expired token."
    }
    ```
  * `404 Not Found` (Unknown or unauthorized session):
    ```json
    {
      "error": "task_not_found",
      "message": "Task session not found."
    }
    ```

---

### 5.3 Cancel Task Session
* **Endpoint**: `POST /api/tasks/:session_id/cancel`
* **Headers**:
  * `Authorization`: `Bearer <access_token>` (Required)
* **Path Parameters**:
  * `session_id`: UUID string (Required)
* **Success Response (200 OK)**:
  * Headers: `Content-Type: application/json; charset=utf-8`
  * Body:
    ```json
    {
      "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
      "status": "cancelled"
    }
    ```
* **Idempotent Response (200 OK - Already completed or cancelled)**:
  * Body:
    ```json
    {
      "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
      "status": "cancelled",
      "message": "Task is already completed or stopped."
    }
    ```
* **Error Responses**:
  * `401 Unauthorized`:
    ```json
    {
      "error": "unauthorized",
      "message": "Invalid or expired token."
    }
    ```
  * `404 Not Found`:
    ```json
    {
      "error": "task_not_found",
      "message": "Task session not found."
    }
    ```

---

## 6. WebSocket Protocol Specifications

### 6.1 Handshake & Endpoint Architecture
* **Endpoint URL**:
  * Dev: `ws://127.0.0.1:8787/ws/tasks/:session_id?token=<access_token>`
  * Prod: `wss://<worker-domain>/ws/tasks/:session_id?token=<access_token>`
* **Handshake Headers (Client -> Server)**:
  ```http
  GET /ws/tasks/3c983582-7d2d-4874-9457-3a1391df24bc?token=eyJhbGciOi... HTTP/1.1
  Host: 127.0.0.1:8787
  Upgrade: websocket
  Connection: Upgrade
  Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==
  Sec-WebSocket-Version: 13
  ```
* **Handshake Authentication**:
  * Primary method: Query parameter `?token=<access_token>`.
  * Secondary method: `Authorization: Bearer <access_token>` in upgrade request headers.
  * Validation: Decodes JWT, validates HMAC-SHA256 signature against `JWT_SECRET`, checks `exp > now`, and verifies `payload.type === 'access'`.
  * If validation fails: Returns HTTP 401 Unauthorized Response before calling `serverWs.accept()`.
  * If session does not exist in D1 or belongs to another user: Returns HTTP 404 Not Found Response before upgrade.
* **Handshake Upgrade Response (Server -> Client)**:
  ```http
  HTTP/1.1 101 Switching Protocols
  Upgrade: websocket
  Connection: Upgrade
  ```
  *(Implemented via `new WebSocketPair()` and returning `new Response(null, { status: 101, webSocket: clientWs })`)*

---

### 6.2 Incoming & Outgoing WebSocket Messages

#### 1. Connected Event (Server -> Client)
Sent immediately upon connection establishment:
```json
{
  "event": "connected",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "message": "Connected to task log stream"
}
```

#### 2. Log Step Event (Server -> Client)
Streamed sequentially during mock execution:
```json
{
  "event": "log",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "step_no": 1,
  "action_type": "find_element",
  "log_message": "กำลังค้นหาแอป LINE บนหน้าจอหลัก...",
  "timestamp": "2026-09-28T10:50:00.000Z"
}
```

#### 3. Task Finished Event (Server -> Client)
Sent when execution completes normally:
```json
{
  "event": "finished",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "status": "completed",
  "step_count": 4,
  "summary_message": "ส่งข้อความสำเร็จเรียบร้อยแล้ว"
}
```
*Action*: WebSocket connection is closed cleanly by server with code `1000`.

#### 4. Task Cancelled Event (Server -> Client)
Sent when cancellation is triggered (via `POST /api/tasks/:session_id/cancel` or in-band cancel frame):
```json
{
  "event": "cancelled",
  "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
  "status": "cancelled",
  "summary_message": "งานถูกยกเลิกโดยผู้ใช้"
}
```
*Action*: WebSocket connection is closed cleanly by server with code `1000`.

#### 5. Ping & Pong Heartbeat Messages
* **Client -> Server**:
  ```json
  {
    "event": "ping"
  }
  ```
  *(or `{ "type": "ping" }`)*
* **Server -> Client**:
  ```json
  {
    "event": "pong",
    "timestamp": "2026-09-28T10:50:05.123Z"
  }
  ```

#### 6. In-Band Cancel Message (Client -> Server)
Optional duplex feature allowing client to cancel directly over WebSocket:
```json
{
  "event": "cancel"
}
```
*Action*: Server updates D1 `sessions` table to `cancelled`, emits `cancelled` event, and closes connection.

#### 7. Error Event (Server -> Client)
Sent if client sends an invalid payload:
```json
{
  "event": "error",
  "message": "Invalid message format"
}
```

---

### 6.3 Mock Streaming Sequence & Timing Rules
1. **Delay between steps**: Mock execution simulates realistic Android UI interactions with a 300ms to 600ms delay between steps.
2. **Cancellation Check**: Before emitting each step, the execution loop checks if `session.status` has transitioned to `'cancelled'`. If cancelled, the loop aborts immediately, emits the `cancelled` event, and terminates the socket.
3. **Step Script**:
   * Step 1 (`action_type: "find_element"`): `"กำลังค้นหาแอป LINE บนหน้าจอหลัก..."`
   * Step 2 (`action_type: "tap"`): `"เปิดแอปพลิเคชัน LINE สำเร็จ"`
   * Step 3 (`action_type: "input_text"`): `"พิมพ์ข้อความในช่องแชท..."`
   * Step 4 (`action_type: "verify_screen"`): `"ส่งข้อความสำเร็จเรียบร้อยแล้ว"`

---

## 7. Cloudflare D1 Database Interaction Specifications

### 7.1 Schema Verification
Verified from `migrations/0001_initial_schema.sql`:
* `sessions` table:
  * `id TEXT PRIMARY KEY NOT NULL` (UUID v4)
  * `user_id TEXT NOT NULL` (FK users(id) ON DELETE CASCADE)
  * `instruction TEXT NOT NULL`
  * `status TEXT NOT NULL DEFAULT 'pending'` (CHECK IN `('pending', 'running', 'completed', 'failed', 'cancelled', 'stopped_loop', 'stopped_limit')`)
  * `step_count INTEGER NOT NULL DEFAULT 0` (CHECK step_count >= 0)
  * `started_at TEXT NOT NULL` (ISO 8601 string)
  * `ended_at TEXT` (Nullable ISO 8601 string)
* `task_steps` table:
  * `id TEXT PRIMARY KEY NOT NULL` (UUID v4)
  * `session_id TEXT NOT NULL` (FK sessions(id) ON DELETE CASCADE)
  * `step_no INTEGER NOT NULL` (CHECK step_no >= 0)
  * `action_type TEXT NOT NULL`
  * `log_message TEXT`
  * `is_risky INTEGER NOT NULL DEFAULT 0` (CHECK IN (0, 1))
  * `verified_changed INTEGER NOT NULL DEFAULT 0` (CHECK IN (0, 1))
  * `created_at TEXT NOT NULL` (ISO 8601 string)
  * Constraint: `UNIQUE (session_id, step_no)`

### 7.2 Database Operations Table

| Trigger | Operation | SQL Query | Bind Parameters |
|---------|-----------|-----------|-----------------|
| `POST /api/tasks/start` | Insert Session | `INSERT INTO sessions (id, user_id, instruction, status, step_count, started_at) VALUES (?, ?, ?, 'running', 0, ?)` | `[sessionId, user.id, instruction, now]` |
| `WS /ws/tasks/:session_id` (Auth Check) | Fetch Session Ownership | `SELECT id, user_id, status FROM sessions WHERE id = ?` | `[sessionId]` |
| WebSocket Log Step Emission | Insert Task Step | `INSERT INTO task_steps (id, session_id, step_no, action_type, log_message, is_risky, verified_changed, created_at) VALUES (?, ?, ?, ?, ?, 0, 1, ?)` | `[stepId, sessionId, stepNo, actionType, logMsg, now]` |
| WebSocket Log Step Emission | Update Session Step Count | `UPDATE sessions SET step_count = ? WHERE id = ?` | `[stepNo, sessionId]` |
| Task Completion | Finalize Session | `UPDATE sessions SET status = 'completed', step_count = ?, ended_at = ? WHERE id = ?` | `[totalSteps, now, sessionId]` |
| `POST /api/tasks/:id/cancel` | Cancel Session | `UPDATE sessions SET status = 'cancelled', ended_at = ? WHERE id = ?` | `[now, sessionId]` |
| `GET /api/tasks/:id/status` | Read Session Status | `SELECT id AS session_id, status, step_count FROM sessions WHERE id = ? AND user_id = ?` | `[sessionId, user.id]` |
| `GET /api/tasks/:id/status` | Read Latest Step Log | `SELECT step_no, log_message FROM task_steps WHERE session_id = ? ORDER BY step_no DESC LIMIT 1` | `[sessionId]` |

---

## 8. Acceptance Criteria & Objective Verification Plan

### 8.1 Acceptance Criteria Matrix

| AC # | Category | Criterion | Verification Method | Expected Result |
|------|----------|-----------|---------------------|-----------------|
| **AC-1** | Task Start | `POST /api/tasks/start` with valid Bearer token & instruction returns 201 | Send POST with Bearer token & `{ instruction: "..." }` | HTTP 201 `{ session_id: UUID, status: "running" }` |
| **AC-2** | Task Start | `POST /api/tasks/start` without token returns 401 | Send POST with no `Authorization` header | HTTP 401 `{ error: "unauthorized" }` |
| **AC-3** | Task Start | `POST /api/tasks/start` with empty/missing instruction returns 400 | Send POST with `{ instruction: "   " }` or `{}` | HTTP 400 `{ error: "invalid_input" }` |
| **AC-4** | Status Polling | `GET /api/tasks/:session_id/status` returns status & last log | Send GET with valid token to running session | HTTP 200 with `session_id`, `status: "running"`, `current_step`, `last_log` |
| **AC-5** | Status Isolation | Non-existent session or cross-user query returns 404 | Send GET as User B to User A's session | HTTP 404 `{ error: "task_not_found" }` |
| **AC-6** | WS Handshake | `/ws/tasks/:session_id` without valid token is rejected | Connect WebSocket with no token or invalid token | Connection rejected with HTTP 401 Unauthorized |
| **AC-7** | WS Handshake | `/ws/tasks/:session_id` with valid token upgrades connection | Connect WebSocket with `?token=<valid_token>` | Handshake succeeds: HTTP 101 Switching Protocols |
| **AC-8** | WS Events | Client receives initial `connected` event | Listen for first frame after open | JSON `{ event: "connected", session_id: "..." }` |
| **AC-9** | WS Events | Client receives sequential real-time mock log events | Listen for subsequent frames | JSON `{ event: "log", step_no: 1..N, ... }` in order |
| **AC-10** | D1 Persistence | Emitted log steps are persisted to D1 `task_steps` | Query `GET /api/tasks/:id/logs` or status after stream | `task_steps` rows match emitted events |
| **AC-11** | WS Heartbeat | WebSocket supports ping/pong heartbeats | Send `{ event: "ping" }` | Receives `{ event: "pong" }` |
| **AC-12** | Cancellation | `POST /api/tasks/:session_id/cancel` sets `sessions.status` to `cancelled` | Send POST `/api/tasks/:id/cancel` | HTTP 200 `{ session_id: "...", status: "cancelled" }` |
| **AC-13** | WS Cancellation | Active WebSocket receives cancellation event and closes cleanly | Observe active WebSocket during cancel call | Receives `{ event: "cancelled", status: "cancelled" }`, socket closed (1000) |
| **AC-14** | Cancel Isolation | User B cannot cancel User A's task session | Send cancel POST as User B to User A session | HTTP 404 `{ error: "task_not_found" }` |
| **AC-15** | Automated Suite | Standalone test script passes all tests with 0 failures | Run `node test_epic2.js --url http://127.0.0.1:8787` | All test cases pass with exit code 0 |

---

### 8.2 Test Suite Design for `test_epic2.js`
The automated test runner will execute against `wrangler dev` (port 8787):
1. **Setup**:
   * Registers 2 independent test users (`User A` and `User B`) via `/api/auth/register` to test multi-tenancy and data isolation.
   * Acquires `tokenA` and `tokenB`.
2. **Tier 1: REST Task Creation & Polling Fallback**:
   * Rejects unauthenticated `POST /api/tasks/start` (401).
   * Rejects invalid body formats: missing instruction, empty string, non-string (400).
   * Creates session for User A, captures `sessionId1` (201).
   * Verifies `GET /api/tasks/:sessionId1/status` returns `status: "running"` (200).
   * Verifies User B cannot access User A's status (404).
3. **Tier 2: WebSocket Authentication & Handshake**:
   * Rejects WebSocket connection without token (HTTP 401).
   * Rejects WebSocket connection with invalid token (HTTP 401).
   * Rejects WebSocket connection for non-existent session (HTTP 404).
   * Rejects WebSocket connection for User B attempting to connect to User A's session (HTTP 404).
4. **Tier 3: WebSocket Streaming & Database Persistence**:
   * Creates fresh session `sessionId2` for User A.
   * Connects via `ws://.../ws/tasks/:sessionId2?token=tokenA`.
   * Verifies handshake succeeds (HTTP 101).
   * Receives `{ event: "connected" }`.
   * Receives sequential `{ event: "log" }` frames (steps 1, 2, ...).
   * Sends ping frame `{ event: "ping" }` and asserts `{ event: "pong" }`.
   * Awaits completion: asserts `{ event: "finished", status: "completed" }` and graceful close.
   * Queries `GET /api/tasks/:sessionId2/status` to confirm `status: "completed"`, `step_count: 4`.
   * Queries `GET /api/tasks/:sessionId2/logs` to confirm all 4 steps were saved to D1.
5. **Tier 4: In-Flight Task Cancellation**:
   * Creates fresh session `sessionId3` for User A.
   * Connects WebSocket to `sessionId3`.
   * Waits for first log event.
   * Dispatches `POST /api/tasks/:sessionId3/cancel`.
   * Asserts WebSocket receives `{ event: "cancelled", status: "cancelled" }` and closes cleanly.
   * Queries `GET /api/tasks/:sessionId3/status` to confirm final status is `cancelled`.

---

## 9. Security, Concurrency & Architecture Requirements

### 9.1 Multi-Tenant Data Isolation
* All sessions and task logs are strictly bound to `user_id`.
* Any query fetching or updating a session (`/api/tasks/:session_id/status`, `/api/tasks/:session_id/cancel`, `/ws/tasks/:session_id`) MUST verify `session.user_id === user.id`.
* When a cross-user attempt is made, the backend MUST return `404 Not Found` (`task_not_found`) rather than `403 Forbidden` to prevent resource enumeration attacks.

### 9.2 Cloudflare Workers WebSocketPair & State Coordination
* In Cloudflare Workers edge environment, WebSocket connections are established using `new WebSocketPair()`.
* To coordinate in-flight cancellation between the HTTP REST cancel endpoint and the active WebSocket connection:
  1. **Active Sockets Registry**: Maintain an in-memory `activeSockets` registry mapping `sessionId -> serverWs` in the isolate. When `handleCancelTask` is called within the same worker instance, it notifies and closes the active socket immediately.
  2. **D1 State Polling in Streaming Loop**: The streaming loop checks `sessions.status` before each step emission. If a cancel occurred (even across worker isolates), the loop detects the updated status, emits `{ event: "cancelled" }`, and closes the socket.
  3. **In-Band WebSocket Message Handling**: The socket listens for `{ event: "cancel" }` directly from the client.
* This layered architecture guarantees rock-solid cancellation handling across both local development (`wrangler dev`) and distributed production edge nodes.

### 9.3 Zero Runtime Dependencies
* In accordance with Hollis Backend architecture:
  * Runtime operates entirely on pure Web Standards (`fetch`, `Request`, `Response`, `WebSocketPair`, Web Crypto API).
  * Test suite `test_epic2.js` utilizes native Node.js 24 (`fetch`, global `WebSocket`, `crypto`) with zero external npm dependencies.
