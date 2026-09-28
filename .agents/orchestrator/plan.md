# Hollis Backend Phase 1 Execution Plan

## Objective
Implement Phase 1 of Hollis Backend: Cloudflare D1 Database Schema, Authentication & User Settings API, and Automated Verification Suite per `ORIGINAL_REQUEST.md`.

## Phased Approach (Project Pattern with Dual Track)

### Phase 0: Survey & Initial Specification
- Spawn 3 parallel Explorers:
  - **Explorer 1 (Codebase & Wrangler Environment)**: Inspect current directory files (`package.json`, `wrangler.jsonc`, `src/`), verify runtime setup (Cloudflare Workers, D1 binding format, TypeScript/JavaScript config, dependencies).
  - **Explorer 2 (D1 Schema & Data Modeling)**: Analyze the 5 required tables, column types, SQLite constraints, foreign keys, indexing, and migration numbering convention for Cloudflare D1.
  - **Explorer 3 (Web Crypto Auth & API Contracts)**: Analyze Web Crypto PBKDF2/SHA-256 password hashing & verification, standard JWT generation/verification (HMAC SHA-256 with Web Crypto) without Node native modules, and endpoint schemas for `/api/auth/*` and `/api/users/*`.
- Synthesize survey findings into `PROJECT.md` and `TEST_INFRA.md`.

### Phase 1: Dual Track Decomposition & Setup
- **Implementation Track**:
  - **Milestone 1**: Cloudflare D1 SQLite Schema & Migrations (`migrations/0001_initial_schema.sql`, `wrangler.jsonc` config).
  - **Milestone 2**: Core Utilities & Security (Web Crypto password hasher, JWT token generator & verifier middleware, UUID generation, response helpers).
  - **Milestone 3**: Authentication & User Settings APIs (`POST /api/auth/register`, `POST /api/auth/login`, `POST /api/auth/verify-token`, `POST /api/auth/logout`, `GET /api/users/me`, `PUT /api/users/settings`, routing in Worker entry point).
- **E2E Testing Track**:
  - Design opaque-box test runner (`test_phase1.js` or TypeScript equivalent) covering Tiers 1-4 (minimum 11*N test cases + edge cases).
  - Verify against local Wrangler dev environment (`wrangler dev` + local D1).
  - Publish `TEST_READY.md`.

### Phase 2: Execution & Verification Loop per Milestone
- For each implementation milestone:
  1. Spawn Explorer to investigate exact changes and interface contracts.
  2. Spawn Worker to implement changes, run unit tests/build commands, and report.
  3. Spawn 2 Reviewers independently (code quality, edge cases, specs compliance).
  4. Spawn 2 Challengers to generate tests and stress edge cases.
  5. Spawn Forensic Auditor (`teamwork_preview_auditor`) for integrity verification.
  6. Gate check: strict AND of all criteria.

### Phase 3: Final E2E Integration & Verification
- Run full automated verification suite against `wrangler dev` with local D1.
- Verify 100% test pass rate across all tiers and edge cases.
- Final forensic audit across entire codebase.
- Report completion and results to Sentinel.
