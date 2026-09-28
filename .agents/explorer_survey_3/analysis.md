# Hollis Backend Phase 1 — Web Crypto Auth, JWT Middleware, Endpoint Schemas, & Verification Suite Analysis

**Author**: Explorer Survey 3  
**Date**: 2026-09-07T14:35:00Z  
**Target Runtime**: Cloudflare Workers (V8 Edge Runtime, `compatibility_date: "2026-09-07"`)  
**Database**: Cloudflare D1 SQLite (`env.DB`)  
**Mission**: Analyze and specify the Web Crypto authentication system, JWT middleware, endpoint schemas (`/api/auth/*`, `/api/users/*`), and automated verification suite architecture.

---

## 1. Executive Summary

Phase 1 of the Hollis Backend establishes the identity, security, and user configuration foundation for the Android screen automation backend. Because Cloudflare Workers executes within an isolated V8 edge environment rather than a standard Node.js server, native binary modules (e.g. `bcrypt`, `argon2`, Node `crypto` native bindings) cannot be used.

This specification details:
1. **Edge-Native Cryptography**: Implements password hashing via **PBKDF2 with SHA-256** and token signing via **HMAC-SHA256 (HS256)** using pure, standard Web Crypto (`crypto.subtle`) and Web APIs (`btoa`, `atob`, `TextEncoder`, `TextDecoder`).
2. **Stateless JWT Architecture**: Employs a dual-token strategy (1-hour Access Token + 7-day Refresh Token) with zero external database dependencies for tokens, strictly conforming to the 5-table D1 database schema.
3. **Six Deterministic Endpoints**: Full request/response schemas, D1 SQL queries, validation logic, and HTTP status codes for `/api/auth/register`, `/api/auth/login`, `/api/auth/verify-token`, `/api/auth/logout`, `/api/users/me`, and `/api/users/settings`.
4. **Automated Verification Suite**: An end-to-end opaque-box test runner (`test_phase1.js`) containing 23 test cases across 4 tiers, verifying happy paths, validation failures, security boundaries, and D1 persistence against local `wrangler dev`.

---

## 2. Runtime Architecture & Web Crypto in Cloudflare Workers

### 2.1 Edge Runtime Constraints
- **Global Availability**: `crypto.subtle`, `crypto.getRandomValues()`, and `crypto.randomUUID()` are available globally on `globalThis` in Cloudflare Workers.
- **Asynchronous Execution**: All Web Crypto operations (`importKey`, `deriveBits`, `sign`, `verify`) are Promise-based asynchronous functions.
- **Zero Binary Dependencies**: Native Node C++ add-ons are completely unsupported. All cryptographic operations and encoding/decoding must rely exclusively on standard Web APIs.
- **No Node `Buffer` Dependency**: String-to-byte conversions and Base64URL conversions must use `TextEncoder`, `TextDecoder`, `Uint8Array`, `btoa`, and `atob`.

### 2.2 Base64URL Encoding/Decoding Primitives
JSON Web Tokens (RFC 7515) require URL-safe base64 without `=` padding characters. Standard `btoa` produces standard Base64. The following edge-native helper functions convert between byte buffers, strings, and Base64URL without Node.js dependencies:

```javascript
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

/**
 * Converts a Uint8Array to a Base64URL-encoded string.
 * @param {Uint8Array} bytes 
 * @returns {string}
 */
export function bytesToBase64Url(bytes) {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Converts a Base64URL-encoded string to a Uint8Array.
 * @param {string} str 
 * @returns {Uint8Array}
 */
export function base64UrlToBytes(str) {
  let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

/**
 * Converts a UTF-8 string to a Base64URL string.
 * @param {string} str 
 * @returns {string}
 */
export function stringToBase64Url(str) {
  return bytesToBase64Url(textEncoder.encode(str));
}

/**
 * Converts a Base64URL string to a UTF-8 string.
 * @param {string} str 
 * @returns {string}
 */
export function base64UrlToString(str) {
  return textDecoder.decode(base64UrlToBytes(str));
}
```

---

## 3. Password Hashing & Verification Specification (PBKDF2-SHA256)

### 3.1 Algorithm Parameters
| Parameter | Value | Rationale |
|---|---|---|
| **Algorithm** | `PBKDF2` | Universally supported in Web Crypto; edge-native |
| **Hash Function** | `SHA-256` | Secure, standard cryptographic hash |
| **Salt Length** | 16 bytes (128 bits) | Generated via `crypto.getRandomValues(new Uint8Array(16))` |
| **Iterations** | 100,000 | OWASP recommendation for PBKDF2-HMAC-SHA256; ~20ms execution on Workers |
| **Derived Key Length** | 32 bytes (256 bits) | Output of `crypto.subtle.deriveBits` |
| **Storage Format** | `pbkdf2_sha256:100000:<salt_hex>:<hash_hex>` | Shell-safe, colon-delimited, parseable via `.split(':')` |

### 3.2 Password Hashing Function
```javascript
/**
 * Hashes a plaintext password using PBKDF2-SHA256.
 * @param {string} password 
 * @returns {Promise<string>} Format: pbkdf2_sha256:100000:<salt_hex>:<hash_hex>
 */
export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: 100000,
      hash: 'SHA-256'
    },
    keyMaterial,
    256 // 32 bytes
  );

  const saltHex = Array.from(salt)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  const hashHex = Array.from(new Uint8Array(derivedBits))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  return `pbkdf2_sha256:100000:${saltHex}:${hashHex}`;
}
```

### 3.3 Password Verification Function (Timing-Safe)
To prevent side-channel timing attacks, hash bytes are verified in constant time:
```javascript
/**
 * Verifies a plaintext password against a stored PBKDF2 hash.
 * @param {string} password 
 * @param {string} storedHash 
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(password, storedHash) {
  if (!storedHash || typeof storedHash !== 'string') return false;
  const parts = storedHash.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;

  const iterations = parseInt(parts[1], 10);
  const saltHex = parts[2];
  const originalHashHex = parts[3];

  if (isNaN(iterations) || iterations < 10000 || saltHex.length !== 32 || originalHashHex.length !== 64) {
    return false;
  }

  const saltMatches = saltHex.match(/.{1,2}/g);
  const originalMatches = originalHashHex.match(/.{1,2}/g);
  if (!saltMatches || !originalMatches) return false;

  const salt = new Uint8Array(saltMatches.map(byte => parseInt(byte, 16)));
  const originalBytes = new Uint8Array(originalMatches.map(byte => parseInt(byte, 16)));

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const derivedBits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: salt,
      iterations: iterations,
      hash: 'SHA-256'
    },
    keyMaterial,
    256
  );

  const derivedBytes = new Uint8Array(derivedBits);
  if (derivedBytes.length !== originalBytes.length) return false;

  // Constant-time byte-by-byte XOR comparison
  let diff = 0;
  for (let i = 0; i < derivedBytes.length; i++) {
    diff |= derivedBytes[i] ^ originalBytes[i];
  }
  return diff === 0;
}
```

---

## 4. JSON Web Token (JWT) Specification (HS256) & Middleware

### 4.1 Token Structure
- **Algorithm**: `HS256` (HMAC with SHA-256)
- **Format**: `<header_b64url>.<payload_b64url>.<signature_b64url>`
- **Header**:
  ```json
  {
    "alg": "HS256",
    "typ": "JWT"
  }
  ```

### 4.2 Token Payloads & Lifetimes
#### Access Token (1-hour lifetime)
Used for all authenticated API requests under `/api/users/*`.
```json
{
  "sub": "b2f68593-ff26-4b82-a9b7-f41e5da2d801",
  "username": "alice",
  "email": "alice@example.com",
  "type": "access",
  "iat": 1788795000,
  "exp": 1788798600
}
```

#### Refresh Token (7-day lifetime)
Returned upon registration and login; used for issuing new access tokens or client persistence.
```json
{
  "sub": "b2f68593-ff26-4b82-a9b7-f41e5da2d801",
  "type": "refresh",
  "iat": 1788795000,
  "exp": 1789400000
}
```

### 4.3 Secret Key Management
- Secret source: `env.JWT_SECRET`.
- Fallback for local development if not configured in `.dev.vars`:
  `const secret = env.JWT_SECRET || 'hollis-default-dev-secret-key-do-not-use-in-prod-32bytes';`
- Imported into `CryptoKey` using:
  ```javascript
  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify']
  );
  ```

### 4.4 JWT Generation & Verification Implementation
```javascript
/**
 * Signs a JWT payload with HMAC-SHA256.
 * @param {object} payload 
 * @param {string} secret 
 * @returns {Promise<string>}
 */
export async function signJwt(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = stringToBase64Url(JSON.stringify(header));
  const encodedPayload = stringToBase64Url(JSON.stringify(payload));
  const data = textEncoder.encode(`${encodedHeader}.${encodedPayload}`);

  const key = await crypto.subtle.importKey(
    'raw',
    textEncoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signature = await crypto.subtle.sign('HMAC', key, data);
  const encodedSignature = bytesToBase64Url(new Uint8Array(signature));

  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

/**
 * Verifies a JWT token, checks cryptographic signature and expiry.
 * @param {string} token 
 * @param {string} secret 
 * @returns {Promise<object|null>} Returns payload if valid, null otherwise
 */
export async function verifyJwt(token, secret) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;

  const [encodedHeader, encodedPayload, encodedSignature] = parts;

  try {
    const header = JSON.parse(base64UrlToString(encodedHeader));
    if (header.alg !== 'HS256' || header.typ !== 'JWT') return null;

    const key = await crypto.subtle.importKey(
      'raw',
      textEncoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const data = textEncoder.encode(`${encodedHeader}.${encodedPayload}`);
    const signature = base64UrlToBytes(encodedSignature);

    const isValid = await crypto.subtle.verify('HMAC', key, signature, data);
    if (!isValid) return null;

    const payload = JSON.parse(base64UrlToString(encodedPayload));
    const now = Math.floor(Date.now() / 1000);

    if (payload.exp && payload.exp < now) return null;
    if (payload.nbf && payload.nbf > now) return null;

    return payload;
  } catch {
    return null;
  }
}
```

### 4.5 JWT Middleware Specification
For protected endpoints (`/api/users/*`), an edge middleware wrapper or guard verifies the Bearer token:
```javascript
/**
 * Middleware to authenticate requests.
 * @param {Request} request 
 * @param {object} env 
 * @returns {Promise<{ user: object|null, response: Response|null }>}
 */
export async function requireAuth(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return {
      user: null,
      response: new Response(
        JSON.stringify({ error: 'unauthorized', message: 'Missing or malformed Authorization header.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  const token = authHeader.substring(7).trim();
  const secret = env.JWT_SECRET || 'hollis-default-dev-secret-key-do-not-use-in-prod-32bytes';
  const payload = await verifyJwt(token, secret);

  if (!payload || payload.type !== 'access') {
    return {
      user: null,
      response: new Response(
        JSON.stringify({ error: 'unauthorized', message: 'Invalid or expired token.' }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    };
  }

  return {
    user: {
      id: payload.sub,
      email: payload.email,
      username: payload.username
    },
    response: null
  };
}
```

---

## 5. Endpoint Specifications & Request/Response Contracts

All request and response bodies use `application/json; charset=utf-8`.

### 5.1 `POST /api/auth/register`
Creates a new user, hashes password, sets up default settings, and returns tokens.

#### Request
- **Method**: `POST`
- **Path**: `/api/auth/register`
- **Headers**: `Content-Type: application/json`
- **Body Schema**:
  ```json
  {
    "username": "alice",
    "email": "alice@example.com",
    "password": "Password123!"
  }
  ```

#### Input Validation Rules
1. `username`: required, string, trimmed length between 2 and 50 characters.
2. `email`: required, string, valid email regex (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/`), normalized to lowercase.
3. `password`: required, string, minimum length 8 characters.

#### Business Logic & D1 Queries
1. Check duplicate email:
   ```sql
   SELECT id FROM users WHERE email = ?1;
   ```
   If found -> return HTTP 400 Bad Request (`error: "email_already_registered"`).
2. Generate UUIDs:
   - `user_id = crypto.randomUUID()`
   - `settings_id = crypto.randomUUID()`
3. Compute PBKDF2 hash:
   - `password_hash = await hashPassword(password)`
4. Set timestamp:
   - `now = new Date().toISOString()`
5. Atomically insert user and default user_settings via `env.DB.batch`:
   ```sql
   INSERT INTO users (id, username, email, password_hash, created_at)
   VALUES (?1, ?2, ?3, ?4, ?5);

   INSERT INTO user_settings (id, user_id, confirmation_mode, max_step_limit, updated_at)
   VALUES (?1, ?2, 'popup', 20, ?3);
   ```
6. Generate Access Token (1h) and Refresh Token (7d).

#### Response
- **Status**: `201 Created`
- **Body**:
  ```json
  {
    "success": true,
    "user_id": "b2f68593-ff26-4b82-a9b7-f41e5da2d801",
    "username": "alice",
    "email": "alice@example.com",
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```

#### Error Cases
- Missing or malformed body -> HTTP 400:
  `{ "error": "validation_failed", "message": "Email, username, and password (min 8 characters) are required." }`
- Duplicate email -> HTTP 400:
  `{ "error": "email_already_registered", "message": "Email is already registered." }`

---

### 5.2 `POST /api/auth/login`
Validates credentials and issues access & refresh tokens.

#### Request
- **Method**: `POST`
- **Path**: `/api/auth/login`
- **Headers**: `Content-Type: application/json`
- **Body Schema**:
  ```json
  {
    "email": "alice@example.com",
    "password": "Password123!"
  }
  ```

#### Business Logic & D1 Queries
1. Query user by lowercase email:
   ```sql
   SELECT id, username, email, password_hash FROM users WHERE email = ?1;
   ```
2. If user does not exist -> return HTTP 401 Unauthorized (`error: "invalid_credentials"`).
3. Verify password:
   ```javascript
   const valid = await verifyPassword(password, user.password_hash);
   ```
4. If invalid -> return HTTP 401 Unauthorized (`error: "invalid_credentials"`).
5. Generate Access Token (1h) and Refresh Token (7d).

#### Response
- **Status**: `200 OK`
- **Body**:
  ```json
  {
    "success": true,
    "user_id": "b2f68593-ff26-4b82-a9b7-f41e5da2d801",
    "username": "alice",
    "email": "alice@example.com",
    "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "refresh_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```

#### Error Cases
- Missing email or password -> HTTP 400:
  `{ "error": "missing_credentials", "message": "Email and password are required." }`
- Wrong password or user not found -> HTTP 401:
  `{ "error": "invalid_credentials", "message": "Invalid email or password." }`

---

### 5.3 `POST /api/auth/verify-token`
Fast token validation endpoint for the Android Splash Screen.

#### Request
- **Method**: `POST`
- **Path**: `/api/auth/verify-token`
- **Headers**: `Content-Type: application/json` (optional: `Authorization: Bearer <token>`)
- **Body Schema** (optional if provided in header):
  ```json
  {
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
  }
  ```

#### Business Logic
1. Extract token from `Authorization: Bearer <token>` header or `{ "token": "..." }` body.
2. Verify token signature and expiry via `verifyJwt(token, secret)`.
3. Check `payload.type === 'access'`.
4. If valid, return `{ valid: true, user_id, email, username }`.
5. If invalid or expired, return `{ valid: false }`.
6. Note: HTTP status is always `200 OK` per design specification R2.

#### Responses
- **Status**: `200 OK` (Valid)
  ```json
  {
    "valid": true,
    "user_id": "b2f68593-ff26-4b82-a9b7-f41e5da2d801",
    "email": "alice@example.com",
    "username": "alice"
  }
  ```
- **Status**: `200 OK` (Invalid / Expired)
  ```json
  {
    "valid": false
  }
  ```

---

### 5.4 `POST /api/auth/logout`
Client logout confirmation.

#### Request
- **Method**: `POST`
- **Path**: `/api/auth/logout`
- **Headers**: `Authorization: Bearer <token>` (optional)

#### Response
- **Status**: `200 OK`
- **Body**:
  ```json
  {
    "success": true,
    "message": "Logged out successfully"
  }
  ```

---

### 5.5 `GET /api/users/me`
Retrieves profile and settings for the authenticated user.

#### Request
- **Method**: `GET`
- **Path**: `/api/users/me`
- **Headers**: `Authorization: Bearer <access_token>`

#### Business Logic & D1 Queries
1. Protected by `requireAuth` middleware. If invalid/missing token -> HTTP 401 Unauthorized.
2. Query user profile joined with settings:
   ```sql
   SELECT u.id AS user_id, u.username, u.email, u.created_at,
          s.confirmation_mode, s.max_step_limit, s.updated_at
   FROM users u
   LEFT JOIN user_settings s ON u.id = s.user_id
   WHERE u.id = ?1;
   ```
3. If no record found -> HTTP 404 Not Found (`error: "user_not_found"`).

#### Response
- **Status**: `200 OK`
- **Body**:
  ```json
  {
    "user_id": "b2f68593-ff26-4b82-a9b7-f41e5da2d801",
    "username": "alice",
    "email": "alice@example.com",
    "created_at": "2026-09-07T14:30:00.000Z",
    "settings": {
      "confirmation_mode": "popup",
      "max_step_limit": 20,
      "updated_at": "2026-09-07T14:30:00.000Z"
    }
  }
  ```

#### Error Cases
- Missing/invalid Bearer token -> HTTP 401 Unauthorized:
  `{ "error": "unauthorized", "message": "Missing or malformed Authorization header." }`

---

### 5.6 `PUT /api/users/settings`
Updates `confirmation_mode` and/or `max_step_limit`.

#### Request
- **Method**: `PUT`
- **Path**: `/api/users/settings`
- **Headers**:
  - `Authorization: Bearer <access_token>`
  - `Content-Type: application/json`
- **Body Schema**:
  ```json
  {
    "confirmation_mode": "push",
    "max_step_limit": 30
  }
  ```

#### Input Validation Rules
1. `confirmation_mode` (optional): string, must be one of `["popup", "push", "none"]`.
2. `max_step_limit` (optional): integer, must be > 0 (e.g. between 1 and 100).
3. At least one field (`confirmation_mode` or `max_step_limit`) must be provided.

#### Business Logic & D1 Queries
1. Protected by `requireAuth` middleware.
2. Validate input fields. If invalid -> return HTTP 400 Bad Request.
3. Update settings in D1:
   ```sql
   UPDATE user_settings
   SET confirmation_mode = COALESCE(?1, confirmation_mode),
       max_step_limit = COALESCE(?2, max_step_limit),
       updated_at = ?3
   WHERE user_id = ?4;
   ```
4. Query and return updated record:
   ```sql
   SELECT confirmation_mode, max_step_limit, updated_at
   FROM user_settings
   WHERE user_id = ?1;
   ```

#### Response
- **Status**: `200 OK`
- **Body**:
  ```json
  {
    "success": true,
    "settings": {
      "user_id": "b2f68593-ff26-4b82-a9b7-f41e5da2d801",
      "confirmation_mode": "push",
      "max_step_limit": 30,
      "updated_at": "2026-09-07T14:35:00.000Z"
    }
  }
  ```

#### Error Cases
- Invalid confirmation mode (e.g. "always") -> HTTP 400 Bad Request:
  `{ "error": "invalid_input", "message": "confirmation_mode must be 'popup', 'push', or 'none'." }`
- Invalid step limit (e.g. 0 or negative) -> HTTP 400 Bad Request:
  `{ "error": "invalid_input", "message": "max_step_limit must be a positive integer." }`
- Missing/invalid token -> HTTP 401 Unauthorized.

---

## 6. Error Handling & Standardized Response Formats

All error responses across all endpoints adhere to the standard JSON structure:
```json
{
  "error": "<machine_readable_code>",
  "message": "<human_readable_explanation>"
}
```

### Standard Status Codes
- `200 OK`: Successful retrieval, update, or token check.
- `201 Created`: Successful resource creation (registration).
- `400 Bad Request`: Client validation error, duplicate email, malformed JSON.
- `401 Unauthorized`: Missing token, expired token, invalid credentials.
- `404 Not Found`: Resource not found (non-existent user profile or route).
- `405 Method Not Allowed`: HTTP method not supported on route.
- `500 Internal Server Error`: Unhandled server exception.

---

## 7. Automated Verification Suite Architecture (`test_phase1.js`)

### 7.1 Architecture & Design Principles
- **Opaque-Box Testing**: Interacts with the backend purely via HTTP requests against `http://127.0.0.1:8787` using standard `fetch`.
- **Zero External Dependencies**: Standalone Node.js script runnable with `node test_phase1.js` (supported natively on Node 18+ / 24+).
- **Execution Target**: Validates both the Worker application layer and local D1 SQLite database persistence.
- **Fail-Fast & Assertion Reporting**: Clearly prints individual test status, HTTP status codes, received responses, and a final summary box with exit code `0` on success and `1` on failure.

### 7.2 Test Tiers & Coverage Matrix

| Test ID | Tier | Target Endpoint | Description | Expected Status | Expected Assertion |
|---|---|---|---|---|---|
| **TC-01** | Tier 1 | `POST /api/auth/register` | Register new user with valid data | `201 Created` | `success: true`, `user_id` present, `access_token` present |
| **TC-02** | Tier 1 | `POST /api/auth/register` | Duplicate email registration | `400 Bad Request` | `error: "email_already_registered"` |
| **TC-03** | Tier 1 | `POST /api/auth/register` | Missing email in body | `400 Bad Request` | `error: "validation_failed"` |
| **TC-04** | Tier 1 | `POST /api/auth/register` | Short password (< 8 chars) | `400 Bad Request` | `error: "validation_failed"` |
| **TC-05** | Tier 1 | `POST /api/auth/register` | Malformed email address | `400 Bad Request` | `error: "validation_failed"` |
| **TC-06** | Tier 2 | `POST /api/auth/login` | Valid credentials login | `200 OK` | `success: true`, `access_token` returned |
| **TC-07** | Tier 2 | `POST /api/auth/login` | Wrong password | `401 Unauthorized` | `error: "invalid_credentials"` |
| **TC-08** | Tier 2 | `POST /api/auth/login` | Non-existent email | `401 Unauthorized` | `error: "invalid_credentials"` |
| **TC-09** | Tier 2 | `POST /api/auth/login` | Empty credentials | `400 Bad Request` | `error: "missing_credentials"` |
| **TC-10** | Tier 3 | `POST /api/auth/verify-token` | Valid token in JSON body | `200 OK` | `valid: true`, matching `user_id` |
| **TC-11** | Tier 3 | `POST /api/auth/verify-token` | Valid token in Bearer header | `200 OK` | `valid: true`, matching `user_id` |
| **TC-12** | Tier 3 | `POST /api/auth/verify-token` | Corrupted/tampered token string | `200 OK` | `valid: false` |
| **TC-13** | Tier 3 | `POST /api/auth/verify-token` | Expired token | `200 OK` | `valid: false` |
| **TC-14** | Tier 3 | `POST /api/auth/verify-token` | Missing token in request | `200 OK` | `valid: false` |
| **TC-15** | Tier 4 | `GET /api/users/me` | Authenticated user profile retrieval | `200 OK` | Matching user profile, default settings (`popup`, 20) |
| **TC-16** | Tier 4 | `GET /api/users/me` | Missing Authorization header | `401 Unauthorized` | `error: "unauthorized"` |
| **TC-17** | Tier 4 | `GET /api/users/me` | Invalid/garbage Bearer token | `401 Unauthorized` | `error: "unauthorized"` |
| **TC-18** | Tier 4 | `PUT /api/users/settings` | Update confirmation_mode to 'push' | `200 OK` | `settings.confirmation_mode: "push"` |
| **TC-19** | Tier 4 | `PUT /api/users/settings` | Update max_step_limit to 35 | `200 OK` | `settings.max_step_limit: 35` |
| **TC-20** | Tier 4 | `GET /api/users/me` | Verify settings persistence in D1 | `200 OK` | Settings reflect updated mode (`push`) and limit (35) |
| **TC-21** | Tier 4 | `PUT /api/users/settings` | Invalid confirmation_mode ('invalid') | `400 Bad Request` | `error: "invalid_input"` |
| **TC-22** | Tier 4 | `PUT /api/users/settings` | Invalid max_step_limit (-5) | `400 Bad Request` | `error: "invalid_input"` |
| **TC-23** | Tier 4 | `POST /api/auth/logout` | Client logout confirmation | `200 OK` | `success: true` |

### 7.3 Structure of `test_phase1.js`
The automated test runner should be organized as follows:
```javascript
/**
 * Hollis Backend Phase 1 Automated Verification Runner
 * Run: node test_phase1.js
 */

const BASE_URL = process.env.TEST_URL || 'http://127.0.0.1:8787';

let totalTests = 0;
let passedTests = 0;
let failedTests = 0;

async function assertTest(name, fn) {
  totalTests++;
  process.stdout.write(`  [TEST] ${name} ... `);
  try {
    await fn();
    passedTests++;
    console.log('\x1b[32mPASSED\x1b[0m');
  } catch (err) {
    failedTests++;
    console.log('\x1b[31mFAILED\x1b[0m');
    console.error(`    Error: ${err.message}`);
  }
}

async function runSuite() {
  console.log(`\n========================================`);
  console.log(`Hollis Backend Phase 1 Verification Suite`);
  console.log(`Target: ${BASE_URL}`);
  console.log(`========================================\n`);

  // Connectivity Pre-check
  try {
    await fetch(BASE_URL);
  } catch (err) {
    console.error(`\x1b[31mCannot connect to ${BASE_URL}. Ensure 'wrangler dev' is running.\x1b[0m\n`);
    process.exit(1);
  }

  // Tier 1: Auth Registration
  // Tier 2: Auth Login
  // Tier 3: Token Verification
  // Tier 4: User Profile & Settings
  // ... run all 23 test cases ...

  console.log(`\n========================================`);
  console.log(`Results: ${passedTests}/${totalTests} Passed (${failedTests} Failed)`);
  console.log(`========================================\n`);
  process.exit(failedTests > 0 ? 1 : 0);
}

runSuite();
```

---

## 8. Implementation Recommendations & Source Tree Layout

To cleanly separate concerns in `src/`, the following modular structure is recommended for implementation:

```
src/
├── worker.js             # Main router & request dispatcher (export default { fetch })
├── db/
│   └── queries.js        # D1 query helpers for users and user_settings
├── auth/
│   ├── crypto.js         # Web Crypto PBKDF2 hashing & verification
│   ├── jwt.js            # Web Crypto HMAC-SHA256 token sign & verify
│   └── middleware.js     # requireAuth middleware
├── routes/
│   ├── auth.js           # /api/auth/* handlers (register, login, verify-token, logout)
│   └── users.js          # /api/users/* handlers (get profile, update settings)
└── utils/
    └── response.js       # JSON success and error response constructors
```

### Wrangler Dev Execution Workflow
1. Apply local migrations:
   ```cmd
   cmd /c "npx wrangler d1 migrations apply hollis-db --local"
   ```
2. Start dev server:
   ```cmd
   cmd /c "npx wrangler dev --port 8787"
   ```
3. Run verification suite:
   ```cmd
   cmd /c "node test_phase1.js"
   ```
