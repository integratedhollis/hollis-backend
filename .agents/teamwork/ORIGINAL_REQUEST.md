# Original User Request

## 2026-09-07T14:25:25Z

Implement Phase 1 of the Hollis Backend (Foundation, Cloudflare D1 Database Schema, Authentication & User Settings API) for the AI-driven Android screen automation system.

Working directory: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend
Integrity mode: development

## Requirements

### R1. Cloudflare D1 SQLite Schema & Migrations
- Set up Cloudflare D1 configuration in `wrangler.jsonc`.
- Write SQL migration file(s) for the 5 core tables defined in the Hollis System Design Document:
  1. `users` (`id` TEXT PK, `username` TEXT, `email` TEXT UNIQUE, `password_hash` TEXT, `created_at` TEXT)
  2. `user_settings` (`id` TEXT PK, `user_id` TEXT UNIQUE FK, `confirmation_mode` TEXT DEFAULT 'popup', `max_step_limit` INTEGER DEFAULT 20, `updated_at` TEXT)
  3. `sessions` (`id` TEXT PK, `user_id` TEXT FK, `instruction` TEXT, `status` TEXT, `step_count` INTEGER DEFAULT 0, `started_at` TEXT, `ended_at` TEXT NULLABLE)
  4. `task_steps` (`id` TEXT PK, `session_id` TEXT FK, `step_no` INTEGER, `action_type` TEXT, `log_message` TEXT, `is_risky` INTEGER DEFAULT 0, `verified_changed` INTEGER DEFAULT 0, `created_at` TEXT)
  5. `risk_confirmations` (`id` TEXT PK, `session_id` TEXT FK, `step_id` TEXT FK, `requested_mode` TEXT, `user_response` TEXT NULLABLE, `responded_at` TEXT NULLABLE)
- Enforce SQLite constraints: generate UUID v4 strings in application layer before INSERT, use INTEGER (0/1) for booleans, and store timestamps as ISO 8601 strings.

### R2. Web Crypto & Authentication APIs
- Implement secure password hashing and verification using Web Crypto API (e.g. PBKDF2 with salt) compatible with the Cloudflare Workers edge environment without relying on native Node.js binaries.
- Implement JWT token generation and verification middleware for bearer authorization.
- Provide the following endpoints under `/api/auth`:
  - `POST /api/auth/register`: validates input, checks duplicate email, hashes password, inserts user into `users`, creates initial row in `user_settings`, and returns `user_id` and `access_token`.
  - `POST /api/auth/login`: validates email and password, returns `access_token` and `refresh_token`.
  - `POST /api/auth/verify-token`: accepts token and returns `{ valid: true, user_id: "..." }` or `{ valid: false }` for Android Splash Screen checks.
  - `POST /api/auth/logout`: handles token invalidation/client logout confirmation.

### R3. User Profile & Security Settings APIs
- Provide the following endpoints under `/api/users` (protected by JWT middleware):
  - `GET /api/users/me`: returns the logged-in user profile (`user_id`, `username`, `email`) and their current settings (`confirmation_mode`, `max_step_limit`).
  - `PUT /api/users/settings`: updates `confirmation_mode` (`popup` | `push` | `none`) and optional `max_step_limit`, returning the updated status immediately.

### R4. Automated Verification Suite
- Provide an automated test script (`test_phase1.js` or equivalent) that can be run against local Wrangler dev environment (`wrangler dev` + local D1) to objectively verify all endpoints and edge cases.

## Acceptance Criteria

### D1 Database & Migrations
- [ ] D1 migration executes cleanly with `wrangler d1 migrations apply` (local) without errors.
- [ ] All 5 tables and foreign key constraints exist in the database.

### Authentication Functionality
- [ ] `POST /api/auth/register` creates a user, sets default `user_settings`, and returns HTTP 201 with `access_token`.
- [ ] Registering with an existing email returns HTTP 400 Bad Request with an appropriate error message.
- [ ] `POST /api/auth/login` with valid credentials returns HTTP 200 with `access_token`.
- [ ] `POST /api/auth/login` with invalid credentials returns HTTP 401 Unauthorized.
- [ ] `POST /api/auth/verify-token` returns `valid: true` and `user_id` for a valid token, and `valid: false` for an invalid/expired token.

### User Settings Functionality
- [ ] `GET /api/users/me` with a valid Bearer token returns HTTP 200 containing user details and current settings.
- [ ] `GET /api/users/me` without a token returns HTTP 401 Unauthorized.
- [ ] `PUT /api/users/settings` successfully updates `confirmation_mode` (e.g. to `push` or `none`) and verifies persistence in D1.

### Automated Test Execution
- [ ] An automated test runner runs through the complete sequence (register -> login -> verify token -> get profile -> update settings -> invalid cases) and all assertions pass.

## 2026-09-28T03:53:53Z

Implement Epic 2: ระบบแชทหลัก (Chat & Real-time Communication System) for the Hollis Backend on Cloudflare Workers and D1 database.

Working directory: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend
Integrity mode: development

## Requirements

### R1. Task Start & Session Creation
- Implement `POST /api/tasks/start` accepting `{ instruction: string }` from authenticated users.
- Create a new record in D1 `sessions` table with status `running`, initial `step_count = 0`, and return `{ session_id, status: "running" }`.
- Provide `GET /api/tasks/:session_id/status` as a polling fallback returning current status and last log.

### R2. WebSocket Gateway & Mock Log Streaming
- Implement `WS /ws/tasks/:session_id` using Cloudflare Workers native `WebSocketPair`.
- Validate user authorization via query parameter `?token=<access_token>` or auth message.
- Verify `session_id` exists in D1 and belongs to the authenticated user.
- Hold the connection and stream mock progress logs as JSON events (`{ event: "log", step_no, log_message, timestamp }`) to the client, recording each step into the `task_steps` table in D1.
- Support ping/pong heartbeats to keep the connection healthy.

### R3. Task Cancellation & Connection Termination
- Implement `POST /api/tasks/:session_id/cancel` allowing in-flight cancellation.
- Update session status in D1 to `cancelled`, record `ended_at` timestamp.
- Broadcast cancellation event (`{ event: "cancelled", session_id, status: "cancelled" }`) over the active WebSocket and close the connection cleanly.

### R4. API Documentation & Automated Test Suite
- Ensure `API_DOCUMENTATION.md` contains up-to-date payload schemas and Android integration guides for all Epic 2 endpoints.
- Provide a standalone automated test script `test_epic2.js` that verifies task start, WebSocket connection handshake, real-time message streaming, and cancellation against local Wrangler dev environment.

## Acceptance Criteria

### Task Start & Status
- [ ] `POST /api/tasks/start` with valid Bearer token and instruction returns HTTP 201 with `session_id` and `status: "running"`.
- [ ] Non-existent session queries return HTTP 404.

### WebSocket Communication
- [ ] Connecting to `/ws/tasks/:session_id` without valid token is rejected with HTTP 401.
- [ ] Connecting to `/ws/tasks/:session_id` with valid token establishes a WebSocket connection (HTTP 101 Switching Protocols).
- [ ] Client receives initial connected event followed by sequential real-time mock log events.
- [ ] Emitted log steps are persisted to the `task_steps` table in D1.

### Cancellation Handling
- [ ] Calling `POST /api/tasks/:session_id/cancel` sets `sessions.status` to `cancelled` in D1.
- [ ] Active WebSocket receives cancellation event and closes gracefully.

### Automated Testing
- [ ] `node test_epic2.js --url http://127.0.0.1:8787` passes all tests with 0 failures.
