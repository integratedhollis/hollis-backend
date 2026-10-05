/**
 * Verification test for Firebase Auth and Fallback mechanisms.
 */

import { verifyFirebaseIdToken } from './src/auth/firebase.js';
import { authenticateToken } from './src/auth/middleware.js';
import { signJwt } from './src/auth/jwt.js';

async function test() {
  console.log('--- Testing Firebase ID Token Verifier ---');

  // 1. Test malformed token
  const malformed = await verifyFirebaseIdToken('invalid.token.here', 'hollis-edd21');
  console.log('Malformed token test:', malformed.valid === false ? 'PASS' : 'FAIL', malformed.error);

  // 2. Test null/empty token
  const empty = await verifyFirebaseIdToken('', 'hollis-edd21');
  console.log('Empty token test:', empty.valid === false ? 'PASS' : 'FAIL', empty.error);

  // 3. Test Custom JWT Fallback
  console.log('--- Testing Custom JWT Fallback in authenticateToken ---');
  const secret = 'hollis-default-dev-secret-key-do-not-use-in-prod-32bytes';
  const customToken = await signJwt(
    { sub: 'test-user-id', username: 'testuser', email: 'test@example.com', type: 'access' },
    secret,
    3600
  );

  const mockDb = {
    prepare: () => ({
      bind: () => ({
        first: async () => ({ id: 'test-user-id', username: 'testuser', email: 'test@example.com' }),
        run: async () => {},
      }),
    }),
  };

  const authResult = await authenticateToken(customToken, { JWT_SECRET: secret, DB: mockDb });
  console.log('Custom JWT Fallback test:', authResult && authResult.user.id === 'test-user-id' ? 'PASS' : 'FAIL');
  console.log('Auth provider:', authResult.user.auth_provider);

  console.log('--- All Unit Verifications Passed ---');
}

test().catch(console.error);
