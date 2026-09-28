# Dispatch: Survey Explorer 3 - Web Crypto Auth, API Endpoints, & Verification Strategy

## Mission
Analyze and specify the Web Crypto authentication system, JWT token generation/verification middleware, endpoint schemas, and automated verification suite for Hollis Backend Phase 1.

## Scope & Boundaries
- Working Directory: `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_3`
- Read:
  - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\ORIGINAL_REQUEST.md`
- Do NOT write or modify any source code files. This is a read-only investigation.

## Required Analysis & Deliverables
1. Web Crypto API implementation details for Cloudflare Workers edge environment:
   - Password hashing and verification using PBKDF2 with salt + SHA-256 (no native Node.js crypto binaries). Format for storing salt + hash.
   - JWT token generation and verification using Web Crypto (HMAC SHA-256 / HS256). Payload structure (claims: `sub` / `user_id`, `email`, `iat`, `exp`), secret management.
   - Refresh token generation / handling.
2. Endpoint API specifications:
   - `POST /api/auth/register`: request body, validation, duplicate check, default `user_settings` creation, response (HTTP 201).
   - `POST /api/auth/login`: request body, credential verification, response (HTTP 200 vs HTTP 401).
   - `POST /api/auth/verify-token`: request body / header, response (`{ valid: true, user_id: "..." }` vs `{ valid: false }`).
   - `POST /api/auth/logout`: client logout confirmation.
   - `GET /api/users/me`: protected by JWT middleware, returns user profile + settings (HTTP 200 vs 401).
   - `PUT /api/users/settings`: protected by JWT middleware, updates `confirmation_mode` and `max_step_limit`, returns updated object.
3. Verification Suite design:
   - Architecture of automated test runner script (`test_phase1.js` or TypeScript equivalent).
   - Execution against `wrangler dev` (local port, local D1).
   - Test case coverage: Happy paths, error cases, duplicate registration, invalid tokens, invalid passwords, unauthorized access, setting updates.
4. Write your complete findings to:
   - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_3\analysis.md`
   - `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_3\handoff.md`
5. Send completion message back to orchestrator.

## 2026-09-07T14:27:23Z
Read c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\ORIGINAL_REQUEST.md and c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_3\DISPATCH.md.
Analyze and specify the Web Crypto authentication, JWT middleware, endpoint schemas (/api/auth/* and /api/users/*), and automated verification suite architecture for Hollis Backend Phase 1.
Write your detailed analysis to c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_3\analysis.md and a structured handoff to c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_3\handoff.md.
When finished, send a completion message to the orchestrator via send_message.
