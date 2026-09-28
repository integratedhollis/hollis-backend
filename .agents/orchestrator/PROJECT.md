# Project: Hollis Backend Phase 1

## Architecture
- **Runtime**: Cloudflare Workers Edge Environment (V8 isolates), ES modules (`src/worker.js`).
- **Database**: Cloudflare D1 SQLite Database (`binding: "DB"`, `database_name: "hollis-db"`).
- **Security & Cryptography**: Native Web Crypto API (`crypto.subtle`) for:
  - Password hashing & verification: PBKDF2 with SHA-256, 100,000 iterations, 16-byte random salt, 32-byte derived key, constant-time verification. Format: `pbkdf2_sha256:100000:<salt_hex>:<hash_hex>`.
  - JWT generation & verification: HMAC-SHA256 (`HS256`) tokens with pure Web API Base64URL encoding (`btoa`, `atob`, `TextEncoder`, `TextDecoder`) without Node `Buffer`.
- **Modularity**: Zero external runtime npm dependencies for Phase 1. Pure standard Web APIs (`fetch`, `Request`, `Response`, `Headers`, `crypto`).

## Feature Inventory
| # | Feature | Description | Milestone | Status | Source |
|---|---------|-------------|-----------|--------|--------|
| 1 | D1 Configuration | Add `d1_databases` array with binding `DB`, database `hollis-db`, migrations dir `migrations` in `wrangler.jsonc` | M1 | DONE | ORIGINAL_REQUEST.md § R1 |
| 2 | Core Tables DDL | SQL migration file `migrations/0001_initial_schema.sql` defining `users`, `user_settings`, `sessions`, `task_steps`, `risk_confirmations` | M1 | DONE | ORIGINAL_REQUEST.md § R1 |
| 3 | SQLite Data Constraints | Application-layer UUID v4 (`crypto.randomUUID()`), INTEGER (0/1) for booleans, ISO 8601 TEXT timestamps, foreign keys with `ON DELETE CASCADE`, check constraints | M1 | DONE | ORIGINAL_REQUEST.md § R1 |
| 4 | Web Crypto Password Hashing | PBKDF2-SHA256 with 100,000 iterations, 16-byte random salt, constant-time verification | M2 | DONE | ORIGINAL_REQUEST.md § R2 |
| 5 | Web Crypto JWT Generation | HMAC-SHA256 (HS256) signing/verification, access token (1h) & refresh token (7d) | M2 | DONE | ORIGINAL_REQUEST.md § R2 |
| 6 | JWT Bearer Middleware | Authorization header extraction, signature verification, expiration check, user context injection | M2 | DONE | ORIGINAL_REQUEST.md § R2 |
| 7 | Response & Validation Helpers | Standardized JSON response helpers (`jsonResponse`, `errorResponse`), UUID and email validation | M2 | DONE | ORIGINAL_REQUEST.md § R2, R3 |
| 8 | POST /api/auth/register | Input validation, duplicate email check, PBKDF2 hash, atomic D1 batch insert (`users` + `user_settings`), returns 201 with `user_id` and `access_token` | M3 | DONE | ORIGINAL_REQUEST.md § R2 |
| 9 | POST /api/auth/login | Validates credentials against D1, returns 200 with `access_token` and `refresh_token`, or 401 | M3 | DONE | ORIGINAL_REQUEST.md § R2 |
| 10 | POST /api/auth/verify-token | Accepts token in body or header, returns 200 with `{ valid: true, user_id }` or `{ valid: false }` | M3 | DONE | ORIGINAL_REQUEST.md § R2 |
| 11 | POST /api/auth/logout | Client logout confirmation, returns 200 with success confirmation | M3 | DONE | ORIGINAL_REQUEST.md § R2 |
| 12 | GET /api/users/me | Protected by JWT middleware, queries D1 for user profile and current settings, returns 200 or 401 | M3 | DONE | ORIGINAL_REQUEST.md § R3 |
| 13 | PUT /api/users/settings | Protected by JWT middleware, validates `confirmation_mode` and `max_step_limit`, updates D1, returns 200 or 400/401 | M3 | DONE | ORIGINAL_REQUEST.md § R3 |
| 14 | Worker Router & Entry Point | Modular URL pathname dispatching in `src/worker.js`, CORS headers, error handling | M3 | DONE | ORIGINAL_REQUEST.md § R2, R3 |
| 15 | Automated Verification Suite | Standalone test script (`test_phase1.js`) covering 24 test cases across 4 tiers against `wrangler dev` | M4 | DONE | ORIGINAL_REQUEST.md § R4 |
| 16 | Local Wrangler Dev Verification | Execute migrations against local D1 and run full verification suite | M5 | DONE | ORIGINAL_REQUEST.md § Acceptance |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M1 | Cloudflare D1 Schema & Migrations | `wrangler.jsonc`, `migrations/0001_initial_schema.sql` | None | DONE |
| M2 | Web Crypto Core & Auth Middleware | `src/auth/crypto.js`, `src/auth/jwt.js`, `src/auth/middleware.js`, `src/utils/response.js` | None | DONE |
| M3 | Auth & User Settings APIs & Router | `src/routes/auth.js`, `src/routes/users.js`, `src/worker.js`, `.dev.vars.example` | M1, M2 | DONE |
| M4 | Automated Verification Test Suite | `test_phase1.js` | None (opaque-box) | DONE |
| M5 | Final Wrangler Dev E2E Pass & Audit | Full verification against `wrangler dev` local D1 | M1, M2, M3, M4 | DONE |

## Code Layout
```
c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\
├── wrangler.jsonc
├── package.json
├── migrations\
│   └── 0001_initial_schema.sql
├── src\
│   ├── worker.js
│   ├── auth\
│   │   ├── crypto.js
│   │   ├── jwt.js
│   │   └── middleware.js
│   ├── routes\
│   │   ├── auth.js
│   │   └── users.js
│   └── utils\
│       └── response.js
├── test_phase1.js
├── .dev.vars.example
└── .dev.vars
```
