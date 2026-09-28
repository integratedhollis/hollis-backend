# Project: Hollis Backend - Epic 2: ระบบแชทหลัก (Chat & Real-time Communication System)

## Architecture
- **Runtime**: Cloudflare Workers (ES Modules, zero npm runtime dependencies, compatibility date 2026-09-07).
- **Database**: Cloudflare D1 SQLite (`hollis-db` via `env.DB` binding), tables: `users`, `user_settings`, `sessions`, `task_steps`, `risk_confirmations`.
- **Crypto & Auth**: Web Crypto API (`crypto.subtle`) for PBKDF2-SHA256 password hashing and HMAC-SHA256 JWT tokens with custom RFC 7515 Base64URL encoding.
- **WebSocket Gateway**: Native Cloudflare Workers `WebSocketPair` API on `/ws/tasks/:session_id`. Handshake validates JWT via `?token=` query parameter or `Authorization` header, checks D1 session existence and user ownership, switches to HTTP 101, and establishes RFC 6455 connection.
- **Background Execution**: Kept alive via `ctx.waitUntil(...)` carrying the mock log streaming loop.
- **Cross-Request Cancellation**: In-memory registry (`activeSessions` Map in `src/utils/wsRegistry.js`) for instant WebSocket push of `{ event: "cancelled" }` frame and abort signal, combined with D1 status check for edge isolate resilience.
- **Persistence**: Emitted log steps are persisted to SQLite `task_steps` and `sessions.step_count` updated via `env.DB.batch()`.
- **Heartbeat**: Application-level JSON ping/pong (`{"event": "ping"}` -> `{"event": "pong"}`).

---

## Feature Inventory
| # | Feature | Description | Milestone | Source | Status |
|---|---------|-------------|-----------|--------|--------|
| 1 | `POST /api/tasks/start` | Creates session in D1 with `status = 'running'`, `step_count = 0`, returns HTTP 201 `{ session_id, status: "running" }` | M1 | ORIGINAL_REQUEST §R1 | DONE |
| 2 | `GET /api/tasks/:session_id/status` | Polling fallback returning `{ session_id, status, current_step, last_log }` with 401/404 handling | M1 | ORIGINAL_REQUEST §R1 | DONE |
| 3 | WS Route Registration & Upgrade | `src/worker.js` passes `ctx` to routes, handles `/ws/tasks/:session_id`, upgrades to HTTP 101 via `WebSocketPair` | M1 | ORIGINAL_REQUEST §R2 | DONE |
| 4 | WS Authentication & Validation | Validates token from `?token=<jwt>` query param or `Authorization` header, verifies user owns session in D1, rejects with HTTP 401 or 404 | M1 | ORIGINAL_REQUEST §R2 | DONE |
| 5 | In-Memory WS Registry | `src/utils/wsRegistry.js` provides `registerSession(sessionId, entry)`, `getSession(sessionId)`, `removeSession(sessionId)` for active socket tracking | M1 | Explorer WS Arch | DONE |
| 6 | WS Connection Lifecycle & Heartbeat | Sends initial `{ event: "connected", session_id }`, responds to `{ event: "ping" }` with `{ event: "pong" }`, handles socket close/error cleanups | M2 | ORIGINAL_REQUEST §R2 | DONE |
| 7 | Mock Log Streaming Loop | Streams sequential logs `{ event: "log", step_no, log_message, timestamp }` over WS, wrapped in `ctx.waitUntil(...)` | M2 | ORIGINAL_REQUEST §R2 | DONE |
| 8 | D1 Step Persistence & Batching | Inserts each emitted step into `task_steps` and increments `sessions.step_count` atomically via `env.DB.batch()` | M2 | ORIGINAL_REQUEST §R2 | DONE |
| 9 | Task Completion Handling | When mock steps finish, updates `sessions.status = 'completed'`, sends `{ event: "finished", session_id, status: "completed" }`, closes WS cleanly | M2 | Spec Miner | DONE |
| 10 | `POST /api/tasks/:session_id/cancel` | Updates D1 `sessions.status = 'cancelled'`, sets `ended_at = ISO string`, returns `{ session_id, status: "cancelled" }` | M2 | ORIGINAL_REQUEST §R3 | DONE |
| 11 | Cancellation WS Broadcast & Termination | Broadcasts `{ event: "cancelled", session_id, status: "cancelled" }` over active WS, aborts stream loop, closes WS cleanly with code 1000 | M2 | ORIGINAL_REQUEST §R3 | DONE |
| 12 | In-Band WS Cancel Event | Client can also send `{ event: "cancel" }` over active WS to trigger cancellation flow | M2 | Spec Miner | DONE |
| 13 | API Documentation Update | Update `API_DOCUMENTATION.md` with complete payload schemas, WebSocket events, and Android integration guide | M3 | ORIGINAL_REQUEST §R4 | DONE |
| 14 | E2E Test Suite (`test_epic2.js`) | Standalone Node.js test script verifying start, status, WS auth, streaming, step persistence, cancellation, and ping/pong against local dev server | Test Track / M4 | ORIGINAL_REQUEST §R4 | DONE |
| 15 | Adversarial & Regression Hardening | Run all test suites (`test_phase1.js`, `test_phase2.js`, `test_epic2.js`), stress testing, boundary checks, and forensic integrity audit | M4 | Final Milestone | DONE |

---

## Milestones
| # | Name | Scope | Dependencies | Status | Key Outputs |
|---|------|-------|-------------|--------|-------------|
| E2E | E2E Testing Suite | Standalone `test_epic2.js` covering Tiers 1-4, test runner harness, and publish `TEST_READY.md` | Survey | DONE | `test_epic2.js`, `TEST_READY.md` (25 test cases across 4 tiers) |
| M1 | WS Routing, Registry & Gateway | Implement `src/utils/wsRegistry.js`, integrate `/ws/tasks/:session_id` in `src/worker.js`, create `src/routes/websocket.js` handshake & auth | Survey | DONE | `src/utils/wsRegistry.js`, `src/routes/websocket.js`, `src/worker.js` |
| M2 | Mock Streaming, Persistence & Cancellation | Implement log streaming with D1 batch inserts to `task_steps`, integrate `POST /api/tasks/:session_id/cancel` with WS registry broadcast & graceful close | M1 | DONE | `src/routes/websocket.js`, `src/routes/tasks.js` |
| M3 | Documentation Update | Update `API_DOCUMENTATION.md` with complete Epic 2 schemas, WS event contracts, and Android lifecycle guide | M1, M2 | DONE | `API_DOCUMENTATION.md` (Sections 3.1 - 3.5) |
| M4 | Final E2E Pass, Hardening & Audit | Run 100% of E2E test suite (`test_epic2.js`), verify no regressions on Phase 1 & 2, adversarial coverage hardening, and pass Forensic Audit | E2E, M1, M2, M3 | DONE | `GATE_STATUS.md` PASS, `test_challenger3_stress.js`, `test_challenger4_concurrency.js`, Audit CLEAN |

---

## Interface Contracts

### `src/utils/wsRegistry.js`
- `activeSessions`: Map<string, { ws: WebSocket, abortController: AbortController, userId: string }>
- `registerSession(sessionId, sessionData)`: Pre-empts superseded sockets (close code 1000 'Replaced by new connection')
- `getSession(sessionId)`: Retrieves active session data
- `removeSession(sessionId, ws)`: Reference-guarded deletion preventing stale socket close eviction
- `cancelActiveSession(sessionId)`: Sends cancellation frame, aborts controller, closes ws code 1000

### `WS /ws/tasks/:session_id`
- Handshake URL: `/ws/tasks/:session_id?token=<jwt>` with `Upgrade: websocket`
- Pre-upgrade validation:
  - Missing/invalid token -> HTTP 401
  - Non-existent or cross-tenant session -> HTTP 404
- Upgrade: HTTP 101 Switching Protocols
- Server events:
  - `connected`: `{"event": "connected", "session_id": string, "status": "running"}`
  - `log`: `{"event": "log", "session_id": string, "step_no": number, "log_message": string, "timestamp": string, "is_risky": boolean, "action_type": string}`
  - `finished`: `{"event": "finished", "session_id": string, "status": "completed", "total_steps": number}`
  - `cancelled`: `{"event": "cancelled", "session_id": string, "status": "cancelled", "summary_message": string}`
  - `error`: `{"event": "error", "message": "Invalid message format"}` (keeps connection open)
  - `pong`: `{"event": "pong", "timestamp": string}`
- Client events:
  - `ping`: `{"event": "ping"}`
  - `cancel`: `{"event": "cancel"}`

### `POST /api/tasks/:session_id/cancel`
- Headers: `Authorization: Bearer <jwt>`
- Response: HTTP 200 `{"session_id": string, "status": "cancelled"}`
- Synchronous effect: D1 update + `cancelActiveSession(sessionId)` broadcast & clean close.
