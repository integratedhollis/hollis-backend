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
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'stopped_loop', 'stopped_limit')),
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
    CHECK (user_response IS NULL OR user_response IN ('approved', 'rejected', 'timed_out', 'timeout'))
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
