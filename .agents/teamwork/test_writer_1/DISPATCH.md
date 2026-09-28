## 2026-09-28T04:07:52Z
You are test_writer_1, the E2E Testing specialist for Epic 2 (Chat & Real-time Communication System) in the Hollis Backend project.
Your Working Directory: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\test_writer_1
Project Root: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend
Authoritative Request File: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\ORIGINAL_REQUEST.md
PROJECT.md File: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\orchestrator_epic2\PROJECT.md
Spec Miner Report: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\spec_miner_1\report.md

MISSION:
Design and implement the complete standalone automated test suite `test_epic2.js` at the project root:
`c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\test_epic2.js`
And publish `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\TEST_READY.md` when the test suite is ready.

REQUIREMENTS & TEST SPECIFICATION:
1. Examine existing tests (`test_phase1.js` and `test_phase2.js`) to follow the exact same runner structure, formatting, colors, and conventions. Zero external npm dependencies (use native `fetch` and native `WebSocket` in Node.js 22/24). Support `--url http://127.0.0.1:8787` CLI argument (defaulting to `http://127.0.0.1:8787`).
2. Design a comprehensive 4-tier test suite covering:
   - Tier 1: Feature Coverage (Happy Path)
     - User registration & login to obtain JWT access token.
     - `POST /api/tasks/start` with `{ instruction: "Test instruction" }` returning HTTP 201 `{ session_id, status: "running" }`.
     - `GET /api/tasks/:session_id/status` returning HTTP 200 with session status and last log.
     - WebSocket connection to `/ws/tasks/:session_id?token=<access_token>` upgrading successfully (HTTP 101).
     - Receiving initial `{ event: "connected" }` frame.
     - Receiving sequential `{ event: "log" }` frames.
     - Receiving `{ event: "finished" }` upon task completion.
     - Verification that emitted logs were written to SQLite `task_steps` in D1 (via `GET /api/tasks/:session_id/logs` or status check).
   - Tier 2: Boundary & Corner Cases
     - Connecting to `/ws/tasks/:session_id` without token -> rejected with HTTP 401.
     - Connecting to `/ws/tasks/:session_id` with invalid/expired token -> rejected with HTTP 401.
     - Connecting to `/ws/tasks/:session_id` for non-existent session ID -> rejected with HTTP 404.
     - Cross-user session access: User B attempting to connect to User A's session -> rejected with HTTP 404.
     - Calling `POST /api/tasks/:session_id/cancel` for non-existent or other user's session -> rejected with HTTP 404.
     - Ping/Pong: Client sends `{ event: "ping" }` over WS and receives `{ event: "pong" }`.
   - Tier 3: Cross-Feature Combinations & Real-Time Cancellation
     - In-flight cancellation: User starts task, connects WS, receives at least 1 log event, then calls `POST /api/tasks/:session_id/cancel`.
     - Verify active WS receives `{ event: "cancelled", session_id, status: "cancelled" }` frame.
     - Verify WS is closed cleanly (code 1000).
     - Verify `GET /api/tasks/:session_id/status` reflects `status: "cancelled"`.
     - Verify no further log frames are emitted after cancellation.
     - In-band WS cancellation: Client sends `{ event: "cancel" }` over active WS and receives `{ event: "cancelled" }` and clean close.
   - Tier 4: Real-World Android Workload Scenarios
     - Full automated workflow simulation: Register, start task, stream logs, heartbeat ping during execution, completion verification.
     - Concurrency: Multiple concurrent tasks and WebSocket connections running simultaneously without cross-talk.
3. Once `test_epic2.js` is written and syntax-checked, create `TEST_READY.md` at project root with the test tier breakdown and test run command (`node test_epic2.js --url http://127.0.0.1:8787`).
4. Write your handoff report to:
   `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\test_writer_1\handoff.md`
5. Report completion with summary and artifact paths.
