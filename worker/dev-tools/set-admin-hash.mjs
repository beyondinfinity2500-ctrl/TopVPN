/**
 * Sets ADMIN_PASSWORD_HASH in .dev.vars without any manual copying
 * (a truncated copy is invisible to the eye and breaks login forever).
 *
 *   node worker/dev-tools/set-admin-hash.mjs
 *
 * Then, for the live Worker, paste the value from .dev.vars into:
 *   npx wrangler secret put ADMIN_PASSWORD_HASH --config wrangler.ads.jsonc
 *
 * The password is prompted with muted input and is never printed or stored.
 */
import { createInterface } from 'node:readline';
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

const ITERATIONS = 100_000;
const FILE = '.dev.vars';

const rl = createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: process.stdin.isTTY === true,
});
// Mute typed characters (TTY only; piped input has no _writeToOutput).
rl.output.mute = false;
if (typeof rl._writeToOutput === 'function') {
  const origWrite = rl._writeToOutput.bind(rl);
  rl._writeToOutput = (s) => { if (!rl.output.mute) origWrite(s); };
}

// Line queue instead of question(): fast/piped input can deliver both lines
// before a second question() is registered, which would hang forever.
const pending = [];
let waiter = null;
rl.on('line', (l) => { if (waiter) { const w = waiter; waiter = null; w(l); } else pending.push(l); });
rl.on('close', () => { if (waiter) { const w = waiter; waiter = null; w(null); } });
const nextLine = () => (pending.length ? Promise.resolve(pending.shift()) : new Promise((r) => { waiter = r; }));

process.stdout.write('New admin password (min 10 chars, input hidden): ');
const password = (await nextLine())?.trim();
process.stdout.write('\nRepeat the same password: ');
const again = (await nextLine())?.trim();
process.stdout.write('\n');
rl.close();

if (password == null || again == null) {
  console.error('Not enough input: type the password, Enter, then repeat it.');
  process.exit(1);
}
if (password.length < 10) {
  console.error('Too short: choose at least 10 characters.');
  process.exit(1);
}
if (password !== again) {
  console.error('Passwords do not match.');
  process.exit(1);
}

const salt = randomBytes(16);
const hash = pbkdf2Sync(password, salt, ITERATIONS, 32, 'sha256');
const encoded = `${ITERATIONS}.${salt.toString('base64url')}.${hash.toString('base64url')}`;

// Sanity gate: the value must decode to 16B salt + 32B hash before it is saved.
const [, s, h] = encoded.split('.');
if (Buffer.from(s, 'base64url').length !== 16 || Buffer.from(h, 'base64url').length !== 32) {
  console.error('Internal error: generated hash failed format check; nothing was written.');
  process.exit(1);
}

let raw;
try {
  raw = readFileSync(FILE, 'utf8');
} catch {
  raw = '';
}
const line = `ADMIN_PASSWORD_HASH=${encoded}`;
raw = /^ADMIN_PASSWORD_HASH=.*$/m.test(raw)
  ? raw.replace(/^ADMIN_PASSWORD_HASH=.*$/m, line)
  : raw.replace(/\s*$/, '') + (raw ? '\n' : '') + line + '\n';
writeFileSync(FILE, raw);

// Full end-to-end check: derive with WebCrypto (same as worker/auth.ts) and compare.
const [it, s2, h2] = readFileSync(FILE, 'utf8').match(/^ADMIN_PASSWORD_HASH=(.*)$/m)[1].trim().split('.');
const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
const bits = new Uint8Array(await crypto.subtle.deriveBits(
  { name: 'PBKDF2', salt: Buffer.from(s2, 'base64url'), iterations: Number(it), hash: 'SHA-256' },
  key,
  256,
));
const expected = new Uint8Array(Buffer.from(h2, 'base64url'));
const ok = bits.length === expected.length && bits.every((b, i) => b === expected[i]);

console.log(ok
  ? 'OK: new hash written to .dev.vars and VERIFIED against the password you typed.'
  : 'FAIL: verification mismatch — nothing else changed, run again.');
process.exit(ok ? 0 : 1);
