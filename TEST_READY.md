# TEST_READY — Hollis Backend Epic 2 Test Suite

**Epic 2: ระบบแชทหลัก (Chat & Real-time Communication System)**  
**Test Suite Path:** `test_epic2.js` (Project Root)  
**Author:** `test_writer_1` (E2E Testing Specialist)  
**Date:** 2026-09-28  
**Status:** READY FOR VERIFICATION  

---

## 1. Executive Summary & Verification Scope

`test_epic2.js` is a standalone, dependency-free End-to-End (E2E) automated verification suite designed specifically for Epic 2 (Chat & Real-time Communication System) in the Hollis Backend.

It exercises:
1. **REST APIs**: Task session creation (`POST /api/tasks/start`), polling status fallback (`GET /api/tasks/:session_id/status`), task cancellation (`POST /api/tasks/:session_id/cancel`), task history (`GET /api/tasks`), and step log replay (`GET /api/tasks/:session_id/logs`).
2. **WebSocket Gateway**: RFC 6455 duplex communication over `/ws/tasks/:session_id?token=<access_token>` powered by Cloudflare Workers native `WebSocketPair`.
3. **Real-time Event Streaming**: Initial handshake acknowledgment (`connected`), sequential progress step streaming (`log`), completion signals (`finished`), cancellation broadcast (`cancelled`), and bidirectional heartbeat keepalive (`ping` / `pong`).
4. **Cloudflare D1 Persistence**: State machine persistence (`sessions` table) and real-time step audit logging (`task_steps` table).
5. **Security & Isolation**: Multi-tenant session isolation (preventing cross-user eavesdropping or cancellation) and handshake authentication.

---

## 2. Test Execution Command

Run the test suite against a running local Cloudflare Workers dev server:

```bash
# Default (http://127.0.0.1:8787)
node test_epic2.js

# Custom URL
node test_epic2.js --url http://127.0.0.1:8787

# Windows Command Prompt
cmd.exe /c "node test_epic2.js --url http://127.0.0.1:8787"
```

### Prerequisites
- **Runtime**: Node.js v22 or v24+ (utilizing global `fetch`, global `WebSocket`, and Web Crypto API).
- **Dependencies**: Zero external npm packages required.
- **Server**: Wrangler development server running locally (`npm run dev` or `npx wrangler dev`).

---

## 3. Comprehensive Test Tier Breakdown (25 Test Cases)

| Tier | Category | Test Count | Description |
|---|---|---|---|
| **Tier 1** | Feature Coverage (Happy Path) | 8 | Core registration, task start, polling status, WS upgrade, sequential log streaming, finished event, clean closure, and D1 persistence |
| **Tier 2** | Boundary & Corner Cases | 9 | Missing/invalid tokens, refresh token rejection, non-existent sessions, cross-user isolation (WS & REST), input validation, ping/pong heartbeats, malformed frames |
| **Tier 3** | Cross-Feature & Cancellation | 5 | In-flight REST cancellation broadcast over WS, socket termination, D1 status audit, in-band WS cancellation (`cancel` frame), idempotent repeat cancels, terminal reconnection |
| **Tier 4** | Real-World Android Workloads | 3 | Full Android client lifecycle simulation, multi-session parallel streaming with zero cross-talk, concurrent stream cancellation isolation |

---

## 4. Test Case Inventory Table

| ID | Tier | Title | Target Endpoint / Channel | Expected Result | Authoritative Source |
|---|---|---|---|---|---|
| **TC-01** | 1 | User registration & login | `POST /api/auth/register`, `POST /api/auth/login` | HTTP 201 + `access_token`, HTTP 200 + `refresh_token` | `ORIGINAL_REQUEST.md` § R2 |
| **TC-02** | 1 | Start task session | `POST /api/tasks/start` | HTTP 201 `{ session_id, status: "running" }` | `ORIGINAL_REQUEST.md` § R1 |
| **TC-03** | 1 | Initial polling status query | `GET /api/tasks/:id/status` | HTTP 200 `{ status: "running", current_step: 0, last_log: null }` | `ORIGINAL_REQUEST.md` § R1 |
| **TC-04** | 1 | WebSocket upgrade handshake | `WS /ws/tasks/:id?token=...` | HTTP 101 Switching Protocols; socket reaches `open` state | `ORIGINAL_REQUEST.md` § R2 |
| **TC-05** | 1 | Initial connected frame | `WS /ws/tasks/:id` | Receives `{ event: "connected", session_id }` | `PROJECT.md` § Interface Contracts |
| **TC-06** | 1 | Sequential log streaming | `WS /ws/tasks/:id` | Receives sequential `{ event: "log", step_no: 1..N, ... }` | `ORIGINAL_REQUEST.md` § R2 |
| **TC-07** | 1 | Task finished & clean close | `WS /ws/tasks/:id` | Receives `{ event: "finished", status: "completed" }`; close code `1000` | `PROJECT.md` § Interface Contracts |
| **TC-08** | 1 | D1 SQLite step persistence | `GET /api/tasks/:id/logs`, status | All emitted steps saved in `task_steps`; `sessions.status = 'completed'` | `ORIGINAL_REQUEST.md` § R2 |
| **TC-09** | 2 | WS handshake without token | `WS /ws/tasks/:id` | Rejected with HTTP 401 Unauthorized; handshake fails | `ORIGINAL_REQUEST.md` § Acceptance Criteria |
| **TC-10** | 2 | WS handshake with invalid token | `WS /ws/tasks/:id?token=invalid` | Rejected with HTTP 401 Unauthorized; handshake fails | `PROJECT.md` § Pre-upgrade validation |
| **TC-11** | 2 | WS handshake with refresh token | `WS /ws/tasks/:id?token=refresh` | Rejected with HTTP 401 Unauthorized (access token required) | `PROJECT.md` § Pre-upgrade validation |
| **TC-12** | 2 | WS handshake for unknown session | `WS /ws/tasks/00000000-...?token=...` | Rejected with HTTP 404 Not Found | `ORIGINAL_REQUEST.md` § Acceptance Criteria |
| **TC-13** | 2 | Cross-user WS isolation | `WS /ws/tasks/:idA?token=tokenB` | Rejected with HTTP 404 Not Found (prevents resource sniffing) | `PROJECT.md` § Multi-Tenant Isolation |
| **TC-14** | 2 | Cross-user REST isolation | `GET /status`, `POST /cancel`, `GET /logs` | User B receives HTTP 404 on User A's session across all endpoints | `PROJECT.md` § Multi-Tenant Isolation |
| **TC-15** | 2 | `POST /api/tasks/start` input validation | `POST /api/tasks/start` | HTTP 400 on empty, whitespace, missing, or non-string instruction | `src/routes/tasks.js` |
| **TC-16** | 2 | WS ping/pong heartbeat | `WS /ws/tasks/:id` | Client sends `{ event: "ping" }`, receives `{ event: "pong", timestamp }` | `ORIGINAL_REQUEST.md` § R2 |
| **TC-17** | 2 | Malformed frame resilience | `WS /ws/tasks/:id` | Non-JSON text receives `{ event: "error" }` without server crash | `spec_miner_1/report.md` § 6.2 |
| **TC-18** | 3 | In-flight REST cancellation | `POST /api/tasks/:id/cancel` | HTTP 200; active WS receives `{ event: "cancelled", status: "cancelled" }` | `ORIGINAL_REQUEST.md` § R3 |
| **TC-19** | 3 | Trailing log suppression | `WS /ws/tasks/:id`, status | Socket closed with code 1000; zero trailing log frames emitted | `PROJECT.md` § Cancellation Handling |
| **TC-20** | 3 | In-band WS cancellation | `WS /ws/tasks/:id` | Client sends `{ event: "cancel" }`, receives `{ event: "cancelled" }` + D1 update | `spec_miner_1/report.md` § 6.2 |
| **TC-21** | 3 | Idempotent cancel calls | `POST /api/tasks/:id/cancel` | Subsequent cancel calls return HTTP 200 `{ status: "cancelled" }` safely | `src/routes/tasks.js` |
| **TC-22** | 3 | Terminal session reconnection | `WS /ws/tasks/:idCancelled?token=...` | Receives terminal `{ event: "cancelled" }` frame and closes cleanly (code 1000) | `spec_miner_1/report.md` § E16 |
| **TC-23** | 4 | Full Android client simulation | Verify -> Start -> Poll -> WS -> Ping -> Complete -> History | Complete end-to-end workflow matches Android mobile application specs | `ORIGINAL_REQUEST.md` § R4 |
| **TC-24** | 4 | Parallel stream concurrency | Multi-session parallel tasks | Multiple sessions stream simultaneously with zero cross-talk or ID mixing | `PROJECT.md` § Concurrency |
| **TC-25** | 4 | Concurrent cancellation isolation | 2 parallel sessions (Cancel X, keep Y) | Cancelling Session X does not disrupt or emit cancel to Session Y | `PROJECT.md` § Concurrency |

---

## 5. Architectural Quality Guarantees

1. **Race-Condition Free**:
   - `WsClient` employs an internal FIFO buffer for incoming WebSocket messages and close frames. Even if the server delivers frames immediately upon upgrade, `waitForMessage(...)` locates the frame without lost updates.
2. **Deterministic Assertions**:
   - Every assertion includes informative error diagnostics, printing the exact HTTP status, response body, or timeout context upon unexpected behavior.
3. **Resource Cleanliness**:
   - All WebSocket connections established during test execution are explicitly closed upon test completion or teardown.
