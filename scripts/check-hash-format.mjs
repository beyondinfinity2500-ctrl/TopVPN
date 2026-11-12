/**
 * Structural check of ADMIN_PASSWORD_HASH in .dev.vars.
 * Prints only format info — never the hash value itself.
 *
 *   node scripts/check-hash-format.mjs
 */
import { readFileSync } from 'node:fs';

const line = readFileSync('.dev.vars', 'utf8')
  .split(/\r?\n/)
  .find((l) => l.startsWith('ADMIN_PASSWORD_HASH='));

if (!line) {
  console.log('ADMIN_PASSWORD_HASH: NOT FOUND in .dev.vars');
  process.exit(0);
}

let v = line.slice('ADMIN_PASSWORD_HASH='.length);
const rawLength = v.trim().length;
v = v.trim();
const hadQuotes = (v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"));
v = v.replace(/^["']|["']$/g, '');

console.log('present: yes');
console.log('value length (trimmed):', rawLength);
console.log('wrapped in quotes:', hadQuotes);
console.log('contains internal spaces:', /\s/.test(v));

const parts = v.split('.');
console.log('dot-separated parts:', parts.length);
console.log('iterations part:', parts[0] || '(missing)');

if (parts.length === 3) {
  for (const [i, name] of [[1, 'salt'], [2, 'hash']]) {
    const badChar = parts[i].match(/[^A-Za-z0-9_-]/);
    let bytes = '?';
    try {
      bytes = Buffer.from(parts[i], 'base64url').length;
    } catch {
      bytes = 'INVALID base64url';
    }
    console.log(
      `${name}: base64url-chars=${badChar === null} bytes=${bytes}` +
        (badChar ? ` BADCHAR at index ${badChar.index}: ${JSON.stringify(badChar[0])}` : ''),
    );
  }
  const saltOk = Buffer.from(parts[1], 'base64url').length === 16;
  const hashOk = Buffer.from(parts[2], 'base64url').length === 32;
  console.log(saltOk && hashOk ? 'FORMAT OK (expect generator default: 16-byte salt, 32-byte hash)' : 'FORMAT MISMATCH vs generator default (16B salt / 32B hash)');
}
