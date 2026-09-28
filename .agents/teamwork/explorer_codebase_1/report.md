# Hollis Backend Codebase Architecture & Convention Report (Epic 2 Explorer)

**Report Path**: `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\explorer_codebase_1\report.md`  
**Date**: 2026-09-28  
**Investigator**: `explorer_codebase_1`  
**Objective**: Comprehensive investigation of existing codebase structure, patterns, conventions, and Epic 2 readiness in Cloudflare Workers + D1.

---

## 1. Executive Summary

The **Hollis Backend** is an edge-native API service running on **Cloudflare Workers** with **Cloudflare D1 (SQLite)**. Its primary role is to serve as the backend for the AI-driven Android screen automation system (Hollis Android Client).

Key architectural highlights:
- **Zero Runtime Dependencies**: The runtime relies entirely on standard Web APIs (`fetch`, `Request`, `Response`, `crypto.subtle`, `WebSocketPair`). The only package dependency in `package.json` is `wrangler` under `devDependencies`.
- **Pure JavaScript (ESM)**: There is no TypeScript compilation or Babel build step; code is executed directly as modern ECMAScript modules (`.js`) targeting Cloudflare Workers runtime (`compatibility_date: 2026-09-07`).
- **Web Crypto Security Core**: Authentication, password hashing (PBKDF2-SHA256, 100k iterations, constant-time verification), and JWT signing/verification (HMAC-SHA256) are implemented purely with `crypto.subtle`, avoiding Node.js binaries or external libraries.
- **Current Milestone State**:
  - **Phase 1 (Epic 1 Auth & Epic 5 Settings)**: Complete and verified by `test_phase1.js` (24/24 tests passing).
  - **Phase 2 HTTP Task Lifecycle**: `src/routes/tasks.js` and `test_phase2.js` already implement HTTP task session creation, status polling fallback, session summary, cancellation, confirmation, and log replay.
  - **Epic 2 WebSocket & Streaming (Pending)**: The WebSocket gateway (`WS /ws/tasks/:session_id`), native `WebSocketPair` handling, mock log streaming into `task_steps`, real-time cancellation broadcast, and `test_epic2.js` are not yet wired into `src/worker.js`.

---

## 2. Project Configuration & Tooling

### 2.1 `package.json`
```json
{
  "name": "lingering-term-dd30",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "deploy": "wrangler deploy",
    "dev": "wrangler dev",
    "start": "wrangler dev"
  },
  "devDependencies": {
    "wrangler": "^4.129.0"
  }
}
```
- **Scripts**:
  - `npm run dev` / `npm start`: Starts the local development server with Wrangler (`wrangler dev`).
  - `npm run deploy`: Deploys to Cloudflare Workers edge network (`wrangler deploy`).
- **Zero Dependencies**: There are no npm runtime packages (`dependencies` is completely absent).
- **TypeScript / tsconfig**: There is **no `tsconfig.json`** in the project root. The project is strictly modern JavaScript with ES modules (`import`/`export`).

### 2.2 `wrangler.jsonc`
The Cloudflare Workers configuration is written in JSON with Comments:
```jsonc
{
  "name": "hollis-backend",
  "main": "src/worker.js",
  "workers_dev": true,
  "preview_urls": false,
  "compatibility_date": "2026-09-07",
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "redact_query_string": false,
    "logs": {
      "enabled": true,
      "head_sampling_rate": 1,
      "persist": true,
      "invocation_logs": true
    },
    "traces": {
      "enabled": false,
      "persist": true,
      "head_sampling_rate": 1
    }
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "hollis-db",
      "database_id": "00000000-0000-0000-0000-000000000001",
      "migrations_dir": "migrations"
    }
  ]
}
```
- Entry point specified as `src/worker.js`.
- D1 Database binding configured as `DB`.
- Migration directory configured as `migrations/`.

### 2.3 Environment Secrets (`.dev.vars` / `.dev.vars.example`)
- `.dev.vars`:
  ```ini
  JWT_SECRET=your-secret-key-here-for-local-development
  ```
- Loaded automatically by `wrangler dev` into `env.JWT_SECRET`.
- Fallback in code: `DEFAULT_JWT_SECRET = 'hollis-default-dev-secret-key-do-not-use-in-prod-32bytes'` in `src/auth/middleware.js`.

---

## 3. `src/` Layout & Router Architecture

### 3.1 Directory Structure
```
src/
├── worker.js          # Main entrypoint & HTTP/CORS router
├── auth/
│   ├── crypto.js      # PBKDF2 password hashing & constant-time verify
│   ├── jwt.js         # Web Crypto HS256 JWT sign & verify, Base64URL
│   └── middleware.js  # authenticate() & requireAuth() middleware
├── routes/
│   ├── auth.js        # /api/auth/* handlers (register, login, verify, logout)
│   ├── users.js       # /api/users/* handlers (GET /me, PUT /settings)
│   └── tasks.js       # /api/tasks/* handlers (start, list, status, cancel, confirm, logs)
└── utils/
    └── response.js    # JSON responses, error formats, CORS headers
```

### 3.2 Entrypoint & Request Routing (`src/worker.js`)
The worker exports a standard Cloudflare Workers fetch handler:
```javascript
export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return corsPreflightResponse();
    }
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const method = request.method.toUpperCase();
      ...
    } catch (err) {
      console.error('Unhandled worker error:', err);
      return errorResponse(err.message || 'Internal server error.', 500, 'internal_error');
    }
  }
}
```

#### Routing Table in `src/worker.js`:
| Route | Method | Handler / Module | Description |
|---|---|---|---|
| `/` or `/health` | ANY | Inline in `worker.js` | Service health check & discovery (`phase: 2`) |
| `/api/auth/register` | `POST` | `handleRegister(request, env)` | Registers new user + default settings |
| `/api/auth/login` | `POST` | `handleLogin(request, env)` | Authenticates user, returns access & refresh tokens |
| `/api/auth/verify-token`| `POST` | `handleVerifyToken(request, env)`| Validates token for Android Splash screen |
| `/api/auth/logout` | `POST` | `handleLogout(request, env)` | Confirms logout |
| `/api/users/me` | `GET` | `handleGetMe(request, env)` | Returns user profile & current settings |
| `/api/users/settings` | `PUT` | `handleUpdateSettings(request, env)` | Updates `confirmation_mode` and `max_step_limit` |
| `/api/tasks` or `/api/tasks/*` | ANY | `handleTasksRoute(request, env, url, method)` | Task session lifecycle dispatcher |
| Any other path | ANY | Inline 404 | Returns `{ error: 'not_found', message: 'Route not found.' }` |

### 3.3 Response Utilities (`src/utils/response.js`)
All responses enforce standard CORS headers:
```javascript
export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};
```
- `jsonResponse(data, status = 200, customHeaders = {})`: Returns HTTP `Response` with JSON body and CORS headers.
- `errorResponse(message, status = 400, errorCode = null, customHeaders = {})`: Returns standardized error JSON:
  ```json
  {
    "error": "error_code_or_message",
    "message": "Human readable message"
  }
  ```
- `corsPreflightResponse()`: Returns HTTP 204 No Content with CORS headers.

---

## 4. Authentication & JWT Implementation

### 4.1 Web Crypto Password Hashing (`src/auth/crypto.js`)
- **Algorithm**: PBKDF2 with SHA-256.
- **Key Parameters**:
  - Salt: 16 bytes generated via `crypto.getRandomValues(new Uint8Array(16))`.
  - Iterations: 100,000 iterations.
  - Derived Key Length: 256 bits (32 bytes).
- **Storage Format**: `pbkdf2_sha256:100000:<salt_hex>:<hash_hex>`.
- **Verification**: `verifyPassword(password, storedHash)` derives the key with the stored salt and iteration count, and performs a **constant-time byte-by-byte XOR comparison** (`diff |= derivedBytes[i] ^ originalBytes[i]`) to prevent timing side-channel attacks.

### 4.2 Web Crypto JWT Engine (`src/auth/jwt.js`)
- **Algorithm**: HMAC-SHA256 (`HS256`).
- **Base64URL Encoding**: Implemented from scratch using standard Web APIs (`btoa`, `atob`, `TextEncoder`, `TextDecoder`) without Node `Buffer`.
- **Signing (`signJwt`)**:
  - Sets header `{ alg: 'HS256', typ: 'JWT' }`.
  - Signs UTF-8 data string `<header>.<payload>` using `crypto.subtle.sign('HMAC', key, data)`.
  - Default expiration: 3600 seconds (1 hour) for access tokens, 7 days for refresh tokens.
- **Verification (`verifyJwt`)**:
  - Checks 3-part structure `<header>.<payload>.<signature>`.
  - Confirms header has `alg === 'HS256'` and `typ === 'JWT'`.
  - Cryptographically verifies signature using `crypto.subtle.verify('HMAC', key, signature, data)`.
  - Validates `exp` (expiration timestamp) and `nbf` (not before timestamp) against current epoch time `Math.floor(Date.now() / 1000)`.

### 4.3 Auth Middleware (`src/auth/middleware.js`)
- `authenticate(request, env)`:
  1. Inspects request header `Authorization` (or `authorization`).
  2. Requires `Bearer <token>` format.
  3. Validates token signature and expiration via `verifyJwt(token, env.JWT_SECRET || DEFAULT_JWT_SECRET)`.
  4. Enforces claim type check: `payload.type === 'access'`.
  5. On failure: returns an `errorResponse('...', 401, 'unauthorized')`.
  6. On success: returns `{ user: { id: payload.sub, email: payload.email, username: payload.username } }`.
- `requireAuth(request, env)`: A convenience helper returning `{ user, response }`.

---

## 5. Database & Cloudflare D1 Architecture

### 5.1 D1 Configuration
- Configured in `wrangler.jsonc` as:
  ```jsonc
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "hollis-db",
      "database_id": "00000000-0000-0000-0000-000000000001",
      "migrations_dir": "migrations"
    }
  ]
  ```
- Accessible inside Worker handlers via `env.DB`.

### 5.2 Schema Definition (`migrations/0001_initial_schema.sql`)
The migration defines 5 core tables and 8 indexes:

1. **`users`**:
   - `id TEXT PRIMARY KEY NOT NULL` (UUID v4)
   - `username TEXT NOT NULL`
   - `email TEXT NOT NULL UNIQUE COLLATE NOCASE`
   - `password_hash TEXT NOT NULL`
   - `created_at TEXT NOT NULL` (ISO 8601)

2. **`user_settings`** (1:1 with `users`):
   - `id TEXT PRIMARY KEY NOT NULL`
   - `user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE`
   - `confirmation_mode TEXT NOT NULL DEFAULT 'popup' CHECK (confirmation_mode IN ('popup', 'push', 'none'))`
   - `max_step_limit INTEGER NOT NULL DEFAULT 20 CHECK (max_step_limit > 0 AND max_step_limit <= 1000)`
   - `updated_at TEXT NOT NULL`

3. **`sessions`** (Task Sessions):
   - `id TEXT PRIMARY KEY NOT NULL` (UUID v4)
   - `user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`
   - `instruction TEXT NOT NULL`
   - `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'stopped_loop', 'stopped_limit'))`
   - `step_count INTEGER NOT NULL DEFAULT 0 CHECK (step_count >= 0)`
   - `started_at TEXT NOT NULL`
   - `ended_at TEXT` (NULLABLE)

4. **`task_steps`** (Real-time Step Logs & Replay):
   - `id TEXT PRIMARY KEY NOT NULL` (UUID v4)
   - `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`
   - `step_no INTEGER NOT NULL CHECK (step_no >= 0)`
   - `action_type TEXT NOT NULL`
   - `log_message TEXT`
   - `is_risky INTEGER NOT NULL DEFAULT 0 CHECK (is_risky IN (0, 1))`
   - `verified_changed INTEGER NOT NULL DEFAULT 0 CHECK (verified_changed IN (0, 1))`
   - `created_at TEXT NOT NULL`
   - `UNIQUE (session_id, step_no)`

5. **`risk_confirmations`**:
   - `id TEXT PRIMARY KEY NOT NULL`
   - `session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`
   - `step_id TEXT NOT NULL UNIQUE REFERENCES task_steps(id) ON DELETE CASCADE`
   - `requested_mode TEXT NOT NULL CHECK (requested_mode IN ('popup', 'push'))`
   - `user_response TEXT CHECK (user_response IS NULL OR user_response IN ('approved', 'rejected', 'timed_out', 'timeout'))`
   - `responded_at TEXT`

### 5.3 D1 Query Patterns & Conventions
- **UUID Generation**: Application-level UUID v4 generation using `crypto.randomUUID()`.
- **Timestamps**: UTC ISO strings generated via `new Date().toISOString()`.
- **Prepared Statements**:
  ```javascript
  const session = await env.DB.prepare(
    `SELECT id AS session_id, instruction, status, step_count, started_at, ended_at
     FROM sessions
     WHERE id = ? AND user_id = ?`
  ).bind(sessionId, user.id).first();
  ```
- **Row-Level Tenant Isolation**: All session and task queries strictly bind `user_id = user.id` to prevent cross-user data leakage.
- **Batch Operations**: Atomic operations use `env.DB.batch([...])`, as seen in registration:
  ```javascript
  await env.DB.batch([
    env.DB.prepare('INSERT INTO users ...').bind(...),
    env.DB.prepare('INSERT INTO user_settings ...').bind(...)
  ]);
  ```

---

## 6. Existing Task Route Implementation (`src/routes/tasks.js`)

`src/routes/tasks.js` contains handlers for task HTTP endpoints:
1. `handleStartTask`:
   - Validates `instruction` (non-empty string).
   - Generates `sessionId = crypto.randomUUID()`.
   - Inserts session into `sessions` with `status = 'running'`, `step_count = 0`, `started_at = now`.
   - Returns `{ session_id: sessionId, status: 'running' }` with HTTP 201.
2. `handleListTasks`:
   - Supports query params `status`, `q`, `page`, `limit` (max 100, default 20), `offset`.
   - Enforces `user_id = user.id`.
   - Returns `{ tasks: [...], total, limit, offset }`.
3. `handleGetTaskSummary`:
   - Returns session metadata and computes `duration` in seconds.
4. `handleGetTaskStatus`:
   - Polling fallback returning `current_step` and `last_log` from `task_steps`.
5. `handleCancelTask`:
   - Updates `sessions` table: `UPDATE sessions SET status = 'cancelled', ended_at = ? WHERE id = ?`.
   - Returns `{ session_id, status: 'cancelled' }`.
6. `handleConfirmTask`:
   - Records approval/rejection in `risk_confirmations`.
7. `handleGetTaskLogs`:
   - Replay logs query: `SELECT ... FROM task_steps WHERE session_id = ? ORDER BY step_no ASC`.

---

## 7. Existing Test Suites & Execution Architecture

The repository contains two standalone test suites:

### 7.1 `test_phase1.js` (Phase 1 Auth & Settings)
- **Size**: 860 lines.
- **Framework**: Pure Node.js (v18+), zero external packages. Uses native `fetch` and Web Crypto.
- **Target**: Default `http://127.0.0.1:8787` (configurable via `--url`).
- **Structure**: 24 test cases divided across 4 tiers:
  - **Tier 1 (Happy Path)**: Registration, login, token verification, profile & settings retrieval, settings update, logout.
  - **Tier 2 (Boundary & Corner Cases)**: Duplicate emails, case-insensitive collision, malformed emails, short passwords (<8), missing fields, wrong password, expired JWTs, invalid confirmation modes, invalid step limits.
  - **Tier 3 (Cross-Feature & Security)**: Missing token, invalid token, DB persistence verification across multiple requests.
  - **Tier 4 (Real-World Workload)**: Full Android lifecycle simulation (Register -> Splash verify -> Fetch settings -> Update -> Logout -> Re-login -> Persistence check).
- **Execution**:
  ```bash
  # In terminal 1:
  npm run dev
  # In terminal 2:
  node test_phase1.js --url http://127.0.0.1:8787
  ```

### 7.2 `test_phase2.js` (Phase 2 Tasks & History)
- **Size**: 372 lines.
- **Coverage**: 24 tests (T01 - T24):
  - T01: Health check endpoint.
  - T02-T03: User A and User B registration (for isolation verification).
  - T04-T07: `POST /api/tasks/start` input validation and task creation.
  - T08-T10: Polling fallback `GET /api/tasks/:id/status` and cross-user isolation.
  - T11: `GET /api/tasks/:id` task summary and duration calculation.
  - T12-T14: `POST /api/tasks/:id/cancel` cancellation and isolation.
  - T15-T16: `POST /api/tasks/:id/confirm` approval validation.
  - T17-T22: History listing, filtering by status, search by query `q`, pagination, user isolation.
  - T23-T24: `GET /api/tasks/:id/logs` step logs replay.
- **Execution**:
  ```bash
  node test_phase2.js --url http://127.0.0.1:8787
  ```

---

## 8. Documentation Files (`API_DOCUMENTATION.md`)

`API_DOCUMENTATION.md` is a 322-line comprehensive guide written in Thai for Android Client developers:
- **Base URLs**:
  - HTTP: `http://127.0.0.1:8787`
  - WebSocket: `ws://127.0.0.1:8787`
- **Section 1: Authentication (Epic 1)**
- **Section 2: User Settings (Epic 5)**
- **Section 3: Chat & Tasks (Epic 2)**:
  - `POST /api/tasks/start`: Creates session, returns `session_id`.
  - `WS /ws/tasks/{session_id}`:
    - Auth via query parameter `?token=<access_token>` or auth message.
    - Incoming event `event: "log"`:
      ```json
      {
        "event": "log",
        "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
        "step_no": 1,
        "log_message": "กำลังค้นหาแอป LINE บนหน้าจอหลัก...",
        "timestamp": "2026-09-28T10:50:00.000Z"
      }
      ```
    - Incoming event `event: "finished"`:
      ```json
      {
        "event": "finished",
        "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
        "status": "completed",
        "step_count": 4,
        "summary_message": "ส่งข้อความสำเร็จเรียบร้อยแล้ว"
      }
      ```
    - Incoming event `event: "cancelled"`:
      ```json
      {
        "event": "cancelled",
        "session_id": "3c983582-7d2d-4874-9457-3a1391df24bc",
        "status": "cancelled",
        "summary_message": "งานถูกยกเลิกโดยผู้ใช้"
      }
      ```
  - `POST /api/tasks/{session_id}/cancel`: Sets status to `cancelled`, broadcasts to active WebSocket, and returns `{ session_id, status: "cancelled" }`.

---

## 9. Epic 2 Implementation Gap Analysis & Architectural Roadmap

Comparing `ORIGINAL_REQUEST.md` (Epic 2 requirements) against the current codebase:

| Epic 2 Requirement | Current Status in Codebase | Implementation Gap / Needed Action |
|---|---|---|
| **R1. Task Start & Polling** (`POST /api/tasks/start`, `GET /api/tasks/:id/status`) | **Implemented** in `src/routes/tasks.js` | Works properly, tested in `test_phase2.js`. |
| **R2. WebSocket Gateway** (`WS /ws/tasks/:session_id`) | **Missing** | `src/worker.js` does not intercept `/ws/tasks/` or handle WebSocket upgrades. Need a dedicated WebSocket route handler (`src/routes/websocket.js` or in `tasks.js`). |
| **R2. WebSocket Authentication** | **Missing** | Must validate token from URL query `?token=<access_token>` or initial message. Must verify that `session_id` exists in D1 and belongs to the authenticated user. Return 401 if invalid. |
| **R2. Native `WebSocketPair` Handshake** | **Missing** | Must create `new WebSocketPair()`, call `server.accept()`, and return `new Response(null, { status: 101, webSocket: client })`. |
| **R2. Mock Log Streaming & D1 Persistence** | **Missing** | When connected, simulate sequential progress steps (`{ event: "log", step_no, log_message, timestamp }`). Each step must be inserted into `task_steps` in D1 and update `step_count` in `sessions`. |
| **R2. Heartbeat Ping/Pong** | **Missing** | Support ping/pong frames or JSON `{ type: "ping" }` / `{ type: "pong" }` to prevent edge timeout. |
| **R3. In-flight Task Cancellation Broadcast** | **Partially Implemented** | `handleCancelTask` in `src/routes/tasks.js` updates D1 status, but does not notify active WebSocket connection. Needs an active connection registry (in-memory map of active WebSockets) to broadcast `{ event: "cancelled", ... }` and close connection cleanly. |
| **R4. Automated Test Suite `test_epic2.js`** | **Missing** | Need standalone test script `test_epic2.js` using Node.js WebSocket (or standard WebSocket API in Node 20+) to verify task creation -> WS handshake -> token check -> log streaming reception -> cancellation broadcast. |
| **R4. Documentation Updates** | **Mostly Complete** | `API_DOCUMENTATION.md` already contains the protocol spec; verify consistency during implementation. |

---

## 10. Key Recommendations for the Implementation Team

1. **Routing Interception in `src/worker.js`**:
   Add detection for `/ws/tasks/` before the 404 handler:
   ```javascript
   if (path.startsWith('/ws/tasks/')) {
     return await handleTasksWebSocket(request, env, url);
   }
   ```
2. **Active WebSocket Registry**:
   Maintain an in-memory session registry in module scope:
   ```javascript
   // Map<sessionId, { webSocket: WebSocket, userId: string, isCancelled: boolean, timerId?: any }>()
   export const activeSessions = new Map();
   ```
   When `handleCancelTask` in `src/routes/tasks.js` is invoked, look up `activeSessions.get(sessionId)`:
   - Mark `session.isCancelled = true`
   - Send cancellation payload:
     `webSocket.send(JSON.stringify({ event: 'cancelled', session_id: sessionId, status: 'cancelled' }))`
   - Call `webSocket.close(1000, 'Task cancelled by user')`
   - Clean up from map.
3. **Mock Log Streaming Loop**:
   Use `ctx.waitUntil()` or asynchronous timers (or `setInterval` / `setTimeout` attached to the accepted server WebSocket) to stream 3-5 mock automation logs at intervals (e.g., 500ms - 1000ms), checking if the session was cancelled before each step.
4. **WebSocket Native Testing in `test_epic2.js`**:
   In Node.js 20+, native global `WebSocket` is available. The test runner can test the full lifecycle:
   - Register user -> get token.
   - Start task -> get `session_id`.
   - Attempt WS connect without token -> assert 401.
   - WS connect with valid `?token=` -> assert 101 Switching Protocols.
   - Receive connected event & sequential `log` events.
   - Trigger `POST /api/tasks/:session_id/cancel` -> assert WS receives `cancelled` event and closes.
   - Query D1 / status endpoint to verify final state.
