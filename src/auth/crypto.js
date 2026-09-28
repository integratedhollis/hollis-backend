/**
 * Web Crypto API-based password hashing and verification using PBKDF2-SHA256.
 * Zero external or Node.js binary dependencies. Compatible with Cloudflare Workers.
 */

const textEncoder = new TextEncoder();

/**
 * Hashes a plaintext password using PBKDF2 with SHA-256.
 *
 * @param {string} password - The plaintext password to hash
 * @returns {Promise<string>} Stored format: `pbkdf2_sha256:100000:<salt_hex>:<hash_hex>`
 */
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('Password must be a non-empty string.');
  }

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
      hash: 'SHA-256',
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

/**
 * Verifies a plaintext password against a stored PBKDF2-SHA256 hash string.
 * Performs constant-time comparison to prevent timing attacks.
 *
 * @param {string} password - Plaintext password to verify
 * @param {string} storedHash - Stored hash string in `pbkdf2_sha256:<iterations>:<salt_hex>:<hash_hex>` format
 * @returns {Promise<boolean>} True if password matches, false otherwise
 */
export async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string' || !storedHash) {
    return false;
  }

  const parts = storedHash.split(':');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') {
    return false;
  }

  const iterations = parseInt(parts[1], 10);
  const saltHex = parts[2];
  const originalHashHex = parts[3];

  if (isNaN(iterations) || iterations < 10000 || saltHex.length !== 32 || originalHashHex.length !== 64) {
    return false;
  }

  const saltMatches = saltHex.match(/.{1,2}/g);
  const originalMatches = originalHashHex.match(/.{1,2}/g);
  if (!saltMatches || !originalMatches) {
    return false;
  }

  const salt = new Uint8Array(saltMatches.map(byte => parseInt(byte, 16)));
  const originalBytes = new Uint8Array(originalMatches.map(byte => parseInt(byte, 16)));

  try {
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
        hash: 'SHA-256',
      },
      keyMaterial,
      256
    );

    const derivedBytes = new Uint8Array(derivedBits);
    if (derivedBytes.length !== originalBytes.length) {
      return false;
    }

    // Constant-time byte-by-byte comparison
    let diff = 0;
    for (let i = 0; i < derivedBytes.length; i++) {
      diff |= derivedBytes[i] ^ originalBytes[i];
    }
    return diff === 0;
  } catch {
    return false;
  }
}
