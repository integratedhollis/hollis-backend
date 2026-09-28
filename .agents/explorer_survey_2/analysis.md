# Hollis Backend Phase 1 — Cloudflare D1 SQLite Schema & Migration Strategy Analysis

**Author**: Explorer Survey 2 (Specification Miner)  
**Date**: 2026-09-07  
**Working Directory**: `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_2`  
**Reference Specifications**:
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\ORIGINAL_REQUEST.md`
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\.agents\explorer_survey_2\DISPATCH.md`
- `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\wrangler.jsonc`
- Cloudflare Workers & D1 Documentation (SQLite Engine, Wrangler CLI)

---

## 1. Executive Summary

Phase 1 of the Hollis Backend establishes the core relational foundation for an AI-driven Android screen automation system. The database layer uses Cloudflare D1 (a distributed, serverless relational database built on SQLite).

This document provides:
1. Complete table schemas and constraints for all 5 core tables (`users`, `user_settings`, `sessions`, `task_steps`, `risk_confirmations`).
2. Exact SQLite data typing rules (UUID v4 in application layer, INTEGER 0/1 for booleans, ISO 8601 strings for timestamps).
3. Foreign key referential integrity rules and `ON DELETE CASCADE` behaviors.
4. Composite indexes optimized for Phase 1 authentication, session polling, and Android client risk-confirmation flows.
5. Migration file layout (`migrations/0001_initial_schema.sql`) and Wrangler D1 execution strategy.
6. Wrangler configuration (`wrangler.jsonc`) schema additions.

---

## 2. Specification Mining

### Features Discovered

| # | Category | Feature | Description | Inputs | Outputs | Error Behavior | Discovered Via |
|---|----------|---------|-------------|--------|---------|----------------|----------------|
| 1 | Table: Users | User Account Entity | Root identity table holding credentials and account timestamps | `id`, `username`, `email`, `password_hash`, `created_at` | Persisted row in `users` | `SQLITE_CONSTRAINT_UNIQUE` if email duplicated; `SQLITE_CONSTRAINT_NOTNULL` if required field missing | `ORIGINAL_REQUEST.md` R1.1, R2 |
| 2 | Table: Users | Case-Insensitive Email | Unique constraint on user email with case-insensitivity | Email string (e.g. `User@Domain.com`) | Normalized uniqueness check | Rejection of duplicate case variations (`user@domain.com`) | `ORIGINAL_REQUEST.md` R1.1, R2 (`POST /api/auth/register`) |
| 3 | Table: Settings | 1-to-1 User Settings | User configuration row automatically populated on registration | `id`, `user_id`, `confirmation_mode`, `max_step_limit`, `updated_at` | Persisted row in `user_settings` | `SQLITE_CONSTRAINT_FOREIGNKEY` if user_id invalid; `SQLITE_CONSTRAINT_UNIQUE` if user already has settings | `ORIGINAL_REQUEST.md` R1.2, R2, R3 |
| 4 | Table: Settings | Confirmation Mode Check | Limits confirmation modes to allowed values (`popup`, `push`, `none`) | String: `'popup'`, `'push'`, `'none'` | Allowed value stored | `SQLITE_CONSTRAINT_CHECK` if mode not in allowed set | `ORIGINAL_REQUEST.md` R1.2, R3 (`PUT /api/users/settings`) |
| 5 | Table: Settings | Step Limit Boundary Check | Enforces positive integer boundaries on maximum steps | Integer: `max_step_limit > 0` | Valid integer stored | `SQLITE_CONSTRAINT_CHECK` if limit <= 0 or invalid | `ORIGINAL_REQUEST.md` R1.2, R3 |
| 6 | Table: Sessions | Automation Session Entity | Tracks parent task execution initiated by an authenticated user | `id`, `user_id`, `instruction`, `status`, `step_count`, `started_at`, `ended_at` | Persisted row in `sessions` | `SQLITE_CONSTRAINT_FOREIGNKEY` if user_id non-existent | `ORIGINAL_REQUEST.md` R1.3 |
| 7 | Table: Sessions | Session Status Constraint | Restricts session states to lifecycle transitions | `'pending'`, `'running'`, `'completed'`, `'failed'`, `'cancelled'` | Status stored | `SQLITE_CONSTRAINT_CHECK` on invalid status | `ORIGINAL_REQUEST.md` R1.3 |
| 8 | Table: Steps | Task Step Log Entity | Granular action steps executed within an automation session | `id`, `session_id`, `step_no`, `action_type`, `log_message`, `is_risky`, `verified_changed`, `created_at` | Persisted row in `task_steps` | `SQLITE_CONSTRAINT_FOREIGNKEY` on missing session | `ORIGINAL_REQUEST.md` R1.4 |
| 9 | Table: Steps | Boolean Flags (0/1) | Represents `is_risky` and `verified_changed` as SQLite integers | Integer `0` or `1` | Stored `0` or `1` | `SQLITE_CONSTRAINT_CHECK` if value not in `(0, 1)` | `ORIGINAL_REQUEST.md` R1, DISPATCH.md §2 |
| 10 | Table: Steps | Step Sequence Uniqueness | Guarantees ordered, non-overlapping step numbers per session | Composite `(session_id, step_no)` | Unique constraint | `SQLITE_CONSTRAINT_UNIQUE` on duplicate step_no in session | System Design specification |
| 11 | Table: Risk | Risk Confirmation Entity | Tracks intercepted risky steps requiring explicit user clearance | `id`, `session_id`, `step_id`, `requested_mode`, `user_response`, `responded_at` | Persisted row in `risk_confirmations` | `SQLITE_CONSTRAINT_FOREIGNKEY` if session_id or step_id invalid | `ORIGINAL_REQUEST.md` R1.5 |
| 12 | Table: Risk | Risk Step 1-to-1 Guarantee | Enforces that each task step has at most one confirmation record | Unique `step_id` FK | Unique constraint | `SQLITE_CONSTRAINT_UNIQUE` if multiple confirmations logged for same step | `ORIGINAL_REQUEST.md` R1.5 |
| 13 | D1 Config | Wrangler D1 Binding | Cloudflare Worker D1 binding configuration in `wrangler.jsonc` | Binding `DB`, `database_name`, `database_id` | Environment binding `env.DB` | Worker startup error if D1 binding undefined | `wrangler.jsonc`, `ORIGINAL_REQUEST.md` R1 |
| 14 | Migration | D1 Migration Runner | Wrangler native migration CLI applying SQL schema migrations | Migration file `migrations/0001_initial_schema.sql` | `d1_migrations` table + schema | Migration aborts on SQL syntax error or failed pragma | `wrangler d1 migrations` CLI |
| 15 | Integrity | Cascade Deletions | Automatic cleanup of child rows when parent row is removed | `ON DELETE CASCADE` on foreign keys | Deletion propagated to dependent rows | Foreign key failure if child cannot be deleted | Relational integrity requirement |

---

## 3. Edge Cases & Constraints

| # | Feature | Input / Condition | Observed / Specified Behavior |
|---|---------|-------------------|-------------------------------|
| 1 | Users: Email Uniqueness | Mixed-case duplicate: `john.doe@example.com` then `John.Doe@Example.com` | `UNIQUE(email COLLATE NOCASE)` rejects second insert with `SQLITE_CONSTRAINT_UNIQUE`. Prevents account collision. |
| 2 | Users: Empty strings | `email = ""` or `password_hash = ""` | `CHECK (length(email) > 0)` and `NOT NULL` constraint trigger constraint violation before commit. |
| 3 | Settings: User Deletion | `DELETE FROM users WHERE id = 'usr_123'` | `ON DELETE CASCADE` automatically removes corresponding row in `user_settings`, preventing orphaned configurations. |
| 4 | Settings: Duplicate Settings | Inserting a second `user_settings` row for the same `user_id` | `UNIQUE(user_id)` constraint fails, maintaining strict 1:1 invariant between user and settings. |
| 5 | Settings: Invalid Mode | `confirmation_mode = 'sms'` | `CHECK (confirmation_mode IN ('popup', 'push', 'none'))` raises `SQLITE_CONSTRAINT_CHECK`. |
| 6 | Settings: Invalid Limit | `max_step_limit = 0` or `-5` | `CHECK (max_step_limit > 0)` raises `SQLITE_CONSTRAINT_CHECK`. |
| 7 | Sessions: Active Session | Newly started session has no end time | `ended_at TEXT NULL` allows `NULL` during active processing; populated with ISO 8601 when status becomes `'completed'` or `'failed'`. |
| 8 | Sessions: Orphan Prevention | Delete user with active sessions | `ON DELETE CASCADE` removes sessions, cascading to `task_steps` and `risk_confirmations`. |
| 9 | Task Steps: Invalid Boolean | `is_risky = 2` or `verified_changed = -1` | `CHECK (is_risky IN (0, 1))` triggers constraint failure. Only `0` or `1` allowed. |
| 10 | Task Steps: Duplicate Sequence | Inserting two steps with `session_id = 'sess_1'` and `step_no = 1` | `UNIQUE(session_id, step_no)` rejects duplicate step index. |
| 11 | Risk Confirmations: Unanswered | Awaiting user input | `user_response` and `responded_at` remain `NULL`. Allowed values when non-null: `'approved'`, `'rejected'`, `'timed_out'`. |
| 12 | Timestamps: Precision | Millisecond UTC timestamp: `2026-09-07T14:25:25.123Z` | Stored as `TEXT` in ISO 8601 format; preserves chronological sorting natively via lexicographical string comparison. |
| 13 | UUID: Format & Affinity | Standard 36-char string generated via `crypto.randomUUID()` | Stored as `TEXT PRIMARY KEY`. Avoids SQLite integer rowid collision and enables distributed ID generation at Worker edge. |

---

## 4. Complete Table Schema Specifications

### Table 1: `users`
- **Purpose**: Core identity store containing user credentials, email, and registration timestamp.
- **Columns**:
  - `id` `TEXT PRIMARY KEY NOT NULL`: RFC 4122 v4 UUID string (e.g., `36` characters).
  - `username` `TEXT NOT NULL`: Display name or handle.
  - `email` `TEXT NOT NULL UNIQUE COLLATE NOCASE`: User email address, unique across all accounts regardless of casing.
  - `password_hash` `TEXT NOT NULL`: Secure cryptographic hash string (PBKDF2-SHA256 with salt and iteration count).
  - `created_at` `TEXT NOT NULL`: ISO 8601 UTC timestamp string (e.g., `YYYY-MM-DDTHH:MM:SS.sssZ`).
- **Constraints**:
  - `PRIMARY KEY (id)`
  - `UNIQUE (email COLLATE NOCASE)`
  - `CHECK (length(id) > 0 AND length(email) > 0 AND length(password_hash) > 0)`

### Table 2: `user_settings`
- **Purpose**: Stores per-user operational preferences for the Hollis Android automation agent.
- **Columns**:
  - `id` `TEXT PRIMARY KEY NOT NULL`: RFC 4122 v4 UUID string.
  - `user_id` `TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE`: Foreign key link to `users(id)`. Exactly one settings row per user.
  - `confirmation_mode` `TEXT NOT NULL DEFAULT 'popup'`: Mode for risky step verification. Must be one of `'popup'`, `'push'`, or `'none'`.
  - `max_step_limit` `INTEGER NOT NULL DEFAULT 20`: Safety upper bound on execution steps per session.
  - `updated_at` `TEXT NOT NULL`: ISO 8601 UTC timestamp string when settings were last modified.
- **Constraints**:
  - `PRIMARY KEY (id)`
  - `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`
  - `UNIQUE (user_id)`
  - `CHECK (confirmation_mode IN ('popup', 'push', 'none'))`
  - `CHECK (max_step_limit > 0 AND max_step_limit <= 1000)`

### Table 3: `sessions`
- **Purpose**: Represents an automation run/task initiated by a user.
- **Columns**:
  - `id` `TEXT PRIMARY KEY NOT NULL`: RFC 4122 v4 UUID string.
  - `user_id` `TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE`: Foreign key to `users(id)`.
  - `instruction` `TEXT NOT NULL`: Natural language automation directive provided by user.
  - `status` `TEXT NOT NULL DEFAULT 'pending'`: Execution state. Must be one of `'pending'`, `'running'`, `'completed'`, `'failed'`, `'cancelled'`.
  - `step_count` `INTEGER NOT NULL DEFAULT 0`: Number of steps executed so far.
  - `started_at` `TEXT NOT NULL`: ISO 8601 UTC timestamp when session was initialized.
  - `ended_at` `TEXT NULL`: ISO 8601 UTC timestamp when session terminated; NULL while active.
- **Constraints**:
  - `PRIMARY KEY (id)`
  - `FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE`
  - `CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled'))`
  - `CHECK (step_count >= 0)`

### Table 4: `task_steps`
- **Purpose**: Detailed step execution log within a session, including risk assessment and UI state verification.
- **Columns**:
  - `id` `TEXT PRIMARY KEY NOT NULL`: RFC 4122 v4 UUID string.
  - `session_id` `TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`: Foreign key to `sessions(id)`.
  - `step_no` `INTEGER NOT NULL`: Step counter sequence (1, 2, 3...).
  - `action_type` `TEXT NOT NULL`: Type of action performed (e.g., `'tap'`, `'swipe'`, `'type'`, `'key_event'`, `'wait'`).
  - `log_message` `TEXT NULL`: Diagnostic log or model thought message.
  - `is_risky` `INTEGER NOT NULL DEFAULT 0`: Boolean flag (0 = safe, 1 = risky/requires confirmation).
  - `verified_changed` `INTEGER NOT NULL DEFAULT 0`: Boolean flag (0 = unverified, 1 = verified screen state changed).
  - `created_at` `TEXT NOT NULL`: ISO 8601 UTC timestamp when step was recorded.
- **Constraints**:
  - `PRIMARY KEY (id)`
  - `FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE`
  - `UNIQUE (session_id, step_no)`
  - `CHECK (step_no >= 0)`
  - `CHECK (is_risky IN (0, 1))`
  - `CHECK (verified_changed IN (0, 1))`

### Table 5: `risk_confirmations`
- **Purpose**: Intercepts risky actions and logs explicit user approval/rejection before screen execution resumes.
- **Columns**:
  - `id` `TEXT PRIMARY KEY NOT NULL`: RFC 4122 v4 UUID string.
  - `session_id` `TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE`: Foreign key to `sessions(id)`.
  - `step_id` `TEXT NOT NULL UNIQUE REFERENCES task_steps(id) ON DELETE CASCADE`: Foreign key to `task_steps(id)`. Each step has at most 1 confirmation record.
  - `requested_mode` `TEXT NOT NULL`: Mode requested (`'popup'` or `'push'`).
  - `user_response` `TEXT NULL`: Outcome (`'approved'`, `'rejected'`, `'timed_out'`), NULL while awaiting response.
  - `responded_at` `TEXT NULL`: ISO 8601 UTC timestamp of user decision; NULL while awaiting response.
- **Constraints**:
  - `PRIMARY KEY (id)`
  - `FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE`
  - `FOREIGN KEY (step_id) REFERENCES task_steps(id) ON DELETE CASCADE`
  - `UNIQUE (step_id)`
  - `CHECK (requested_mode IN ('popup', 'push'))`
  - `CHECK (user_response IS NULL OR user_response IN ('approved', 'rejected', 'timed_out'))`

---

## 5. Indexing & Query Optimization Strategy

To ensure sub-millisecond query latency across the Workers edge runtime:

1. **`users`**:
   - `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE);`
   - *Rationale*: Powers `POST /api/auth/login` and duplicate checks in `POST /api/auth/register`.
2. **`user_settings`**:
   - `CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);`
   - *Rationale*: Powers `GET /api/users/me` and `PUT /api/users/settings`. (Also backed by `UNIQUE` constraint).
3. **`sessions`**:
   - `CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);`
   - `CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);`
   - `CREATE INDEX IF NOT EXISTS idx_sessions_user_created ON sessions(user_id, started_at DESC);`
   - *Rationale*: Fast retrieval of a user's recent sessions and filtering by execution status.
4. **`task_steps`**:
   - `CREATE INDEX IF NOT EXISTS idx_task_steps_session_step ON task_steps(session_id, step_no ASC);`
   - `CREATE INDEX IF NOT EXISTS idx_task_steps_session_risky ON task_steps(session_id, is_risky);`
   - *Rationale*: Fast step replay and rapid detection of risky steps during automation runs.
5. **`risk_confirmations`**:
   - `CREATE INDEX IF NOT EXISTS idx_risk_confirmations_session ON risk_confirmations(session_id);`
   - `CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_confirmations_step ON risk_confirmations(step_id);`
   - *Rationale*: Immediate lookup of pending confirmations for an active session and Android UI polling.

---

## 6. Authoritative SQL Migration File (`migrations/0001_initial_schema.sql`)

The migration file must be saved to `migrations/0001_initial_schema.sql`:

```sql
-- Hollis Backend Phase 1 Initial Schema Migration
-- Migration: 0001_initial_schema.sql
-- Target Engine: Cloudflare D1 (SQLite)

-- 1. Users Table
CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY NOT NULL,
    username TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (length(id) > 0 AND length(email) > 0 AND length(password_hash) > 0)
);

-- 2. User Settings Table (1:1 with users)
CREATE TABLE IF NOT EXISTS user_settings (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL UNIQUE,
    confirmation_mode TEXT NOT NULL DEFAULT 'popup',
    max_step_limit INTEGER NOT NULL DEFAULT 20,
    updated_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (confirmation_mode IN ('popup', 'push', 'none')),
    CHECK (max_step_limit > 0 AND max_step_limit <= 1000)
);

-- 3. Sessions Table
CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY NOT NULL,
    user_id TEXT NOT NULL,
    instruction TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    step_count INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled')),
    CHECK (step_count >= 0)
);

-- 4. Task Steps Table
CREATE TABLE IF NOT EXISTS task_steps (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    step_no INTEGER NOT NULL,
    action_type TEXT NOT NULL,
    log_message TEXT,
    is_risky INTEGER NOT NULL DEFAULT 0,
    verified_changed INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    UNIQUE (session_id, step_no),
    CHECK (step_no >= 0),
    CHECK (is_risky IN (0, 1)),
    CHECK (verified_changed IN (0, 1))
);

-- 5. Risk Confirmations Table
CREATE TABLE IF NOT EXISTS risk_confirmations (
    id TEXT PRIMARY KEY NOT NULL,
    session_id TEXT NOT NULL,
    step_id TEXT NOT NULL UNIQUE,
    requested_mode TEXT NOT NULL,
    user_response TEXT,
    responded_at TEXT,
    FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
    FOREIGN KEY (step_id) REFERENCES task_steps(id) ON DELETE CASCADE,
    CHECK (requested_mode IN ('popup', 'push')),
    CHECK (user_response IS NULL OR user_response IN ('approved', 'rejected', 'timed_out'))
);

-- 6. Performance Indexes
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE);
CREATE UNIQUE INDEX IF NOT EXISTS idx_user_settings_user_id ON user_settings(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_sessions_user_created ON sessions(user_id, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_steps_session_step ON task_steps(session_id, step_no ASC);
CREATE INDEX IF NOT EXISTS idx_task_steps_session_risky ON task_steps(session_id, is_risky);
CREATE INDEX IF NOT EXISTS idx_risk_confirmations_session ON risk_confirmations(session_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_confirmations_step ON risk_confirmations(step_id);
```

---

## 7. Cloudflare D1 Configuration in `wrangler.jsonc`

In `c:\Users\ASUS\OneDrive\Documents\GitHub\hollis-backend\wrangler.jsonc`, the `d1_databases` array must be added.

### Proposed `wrangler.jsonc` Update:
```jsonc
{
  "name": "hollis-backend",
  "main": "src/worker.js",
  "workers_dev": true,
  "preview_urls": false,
  "compatibility_date": "2026-09-07",
  "observability": {
    "enabled": true,
    "head_sampling_rate": 1,
    "redact_query_string": false,
    "logs": {
      "enabled": true,
      "head_sampling_rate": 1,
      "persist": true,
      "invocation_logs": true
    },
    "traces": {
      "enabled": false,
      "head_sampling_rate": 1
    }
  },
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "hollis-db",
      "database_id": "00000000-0000-0000-0000-000000000000",
      "migrations_dir": "migrations"
    }
  ]
}
```

- **Binding Name**: `"DB"` — accessed inside Worker handlers as `env.DB`.
- **Database Name**: `"hollis-db"`.
- **Database ID**: For local development (`--local`), Wrangler automatically uses an isolated local SQLite file inside `.wrangler/state/v3/d1/miniflare-D1DatabaseObject/...` without contacting Cloudflare servers. When deploying remotely, `wrangler d1 create hollis-db` will issue a real UUID.
- **Migrations Directory**: `"migrations"` at the repository root.

---

## 8. Migration Execution & Tooling Strategy

### 1. Running Migrations Locally
To apply the migration against the local D1 instance used by `wrangler dev`:
```bash
npx wrangler d1 migrations apply hollis-db --local
```
*(Alternatively: `npx wrangler d1 migrations apply DB --local`)*

### 2. Windows Environment Considerations
On Windows PowerShell, npm scripts might be blocked by execution policies. Commands should be run via:
- `npm run migrate:local` with script defined in `package.json`:
  ```json
  "scripts": {
    "migrate:local": "wrangler d1 migrations apply hollis-db --local",
    "migrate:list": "wrangler d1 migrations list hollis-db --local"
  }
  ```
- Or invoked through `cmd /c "npx wrangler d1 migrations apply hollis-db --local"`.

### 3. Application-Layer Foreign Key & Transaction Handling
- **Foreign Keys**: In SQLite, foreign key validation must be active. Cloudflare D1 enables foreign key checks, but developers can prepend `PRAGMA foreign_keys = ON;` if running standalone or batch queries.
- **Batching & Atomicity**: Cloudflare D1 provides `env.DB.batch([ ... ])` which executes multiple prepared statements in a single atomic transaction. In `POST /api/auth/register`, inserting the `users` row and the default `user_settings` row MUST be wrapped in `env.DB.batch()` to prevent partial registrations:
  ```javascript
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, username, email, password_hash, created_at) VALUES (?, ?, ?, ?, ?)")
      .bind(userId, username, email, passwordHash, now),
    env.DB.prepare("INSERT INTO user_settings (id, user_id, confirmation_mode, max_step_limit, updated_at) VALUES (?, ?, 'popup', 20, ?)")
      .bind(crypto.randomUUID(), userId, now)
  ]);
  ```
- **UUID Generation**: All IDs MUST be generated using `crypto.randomUUID()` in Worker code prior to execution.

---

## 9. Conclusion & Next Steps
This specification provides an authoritative, complete, production-ready schema and migration architecture tailored precisely to the Cloudflare Workers / D1 SQLite runtime. The implementation engineers (Phase 1 builders) can implement `migrations/0001_initial_schema.sql` and update `wrangler.jsonc` directly from this specification with zero guesswork.
