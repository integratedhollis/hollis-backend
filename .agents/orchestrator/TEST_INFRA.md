# E2E Test Infra: Hollis Backend Phase 1

## Test Philosophy
- Opaque-box, requirement-driven per `ORIGINAL_REQUEST.md`.
- Verifies endpoints externally against HTTP interface (`http://127.0.0.1:8787`).
- Methodology: Category-Partition + Boundary Value Analysis + Pairwise + Real-world scenarios.

## Feature Inventory & Test Coverage
| # | Feature | Source | Tier 1 (Happy) | Tier 2 (Boundary/Edge) | Tier 3 (Cross-feature) | Tier 4 (Workload) |
|---|---------|--------|:---:|:---:|:---:|:---:|
| 1 | D1 Migration & Schema | ORIGINAL_REQUEST § R1 | 1 | 1 | 1 | 1 |
| 2 | POST /api/auth/register | ORIGINAL_REQUEST § R2 | 2 | 3 | 2 | 1 |
| 3 | POST /api/auth/login | ORIGINAL_REQUEST § R2 | 2 | 3 | 2 | 1 |
| 4 | POST /api/auth/verify-token | ORIGINAL_REQUEST § R2 | 2 | 3 | 2 | 1 |
| 5 | POST /api/auth/logout | ORIGINAL_REQUEST § R2 | 1 | 1 | 1 | 1 |
| 6 | GET /api/users/me | ORIGINAL_REQUEST § R3 | 2 | 2 | 2 | 1 |
| 7 | PUT /api/users/settings | ORIGINAL_REQUEST § R3 | 2 | 3 | 2 | 1 |

## Test Architecture
- **Runner**: Node.js script `test_phase1.js` executing native `fetch`.
- **Target**: Local Wrangler dev instance running on port 8787 with local D1 SQLite.
- **Pass/Fail Semantics**: Each test case logs `[PASS]` or `[FAIL]`. Process exits code 0 if all tests pass, code 1 on any failure.
- **Tiers**:
  - **Tier 1 - Feature Coverage**:
    - TC-01: Valid user registration (returns 201 + user_id + access_token)
    - TC-02: Valid user login (returns 200 + access_token + refresh_token)
    - TC-03: Valid token verification via body (returns 200 + valid: true + user_id)
    - TC-04: Get user profile & default settings (returns 200 + popup mode + max_step_limit 20)
    - TC-05: Update settings to 'push' mode and max_step_limit 50 (returns 200 + updated settings)
    - TC-06: User logout confirmation (returns 200)
  - **Tier 2 - Boundary & Corner Cases**:
    - TC-07: Duplicate email registration returns 400 Bad Request
    - TC-08: Case-insensitive email duplicate check (e.g. `USER@Example.COM` vs `user@example.com`)
    - TC-09: Register with invalid email format returns 400
    - TC-10: Register with short password (< 8 chars) returns 400
    - TC-11: Register with missing fields returns 400
    - TC-12: Login with wrong password returns 401 Unauthorized
    - TC-13: Login with non-existent email returns 401 Unauthorized
    - TC-14: Verify invalid / malformed token returns valid: false
    - TC-15: Verify expired token returns valid: false
    - TC-16: Verify token via Authorization Bearer header returns valid: true
    - TC-17: Update settings with invalid confirmation_mode (e.g. 'sms') returns 400
    - TC-18: Update settings with negative/zero max_step_limit returns 400
    - TC-19: Update settings with empty payload returns 400
  - **Tier 3 - Cross-Feature & Security Combinations**:
    - TC-20: Access protected GET /api/users/me without Authorization header returns 401
    - TC-21: Access protected GET /api/users/me with invalid token returns 401
    - TC-22: Access protected PUT /api/users/settings without token returns 401
    - TC-23: Settings persistence: Verify GET /api/users/me reflects settings updated by PUT /api/users/settings
  - **Tier 4 - Real-World End-to-End Application Scenario**:
    - TC-24: Android Full Lifecycle Flow: Register user -> Verify Splash Token -> Fetch Settings -> Update Settings -> Re-login -> Verify Persistence.
