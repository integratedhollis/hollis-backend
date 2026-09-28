# Dispatch: Implementation Worker 1

## Mission
Implement Phase 1 of Hollis Backend: Cloudflare D1 schema & migrations, Web Crypto auth & JWT middleware, user profile & settings APIs, and entry point routing.

## Mandatory Reading
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\ORIGINAL_REQUEST.md`
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\orchestrator\PROJECT.md`
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_1\analysis.md`
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_2\analysis.md`
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_3\analysis.md`

## File Ownership
- You exclusively own and may create/edit:
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\wrangler.jsonc`
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\migrations\0001_initial_schema.sql`
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\src\auth\crypto.js`
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\src\auth\jwt.js`
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\src\auth\middleware.js`
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\src\utils\response.js`
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\src\routes\auth.js`
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\src\routes\users.js`
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\src\worker.js`
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.dev.vars.example`
- Your working directory: `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\worker_1`
- Do NOT edit `test_phase1.js` (owned by Test Writer).

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Tasks & Deliverables
1. **D1 Config & Migration**:
   - Update `wrangler.jsonc` to set name to `"hollis-backend"` and add `d1_databases` array with `binding: "DB"`, `database_name: "hollis-db"`, `database_id: "00000000-0000-0000-0000-000000000001"`, `migrations_dir: "migrations"`.
   - Create `migrations/0001_initial_schema.sql` with all 5 core tables (`users`, `user_settings`, `sessions`, `task_steps`, `risk_confirmations`), constraints, and indexes per Explorer 2 analysis.
   - Run migration command via `cmd.exe /c "echo y | npx wrangler d1 migrations apply hollis-db --local"`.
2. **Web Crypto & Auth Middleware**:
   - Implement `src/auth/crypto.js`: PBKDF2 with SHA-256 (100,000 iterations, 16-byte random salt, constant-time verification).
   - Implement `src/auth/jwt.js`: HMAC-SHA256 (HS256) sign and verify with Web Crypto (`crypto.subtle`), pure Base64URL encoding/decoding without Node `Buffer`. Support access token and refresh token.
   - Implement `src/auth/middleware.js`: Bearer token extraction and authentication middleware.
   - Implement `src/utils/response.js`: JSON response and error response helpers.
3. **Route Handlers & Worker Entry Point**:
   - Implement `src/routes/auth.js`:
     - `POST /api/auth/register`: validation, email check, atomic D1 batch insert for `users` and `user_settings`, returns 201 + `user_id` + `access_token`.
     - `POST /api/auth/login`: verifies password, returns 200 + `access_token` + `refresh_token` + `user_id` or 401.
     - `POST /api/auth/verify-token`: accepts token in body or header, returns 200 with `{ valid: true, user_id }` or `{ valid: false }`.
     - `POST /api/auth/logout`: returns 200.
   - Implement `src/routes/users.js`:
     - `GET /api/users/me`: protected by auth middleware, joins user and settings, returns 200 or 401.
     - `PUT /api/users/settings`: protected by auth middleware, validates `confirmation_mode` and `max_step_limit`, updates D1, returns 200 with updated settings.
   - Implement `src/worker.js`: URL pathname routing, CORS support, error handling.
   - Create `.dev.vars.example` with `JWT_SECRET=your-secret-key-here-for-local-development`.
4. **Verification**:
   - Verify D1 migration executes cleanly with exit code 0.
   - Run local syntax/unit checks on all modules.
   - Write your handoff to `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\worker_1\handoff.md` and report to orchestrator via `send_message`.

## 2026-09-07T14:35:51Z
Read c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\ORIGINAL_REQUEST.md and c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\worker_1\DISPATCH.md.
Implement Phase 1 of Hollis Backend according to the specifications in:
- c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\orchestrator\PROJECT.md
- c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_1\analysis.md
- c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_2\analysis.md
- c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_3\analysis.md

DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

Tasks:
1. Update wrangler.jsonc with d1_databases binding "DB" and database_name "hollis-db".
2. Create migrations/0001_initial_schema.sql for the 5 core tables.
3. Apply migrations locally via cmd.exe /c "echo y | npx wrangler d1 migrations apply hollis-db --local".
4. Implement src/auth/crypto.js (PBKDF2-SHA256), src/auth/jwt.js (HMAC-SHA256), src/auth/middleware.js, src/utils/response.js.
5. Implement src/routes/auth.js, src/routes/users.js, src/worker.js, and .dev.vars.example.
6. Verify migrations and test build/syntax.
7. Write complete handoff to c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\worker_1\handoff.md.
When finished, send a completion message to the orchestrator via send_message.

## 2026-09-07T15:05:36Z
**Context**: Phase 1 Implementation status check
**Content**: Heartbeat check: Notice that all source files and migration files have been created. Please complete your verification tests, apply migrations locally, write your handoff report to handoff.md, and send completion message.
**Action**: Report current status and finish handoff report.
