## 2026-09-28T04:07:52Z
You are worker_1, the implementation specialist for Epic 2 (Chat & Real-time Communication System) in the Hollis Backend project.
Your Working Directory: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\worker_1
Project Root: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend
Authoritative Request File: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\ORIGINAL_REQUEST.md
PROJECT.md: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\orchestrator_epic2\PROJECT.md
Architecture Report: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\explorer_ws_arch_1\report.md
Codebase Report: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\explorer_codebase_1\report.md
Spec Miner Report: c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\spec_miner_1\report.md

MANDATORY INTEGRITY WARNING:
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

EXCLUSIVE FILE WRITE OWNERSHIP:
You own and may modify:
- `src/utils/wsRegistry.js` (New file)
- `src/routes/websocket.js` (New file)
- `src/worker.js` (Routing updates)
- `src/routes/tasks.js` (Cancellation coordination)
- `API_DOCUMENTATION.md` (Update schemas & Android guide)
DO NOT modify or create test files (owned by test_writer).

IMPLEMENTATION SCOPE & INSTRUCTIONS:
1. `src/utils/wsRegistry.js`:
   - Implement an in-memory `Map` (`activeSessions`) tracking active WebSocket connections: `sessionId -> { ws, abortController, userId }`.
   - Export helper functions: `registerSession(sessionId, sessionData)`, `getSession(sessionId)`, `removeSession(sessionId)`, `cancelActiveSession(sessionId)`.
   - `cancelActiveSession` sends `{ event: "cancelled", session_id: sessionId, status: "cancelled" }`, aborts the AbortController, closes the WebSocket with code 1000, and deletes from the map.

2. `src/routes/websocket.js`:
   - Export `handleWebSocketRoute(request, env, ctx, url)`.
   - Route path format: `/ws/tasks/:session_id`.
   - Check `request.headers.get('Upgrade') === 'websocket'`. If not, return `errorResponse('Expected WebSocket upgrade', 426)`.
   - Authentication: Extract token from query parameter `?token=<access_token>` or `Authorization: Bearer <token>`.
     Validate using `verifyJwt(token, env.JWT_SECRET || DEFAULT_JWT_SECRET)` and check `payload.type === 'access'`.
     If missing or invalid, return HTTP 401 `errorResponse('Unauthorized', 401, 'unauthorized')`.
   - Session verification: Query D1 `sessions` table by `id = sessionId`.
     If not found or `session.user_id !== payload.sub`, return HTTP 404 `errorResponse('Session not found', 404, 'not_found')`.
   - Create native `const [client, server] = Object.values(new WebSocketPair())`.
   - Call `server.accept()`.
   - Create `abortController = new AbortController()`.
   - Register session into `wsRegistry`: `registerSession(sessionId, { ws: server, abortController, userId: payload.sub })`.
   - Send initial connected message: `server.send(JSON.stringify({ event: 'connected', session_id: sessionId, status: 'running' }))`.
   - Add event listeners on `server`:
     - `message`: Parse JSON.
       If `event === 'ping'`, reply `server.send(JSON.stringify({ event: 'pong', timestamp: new Date().toISOString() }))`.
       If `event === 'cancel'`, trigger task cancellation (update D1 status to `'cancelled'`, send cancelled event, abort, close).
     - `close` & `error`: Clean up session from `wsRegistry`, abort controller.
   - Start background mock log streaming via `ctx.waitUntil(streamMockLogs(sessionId, payload.sub, server, env, abortController.signal))`:
     - Define sequential mock steps (e.g. 5 steps: "Initializing screen capture", "Analyzing UI hierarchy", "Tapping target element", "Verifying UI transition", "Task completed successfully").
     - Delay ~400ms between steps (abortable with `signal`).
     - Check if signal aborted or session cancelled in D1 before each step.
     - Persist each step into `task_steps` (generate UUID v4, step_no, action_type, log_message, is_risky, verified_changed, created_at) and increment `sessions.step_count` via `env.DB.batch(...)`.
     - Send `{ event: 'log', session_id: sessionId, step_no, log_message, timestamp, is_risky, action_type }` over `server`.
     - If all steps complete without cancellation: update `sessions` table setting `status = 'completed', ended_at = ?`, send `{ event: 'finished', session_id: sessionId, status: 'completed', total_steps }`, and close socket cleanly (code 1000).
   - Return `new Response(null, { status: 101, webSocket: client })`.

3. `src/worker.js`:
   - Pass `ctx` into route handlers: `handleTasksRoute(request, env, ctx, url, method)` and `handleWebSocketRoute(request, env, ctx, url)`.
   - Intercept `/ws/tasks` or `/ws/tasks/`: dispatch to `handleWebSocketRoute`.

4. `src/routes/tasks.js`:
   - Update `handleCancelTask`: After updating D1 `sessions SET status = 'cancelled', ended_at = ? WHERE id = ? AND user_id = ?`, call `cancelActiveSession(sessionId)` from `wsRegistry.js` to push cancellation frame and cleanly close the active socket immediately.
   - Ensure `POST /api/tasks/start` and `GET /api/tasks/:session_id/status` conform cleanly to the spec.

5. `API_DOCUMENTATION.md`:
   - Update documentation with the exact WebSocket `/ws/tasks/:session_id` query param auth, events format, ping/pong, and cancellation behavior for Android client developers.

VERIFICATION:
- Test that syntax is clean and code builds cleanly.
- Run `npm test` or existing test suites (`node test_phase1.js`, `node test_phase2.js`) to ensure zero regressions on existing endpoints.
- Document all work and verification commands in `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\teamwork\worker_1\handoff.md`.
