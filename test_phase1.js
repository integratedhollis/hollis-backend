/**
 * Hollis Backend Phase 1 - Comprehensive Standalone E2E Test Suite
 * 
 * Target: Cloudflare Workers Local Dev Server (default: http://127.0.0.1:8787)
 * Runtime: Pure Node.js (v18/20/22/24+ native fetch & Web Crypto, zero external test dependencies)
 * Coverage: 24 Test Cases across Tiers 1 to 4 per ORIGINAL_REQUEST.md & TEST_INFRA.md
 * 
 * Usage:
 *   node test_phase1.js
 *   node test_phase1.js --url http://127.0.0.1:8787
 *   cmd.exe /c "node test_phase1.js"
 */

'use strict';

// ============================================================================
// CLI & Configuration
// ============================================================================

let baseUrl = process.env.BASE_URL || 'http://127.0.0.1:8787';

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg.startsWith('--url=')) {
    baseUrl = arg.substring(6);
  } else if (arg === '--url' && i + 1 < process.argv.length) {
    baseUrl = process.argv[++i];
  } else if (arg.startsWith('http://') || arg.startsWith('https://')) {
    baseUrl = arg;
  } else if (arg === '--help' || arg === '-h') {
    console.log(`
Hollis Backend Phase 1 Automated Test Suite
Usage:
  node test_phase1.js [options] [baseUrl]

Options:
  --url <url>     Target base URL (default: http://127.0.0.1:8787)
  -h, --help      Show this help message

Environment Variables:
  BASE_URL        Target base URL
`);
    process.exit(0);
  }
}

baseUrl = baseUrl.replace(/\/+$/, '');

// ============================================================================
// Terminal Styling & Colors
// ============================================================================

const isColorSupported = !process.env.NO_COLOR && (process.stdout.isTTY || process.env.TERM);

const colors = {
  reset: isColorSupported ? '\x1b[0m' : '',
  bold: isColorSupported ? '\x1b[1m' : '',
  dim: isColorSupported ? '\x1b[2m' : '',
  red: isColorSupported ? '\x1b[31m' : '',
  green: isColorSupported ? '\x1b[32m' : '',
  yellow: isColorSupported ? '\x1b[33m' : '',
  cyan: isColorSupported ? '\x1b[36m' : '',
  gray: isColorSupported ? '\x1b[90m' : '',
};

// ============================================================================
// UUID & Cryptographic Helpers
// ============================================================================

function generateUUID() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const nodeCrypto = require('node:crypto');
    if (typeof nodeCrypto.randomUUID === 'function') {
      return nodeCrypto.randomUUID();
    }
  } catch (_) {}
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function base64UrlEncode(str) {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(str, 'utf8').toString('base64url');
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function isValidJwtFormat(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  return parts.length === 3 && parts.every(part => part.length > 0);
}

// ============================================================================
// HTTP Request Helper
// ============================================================================

async function apiRequest(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const headers = {
    'Accept': 'application/json',
    ...(options.headers || {}),
  };

  let body = options.body;
  const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
  const isSearchParams = typeof URLSearchParams !== 'undefined' && body instanceof URLSearchParams;
  if (body && typeof body === 'object' && !isFormData && !isSearchParams) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }

  const start = Date.now();
  let response;
  try {
    response = await fetch(url, {
      method: options.method || 'GET',
      headers,
      body,
      signal: options.signal || AbortSignal.timeout(10000),
    });
  } catch (err) {
    const durationMs = Date.now() - start;
    throw new Error(`HTTP Request Failed (${options.method || 'GET'} ${url}) after ${durationMs}ms: ${err.message}`);
  }

  const durationMs = Date.now() - start;
  const rawText = await response.text();
  let jsonBody = null;
  try {
    jsonBody = JSON.parse(rawText);
  } catch (_) {
    jsonBody = null;
  }

  return {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
    body: jsonBody,
    rawText,
    durationMs,
  };
}

// ============================================================================
// Assertion Utilities
// ============================================================================

class AssertionError extends Error {
  constructor(message, actual, expected) {
    super(message);
    this.name = 'AssertionError';
    this.actual = actual;
    this.expected = expected;
  }
}

function assert(condition, message, actual, expected) {
  if (!condition) {
    throw new AssertionError(message || 'Assertion failed', actual, expected);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new AssertionError(
      `${message ? message + ' - ' : ''}Expected ${JSON.stringify(expected)}, received ${JSON.stringify(actual)}`,
      actual,
      expected
    );
  }
}

function assertStatus(res, expectedStatus, message) {
  if (res.status !== expectedStatus) {
    const errorDetail = res.body && (res.body.error || res.body.message) 
      ? ` | Server response: ${JSON.stringify(res.body)}` 
      : ` | Raw body: ${res.rawText.slice(0, 150)}`;
    throw new AssertionError(
      `${message ? message + ' - ' : ''}Expected HTTP ${expectedStatus}, got ${res.status}${errorDetail}`,
      res.status,
      expectedStatus
    );
  }
}

function assertTruthy(val, message) {
  if (!val) {
    throw new AssertionError(`${message ? message + ' - ' : ''}Expected truthy value, got ${JSON.stringify(val)}`, val, true);
  }
}

// ============================================================================
// Test Runner Engine
// ============================================================================

const testResults = [];
let passedCount = 0;
let failedCount = 0;

async function runTest(tcId, description, testFn) {
  const startTime = Date.now();
  try {
    await testFn();
    const duration = Date.now() - startTime;
    passedCount++;
    testResults.push({ id: tcId, description, passed: true, duration });
    console.log(
      `  ${colors.green}[PASS]${colors.reset} ${colors.bold}${tcId}${colors.reset}: ${description} ${colors.dim}(${duration}ms)${colors.reset}`
    );
  } catch (err) {
    const duration = Date.now() - startTime;
    failedCount++;
    testResults.push({ id: tcId, description, passed: false, duration, error: err });
    console.log(
      `  ${colors.red}[FAIL]${colors.reset} ${colors.bold}${tcId}${colors.reset}: ${description} ${colors.dim}(${duration}ms)${colors.reset}`
    );
    console.log(`         ${colors.red}${err.message}${colors.reset}`);
    if (err.stack && !(err instanceof AssertionError)) {
      console.log(`         ${colors.gray}${err.stack.split('\n').slice(1, 4).join('\n         ')}${colors.reset}`);
    }
  }
}

function printTierHeader(tierNum, tierTitle) {
  console.log(`\n${colors.cyan}================================================================${colors.reset}`);
  console.log(`${colors.cyan}  TIER ${tierNum}: ${tierTitle.toUpperCase()}${colors.reset}`);
  console.log(`${colors.cyan}================================================================${colors.reset}`);
}

// ============================================================================
// Shared State Across Tests
// ============================================================================

const shared = {
  // Tier 1 primary user
  t1User: {
    username: `user_t1_${generateUUID().slice(0, 8)}`,
    email: `t1_${generateUUID()}@hollis-test.local`,
    password: 'SecurePassword123!',
    userId: null,
    accessToken: null,
    refreshToken: null,
  },
};

// ============================================================================
// Test Suite Definition
// ============================================================================

async function runAllTests() {
  console.log(`\n${colors.bold}Hollis Backend Phase 1 - Standalone Verification Suite${colors.reset}`);
  console.log(`${colors.dim}Target Server: ${colors.reset}${colors.bold}${baseUrl}${colors.reset}`);
  console.log(`${colors.dim}Started at: ${new Date().toISOString()}${colors.reset}`);

  // Preflight check
  try {
    const preflight = await fetch(`${baseUrl}/api/auth/verify-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'preflight_ping' }),
      signal: AbortSignal.timeout(4000),
    });
    // Server is reachable (either returns 200 with valid: false, or 404/other status)
  } catch (err) {
    // Try pinging root just in case
    try {
      await fetch(`${baseUrl}/`, { signal: AbortSignal.timeout(4000) });
    } catch (rootErr) {
      console.log(`\n${colors.red}${colors.bold}[CONNECTION ERROR]${colors.reset} Could not connect to target server at ${baseUrl}`);
      console.log(`${colors.yellow}Reason: ${rootErr.message || err.message}${colors.reset}`);
      console.log(`\nPlease ensure that the local Wrangler development server is running:`);
      console.log(`  ${colors.bold}npm run dev${colors.reset}  or  ${colors.bold}npx wrangler dev${colors.reset}\n`);
      process.exit(1);
    }
  }

  // --------------------------------------------------------------------------
  // TIER 1: Feature Coverage (Happy Path)
  // --------------------------------------------------------------------------
  printTierHeader(1, 'Feature Coverage (Happy Path)');

  // TC-01: Valid user registration
  await runTest('TC-01', 'Valid user registration (returns 201 + user_id + access_token)', async () => {
    const res = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: shared.t1User.username,
        email: shared.t1User.email,
        password: shared.t1User.password,
      },
    });

    assertStatus(res, 201, 'Registration must return 201 Created');
    assertTruthy(res.body, 'Response body must be valid JSON');
    assertTruthy(typeof res.body.user_id === 'string' && res.body.user_id.length > 0, 'Response must contain user_id string');
    assertTruthy(isValidJwtFormat(res.body.access_token), 'Response must contain valid JWT access_token');

    // Save tokens and user_id for downstream tests
    shared.t1User.userId = res.body.user_id;
    shared.t1User.accessToken = res.body.access_token;
  });

  // TC-02: Valid user login
  await runTest('TC-02', 'Valid user login (returns 200 + access_token + refresh_token)', async () => {
    const res = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        email: shared.t1User.email,
        password: shared.t1User.password,
      },
    });

    assertStatus(res, 200, 'Login must return 200 OK');
    assertTruthy(res.body, 'Response body must be valid JSON');
    assertTruthy(isValidJwtFormat(res.body.access_token), 'Response must contain valid JWT access_token');
    assertTruthy(isValidJwtFormat(res.body.refresh_token), 'Response must contain valid JWT refresh_token');
    if (res.body.user_id) {
      assertEqual(res.body.user_id, shared.t1User.userId, 'Returned user_id should match registered user_id');
    }

    // Refresh active access token
    shared.t1User.accessToken = res.body.access_token;
    shared.t1User.refreshToken = res.body.refresh_token;
  });

  // TC-03: Valid token verification via body
  await runTest('TC-03', 'Valid token verification via body (returns 200 + valid: true + user_id)', async () => {
    assertTruthy(shared.t1User.accessToken, 'Precondition: access token must exist from TC-01/TC-02');
    const res = await apiRequest('/api/auth/verify-token', {
      method: 'POST',
      body: {
        token: shared.t1User.accessToken,
      },
    });

    assertStatus(res, 200, 'Verify token must return 200 OK');
    assertTruthy(res.body, 'Response body must be JSON');
    assertEqual(res.body.valid, true, 'Token must be reported as valid: true');
    assertEqual(res.body.user_id, shared.t1User.userId, 'user_id must match token subject');
  });

  // TC-04: Get user profile & default settings
  await runTest('TC-04', 'Get user profile & default settings (returns 200 + popup mode + max_step_limit 20)', async () => {
    assertTruthy(shared.t1User.accessToken, 'Precondition: access token must exist');
    const res = await apiRequest('/api/users/me', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${shared.t1User.accessToken}`,
      },
    });

    assertStatus(res, 200, 'GET /api/users/me must return 200 OK');
    assertTruthy(res.body, 'Response body must be valid JSON');
    assertEqual(res.body.user_id, shared.t1User.userId, 'Profile user_id must match');
    assertEqual(res.body.username, shared.t1User.username, 'Profile username must match');
    assertEqual(res.body.email.toLowerCase(), shared.t1User.email.toLowerCase(), 'Profile email must match (case-insensitive)');
    
    // Check default settings per Hollis System Design
    assertTruthy(res.body.settings, 'Profile must include settings object');
    assertEqual(res.body.settings.confirmation_mode, 'popup', 'Default confirmation_mode must be "popup"');
    assertEqual(res.body.settings.max_step_limit, 20, 'Default max_step_limit must be 20');
    assertTruthy(typeof res.body.settings.updated_at === 'string', 'Settings updated_at must be an ISO timestamp string');
    assert(!isNaN(Date.parse(res.body.settings.updated_at)), 'updated_at must be a parseable ISO 8601 timestamp');
  });

  // TC-05: Update settings to 'push' mode and max_step_limit 50
  await runTest('TC-05', 'Update settings to "push" mode and max_step_limit 50 (returns 200 + updated settings)', async () => {
    assertTruthy(shared.t1User.accessToken, 'Precondition: access token must exist');
    const res = await apiRequest('/api/users/settings', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${shared.t1User.accessToken}`,
      },
      body: {
        confirmation_mode: 'push',
        max_step_limit: 50,
      },
    });

    assertStatus(res, 200, 'PUT /api/users/settings must return 200 OK');
    assertTruthy(res.body, 'Response body must be JSON');
    assertTruthy(res.body.settings, 'Response body must return updated settings object');
    assertEqual(res.body.settings.confirmation_mode, 'push', 'confirmation_mode must be updated to "push"');
    assertEqual(res.body.settings.max_step_limit, 50, 'max_step_limit must be updated to 50');
    assertTruthy(res.body.settings.updated_at, 'updated_at must be present');
  });

  // TC-06: User logout confirmation
  await runTest('TC-06', 'User logout confirmation (returns 200 with success confirmation)', async () => {
    assertTruthy(shared.t1User.accessToken, 'Precondition: access token must exist');
    const res = await apiRequest('/api/auth/logout', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${shared.t1User.accessToken}`,
      },
      body: {},
    });

    assertStatus(res, 200, 'POST /api/auth/logout must return 200 OK');
    assertTruthy(res.body, 'Response body must be JSON');
    assertTruthy(
      res.body.message || res.body.success,
      'Response should indicate successful logout confirmation'
    );
  });

  // --------------------------------------------------------------------------
  // TIER 2: Boundary & Corner Cases
  // --------------------------------------------------------------------------
  printTierHeader(2, 'Boundary & Corner Cases');

  // TC-07: Duplicate email registration returns 400 Bad Request
  await runTest('TC-07', 'Duplicate email registration returns 400 Bad Request', async () => {
    const res = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'duplicate_tester',
        email: shared.t1User.email,
        password: 'Password123!',
      },
    });

    assertStatus(res, 400, 'Registering existing email must return 400 Bad Request');
    assertTruthy(res.body && res.body.error, 'Response must contain error message');
  });

  // TC-08: Case-insensitive email duplicate check
  await runTest('TC-08', 'Case-insensitive email duplicate check returns 400', async () => {
    const uppercaseEmail = shared.t1User.email.toUpperCase();
    const res = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'case_insensitive_tester',
        email: uppercaseEmail,
        password: 'Password123!',
      },
    });

    assertStatus(res, 400, 'Registering uppercase variant of existing email must return 400 Bad Request');
    assertTruthy(res.body && res.body.error, 'Response must contain error message');
  });

  // TC-09: Register with invalid email format returns 400
  await runTest('TC-09', 'Register with invalid email format returns 400', async () => {
    const badEmails = ['plainaddress', 'missingdomain@', '@missinguser.com', 'user@.com'];
    for (const badEmail of badEmails) {
      const res = await apiRequest('/api/auth/register', {
        method: 'POST',
        body: {
          username: 'invalid_email_user',
          email: badEmail,
          password: 'Password123!',
        },
      });

      assertStatus(res, 400, `Invalid email "${badEmail}" must return 400 Bad Request`);
      assertTruthy(res.body && res.body.error, 'Response must contain error message');
    }
  });

  // TC-10: Register with short password (< 8 chars) returns 400
  await runTest('TC-10', 'Register with short password (< 8 chars) returns 400', async () => {
    const res = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'short_pass_user',
        email: `shortpass_${generateUUID()}@hollis-test.local`,
        password: '12345', // 5 characters < 8
      },
    });

    assertStatus(res, 400, 'Password with < 8 chars must return 400 Bad Request');
    assertTruthy(res.body && res.body.error, 'Response must contain error message indicating password length');
  });

  // TC-11: Register with missing fields returns 400
  await runTest('TC-11', 'Register with missing required fields returns 400', async () => {
    // Missing password
    const res1 = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'no_pass_user',
        email: `nopass_${generateUUID()}@hollis-test.local`,
      },
    });
    assertStatus(res1, 400, 'Missing password must return 400');

    // Missing email
    const res2 = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'no_email_user',
        password: 'Password123!',
      },
    });
    assertStatus(res2, 400, 'Missing email must return 400');

    // Missing username
    const res3 = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        email: `nouser_${generateUUID()}@hollis-test.local`,
        password: 'Password123!',
      },
    });
    assertStatus(res3, 400, 'Missing username must return 400');
  });

  // TC-12: Login with wrong password returns 401 Unauthorized
  await runTest('TC-12', 'Login with wrong password returns 401 Unauthorized', async () => {
    const res = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        email: shared.t1User.email,
        password: 'WrongPassword999!',
      },
    });

    assertStatus(res, 401, 'Login with incorrect password must return 401 Unauthorized');
    assertTruthy(res.body && res.body.error, 'Response must contain error message');
  });

  // TC-13: Login with non-existent email returns 401 Unauthorized
  await runTest('TC-13', 'Login with non-existent email returns 401 Unauthorized', async () => {
    const ghostEmail = `nonexistent_${generateUUID()}@hollis-test.local`;
    const res = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        email: ghostEmail,
        password: 'Password123!',
      },
    });

    assertStatus(res, 401, 'Login with non-existent email must return 401 Unauthorized');
    assertTruthy(res.body && res.body.error, 'Response must contain error message');
  });

  // TC-14: Verify invalid / malformed token returns valid: false
  await runTest('TC-14', 'Verify invalid / malformed token returns valid: false', async () => {
    const res = await apiRequest('/api/auth/verify-token', {
      method: 'POST',
      body: {
        token: 'this.is.clearly.an.invalid.and.malformed.token',
      },
    });

    assertStatus(res, 200, 'verify-token should return HTTP 200 with verification result');
    assertTruthy(res.body, 'Response body must be JSON');
    assertEqual(res.body.valid, false, 'Malformed token must return valid: false');
  });

  // TC-15: Verify expired token returns valid: false
  await runTest('TC-15', 'Verify expired token returns valid: false', async () => {
    // Construct a JWT with exp in the distant past (e.g. year 2000)
    const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
    const payload = base64UrlEncode(JSON.stringify({
      sub: 'expired_user_uuid',
      email: 'expired@example.com',
      iat: 946684800, // Jan 1, 2000
      exp: 946688400, // Jan 1, 2000 + 1 hour
    }));
    const fakeSignature = base64UrlEncode('fake_signature_bytes_for_testing');
    const expiredToken = `${header}.${payload}.${fakeSignature}`;

    const res = await apiRequest('/api/auth/verify-token', {
      method: 'POST',
      body: {
        token: expiredToken,
      },
    });

    assertStatus(res, 200, 'verify-token must return 200 OK');
    assertTruthy(res.body, 'Response body must be JSON');
    assertEqual(res.body.valid, false, 'Expired token must return valid: false');
  });

  // TC-16: Verify token via Authorization Bearer header returns valid: true
  await runTest('TC-16', 'Verify token via Authorization Bearer header returns valid: true', async () => {
    assertTruthy(shared.t1User.accessToken, 'Precondition: access token must exist');
    const res = await apiRequest('/api/auth/verify-token', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${shared.t1User.accessToken}`,
      },
      body: {},
    });

    assertStatus(res, 200, 'verify-token via Bearer header must return 200 OK');
    assertTruthy(res.body, 'Response body must be JSON');
    assertEqual(res.body.valid, true, 'Bearer token should be verified as valid: true');
    assertEqual(res.body.user_id, shared.t1User.userId, 'user_id must match authenticated user');
  });

  // TC-17: Update settings with invalid confirmation_mode (e.g. 'sms') returns 400
  await runTest('TC-17', 'Update settings with invalid confirmation_mode (e.g. "sms") returns 400', async () => {
    assertTruthy(shared.t1User.accessToken, 'Precondition: access token must exist');
    const res = await apiRequest('/api/users/settings', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${shared.t1User.accessToken}`,
      },
      body: {
        confirmation_mode: 'sms', // Only 'popup', 'push', 'none' are permitted
      },
    });

    assertStatus(res, 400, 'Invalid confirmation_mode must return 400 Bad Request');
    assertTruthy(res.body && res.body.error, 'Response must contain error description');
  });

  // TC-18: Update settings with negative/zero max_step_limit returns 400
  await runTest('TC-18', 'Update settings with negative/zero max_step_limit returns 400', async () => {
    assertTruthy(shared.t1User.accessToken, 'Precondition: access token must exist');

    // Negative value test
    const resNegative = await apiRequest('/api/users/settings', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${shared.t1User.accessToken}`,
      },
      body: {
        max_step_limit: -5,
      },
    });
    assertStatus(resNegative, 400, 'Negative max_step_limit must return 400 Bad Request');
    assertTruthy(resNegative.body && resNegative.body.error, 'Response must contain error description');

    // Zero value test
    const resZero = await apiRequest('/api/users/settings', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${shared.t1User.accessToken}`,
      },
      body: {
        max_step_limit: 0,
      },
    });
    assertStatus(resZero, 400, 'Zero max_step_limit must return 400 Bad Request');
    assertTruthy(resZero.body && resZero.body.error, 'Response must contain error description');
  });

  // TC-19: Update settings with empty payload returns 400
  await runTest('TC-19', 'Update settings with empty payload returns 400', async () => {
    assertTruthy(shared.t1User.accessToken, 'Precondition: access token must exist');
    const res = await apiRequest('/api/users/settings', {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${shared.t1User.accessToken}`,
      },
      body: {},
    });

    assertStatus(res, 400, 'Empty settings payload must return 400 Bad Request');
    assertTruthy(res.body && res.body.error, 'Response must contain error description');
  });

  // --------------------------------------------------------------------------
  // TIER 3: Cross-Feature & Security Combinations
  // --------------------------------------------------------------------------
  printTierHeader(3, 'Cross-Feature & Security Combinations');

  // TC-20: Access protected GET /api/users/me without Authorization header returns 401
  await runTest('TC-20', 'Access protected GET /api/users/me without Authorization header returns 401', async () => {
    const res = await apiRequest('/api/users/me', {
      method: 'GET',
    });

    assertStatus(res, 401, 'Accessing /api/users/me without auth token must return 401 Unauthorized');
    assertTruthy(res.body && res.body.error, 'Response must contain error message');
  });

  // TC-21: Access protected GET /api/users/me with invalid token returns 401
  await runTest('TC-21', 'Access protected GET /api/users/me with invalid token returns 401', async () => {
    const res = await apiRequest('/api/users/me', {
      method: 'GET',
      headers: {
        'Authorization': 'Bearer invalid.bogus.token.value',
      },
    });

    assertStatus(res, 401, 'Accessing /api/users/me with invalid token must return 401 Unauthorized');
    assertTruthy(res.body && res.body.error, 'Response must contain error message');
  });

  // TC-22: Access protected PUT /api/users/settings without token returns 401
  await runTest('TC-22', 'Access protected PUT /api/users/settings without token returns 401', async () => {
    const res = await apiRequest('/api/users/settings', {
      method: 'PUT',
      body: {
        confirmation_mode: 'none',
      },
    });

    assertStatus(res, 401, 'Accessing /api/users/settings without token must return 401 Unauthorized');
    assertTruthy(res.body && res.body.error, 'Response must contain error message');
  });

  // TC-23: Settings persistence verification across subsequent requests
  await runTest('TC-23', 'Settings persistence: Verify GET /api/users/me reflects settings updated by PUT /api/users/settings', async () => {
    // Create an isolated user for this persistence test
    const testEmail = `persist_${generateUUID()}@hollis-test.local`;
    const regRes = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: {
        username: 'persist_tester',
        email: testEmail,
        password: 'SecurePassword123!',
      },
    });
    assertStatus(regRes, 201, 'Registration must succeed');
    const token = regRes.body.access_token;
    const userId = regRes.body.user_id;

    // Update settings to distinct non-default values
    const updateRes = await apiRequest('/api/users/settings', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${token}` },
      body: {
        confirmation_mode: 'none',
        max_step_limit: 35,
      },
    });
    assertStatus(updateRes, 200, 'Settings update must succeed');

    // Retrieve profile via GET /api/users/me and verify values persisted to database
    const getRes = await apiRequest('/api/users/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` },
    });

    assertStatus(getRes, 200, 'Profile fetch must succeed');
    assertEqual(getRes.body.user_id, userId, 'User ID must match');
    assertEqual(getRes.body.settings.confirmation_mode, 'none', 'Persisted confirmation_mode must be "none"');
    assertEqual(getRes.body.settings.max_step_limit, 35, 'Persisted max_step_limit must be 35');
  });

  // --------------------------------------------------------------------------
  // TIER 4: Real-World End-to-End Application Scenario
  // --------------------------------------------------------------------------
  printTierHeader(4, 'Real-World End-to-End Application Scenario');

  // TC-24: Android Full Lifecycle Flow
  await runTest('TC-24', 'Android Full Lifecycle Flow: Register -> Splash Verify -> Fetch Settings -> Update Settings -> Logout -> Re-login -> Verify Persistence', async () => {
    const androidUser = {
      username: 'AndroidDeviceTester',
      email: `droid_${generateUUID()}@hollis-mobile.app`,
      password: 'AndroidSecurePass2026!',
    };

    // Step 1: Android First-Time Onboarding / Registration
    const regRes = await apiRequest('/api/auth/register', {
      method: 'POST',
      body: androidUser,
    });
    assertStatus(regRes, 201, 'Step 1: Android registration failed');
    const initialAccessToken = regRes.body.access_token;
    const registeredUserId = regRes.body.user_id;
    assertTruthy(initialAccessToken, 'Step 1: Missing access_token');
    assertTruthy(registeredUserId, 'Step 1: Missing user_id');

    // Step 2: Android Splash Screen Resume Check (verify-token)
    const splashRes = await apiRequest('/api/auth/verify-token', {
      method: 'POST',
      body: { token: initialAccessToken },
    });
    assertStatus(splashRes, 200, 'Step 2: Splash verify token request failed');
    assertEqual(splashRes.body.valid, true, 'Step 2: Cached token must verify successfully on Splash screen');
    assertEqual(splashRes.body.user_id, registeredUserId, 'Step 2: Splash screen user_id must match');

    // Step 3: Main Dashboard Load (fetch user profile & initial settings)
    const initialProfileRes = await apiRequest('/api/users/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${initialAccessToken}` },
    });
    assertStatus(initialProfileRes, 200, 'Step 3: Failed to load profile on main screen');
    assertEqual(initialProfileRes.body.settings.confirmation_mode, 'popup', 'Step 3: Initial mode must be popup');
    assertEqual(initialProfileRes.body.settings.max_step_limit, 20, 'Step 3: Initial limit must be 20');

    // Step 4: User updates automation preferences in App Settings
    const updateSettingsRes = await apiRequest('/api/users/settings', {
      method: 'PUT',
      headers: { 'Authorization': `Bearer ${initialAccessToken}` },
      body: {
        confirmation_mode: 'push',
        max_step_limit: 45,
      },
    });
    assertStatus(updateSettingsRes, 200, 'Step 4: Failed to update Android preferences');
    assertEqual(updateSettingsRes.body.settings.confirmation_mode, 'push', 'Step 4: confirmation_mode should be push');
    assertEqual(updateSettingsRes.body.settings.max_step_limit, 45, 'Step 4: max_step_limit should be 45');

    // Step 5: User logs out from Android App Drawer
    const logoutRes = await apiRequest('/api/auth/logout', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${initialAccessToken}` },
      body: {},
    });
    assertStatus(logoutRes, 200, 'Step 5: Android logout request failed');

    // Step 6: User re-authenticates on Login Screen
    const reLoginRes = await apiRequest('/api/auth/login', {
      method: 'POST',
      body: {
        email: androidUser.email,
        password: androidUser.password,
      },
    });
    assertStatus(reLoginRes, 200, 'Step 6: Android re-login failed');
    const newAccessToken = reLoginRes.body.access_token;
    assertTruthy(newAccessToken, 'Step 6: Missing new access_token upon login');

    // Step 7: Android App re-hydrates profile & verifies settings persistence
    const rehydratedProfileRes = await apiRequest('/api/users/me', {
      method: 'GET',
      headers: { 'Authorization': `Bearer ${newAccessToken}` },
    });
    assertStatus(rehydratedProfileRes, 200, 'Step 7: Failed to re-hydrate profile after login');
    assertEqual(rehydratedProfileRes.body.user_id, registeredUserId, 'Step 7: Re-hydrated user_id matches');
    assertEqual(rehydratedProfileRes.body.settings.confirmation_mode, 'push', 'Step 7: confirmation_mode persisted as "push"');
    assertEqual(rehydratedProfileRes.body.settings.max_step_limit, 45, 'Step 7: max_step_limit persisted as 45');
  });

  // ==========================================================================
  // Summary & Statistics
  // ==========================================================================
  const totalDuration = testResults.reduce((acc, t) => acc + t.duration, 0);

  console.log(`\n${colors.cyan}================================================================${colors.reset}`);
  console.log(`${colors.cyan}                        TEST SUMMARY                            ${colors.reset}`);
  console.log(`${colors.cyan}================================================================${colors.reset}`);
  console.log(`  Target Server : ${baseUrl}`);
  console.log(`  Total Tests   : ${colors.bold}${testResults.length}${colors.reset}`);
  console.log(`  Passed        : ${colors.green}${colors.bold}${passedCount}${colors.reset}`);
  console.log(`  Failed        : ${failedCount > 0 ? colors.red : colors.green}${colors.bold}${failedCount}${colors.reset}`);
  console.log(`  Duration      : ${totalDuration}ms`);

  if (failedCount === 0) {
    console.log(`\n  ${colors.green}${colors.bold}[OVERALL RESULT] ALL ${testResults.length} TEST CASES PASSED SUCCESSFULLY!${colors.reset}\n`);
    process.exit(0);
  } else {
    console.log(`\n  ${colors.red}${colors.bold}[OVERALL RESULT] ${failedCount} OF ${testResults.length} TEST CASES FAILED.${colors.reset}\n`);
    process.exit(1);
  }
}

// Execute test suite
runAllTests().catch((fatalErr) => {
  console.error(`\n${colors.red}${colors.bold}[FATAL UNHANDLED EXCEPTION]${colors.reset}:`, fatalErr);
  process.exit(1);
});
