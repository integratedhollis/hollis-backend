# Dispatch: E2E Test Writer 1

## Mission
Write the comprehensive, standalone automated verification suite (`test_phase1.js`) for Hollis Backend Phase 1 per `ORIGINAL_REQUEST.md` and `TEST_INFRA.md`.

## Mandatory Reading
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\ORIGINAL_REQUEST.md`
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\orchestrator\TEST_INFRA.md`
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\orchestrator\PROJECT.md`

## File Ownership
- You exclusively own and may create/edit: `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\test_phase1.js`
- Your working directory: `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\test_writer_1`
- Do NOT edit any files in `src/` or `migrations/`.

## Mandatory Integrity Warning
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.

## Requirements
1. The test runner must be executable via Node.js: `cmd.exe /c "node test_phase1.js"` or `node test_phase1.js`.
2. Targets `http://127.0.0.1:8787` (local Wrangler dev server).
3. Uses pure standard Node.js (Node 24 native `fetch`, `crypto.randomUUID()`) with zero external test framework dependencies.
4. Implement all test cases across 4 tiers as specified in `TEST_INFRA.md`:
   - Tier 1: Feature Coverage (Register, Login, Token Verify, Get Profile/Settings, Update Settings, Logout).
   - Tier 2: Boundary & Corner Cases (Duplicate emails, case-insensitive duplicate check, invalid emails, short passwords, wrong passwords, non-existent user, malformed token, expired token, bearer header, invalid settings values, negative step limits).
   - Tier 3: Cross-Feature & Security (Unauthorized access without token returns 401, invalid token returns 401, persistence verification).
   - Tier 4: Real-World Scenario (Full Android lifecycle flow).
5. Output format: Clear readable log for each test (`[PASS] TC-XX: ...` or `[FAIL] TC-XX: ...`), summary statistics (total, passed, failed), exit code 0 if all pass, 1 if any fail.
6. Support optional command-line flag or environment variable for base URL (default `http://127.0.0.1:8787`).
7. Write your handoff to `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\test_writer_1\handoff.md` and report to orchestrator via `send_message`.

## 2026-09-07T14:35:51Z
Read c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\ORIGINAL_REQUEST.md and c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\test_writer_1\DISPATCH.md.
Implement the comprehensive standalone E2E automated test suite in test_phase1.js based on ORIGINAL_REQUEST.md and TEST_INFRA.md.
Ensure you test against http://127.0.0.1:8787 covering Tier 1, Tier 2, Tier 3, and Tier 4 test cases.
DO NOT CHEAT. All implementations must be genuine. DO NOT hardcode test results, create dummy/facade implementations, or circumvent the intended task. A teamwork_preview_auditor will independently verify your work. Integrity violations WILL be detected and your work WILL be rejected.
Write your complete handoff to c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\test_writer_1\handoff.md.
When finished, send a completion message to the orchestrator via send_message.
