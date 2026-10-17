/**
 * Generates the ADMIN_PASSWORD_HASH secret for the advertising admin.
 *
 *   node worker/dev-tools/hash-password.mjs [password]
 *
 * Then: npx wrangler secret put ADMIN_PASSWORD_HASH --config wrangler.ads.jsonc
 * (paste the printed hash; the password itself is never stored anywhere).
 */
import { pbkdf2Sync, randomBytes } from 'node:crypto';

const ITERATIONS = 100_000;
const password = process.argv[2];

if (!password) {
  console.error('Usage: node worker/dev-tools/hash-password.mjs <password>');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Choose a password of at least 10 characters.');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const encoded = `${ITERATIONS}.${salt.toString('base64url')}.${hash.toString('base64url')}`;

console.error('Hash written below (this value goes in the ADMIN_PASSWORD_HASH secret):');
console.log(encoded);
