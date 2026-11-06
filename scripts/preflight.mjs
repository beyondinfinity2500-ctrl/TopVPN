#!/usr/bin/env node
/**
 * TopVPN — local sandbox preflight check.
 * Reports which required env vars are present/missing without exposing values.
 * Usage: node scripts/preflight.mjs
 */
import { readFileSync } from 'node:fs';

const ENV_FILE = '.dev.vars';

function parseEnv(path) {
  const out = {};
  try {
    const lines = readFileSync(path, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch {}
  return out;
}

const env = parseEnv(ENV_FILE);

const required = [
  { name: 'STRIPE_SECRET_KEY', check: (v) => v.startsWith('sk_test_'), hint: 'must start with sk_test_' },
  { name: 'STRIPE_VPN_WEBHOOK_SECRET', check: (v) => v.startsWith('whsec_'), hint: 'must start with whsec_' },
  { name: 'VPN_SANDBOX_CHECKOUT_ENABLED', check: (v) => v === 'true', hint: 'must be "true"' },
  { name: 'VPN_SALES_ENABLED', check: (v) => v === 'true', hint: 'must be "true"' },
  { name: 'VPN_CUSTOMER_AUTH_ENABLED', check: (v) => v === 'true', hint: 'must be "true"' },
  { name: 'VPN_PROVISIONING_SECRET', check: (v) => v.length >= 16, hint: 'must be 16+ chars' },
  { name: 'ADMIN_PASSWORD_HASH', check: (v) => v.length > 0, hint: 'generate with: node worker/dev-tools/hash-password.mjs' },
  { name: 'VPNRESELLERS_API_TOKEN', check: (v) => v.length > 0, hint: 'from VPNResellers dashboard' },
  { name: 'VPNRESELLERS_PROJECT_ID', check: (v) => v.length > 0, hint: 'from VPNResellers dashboard' },
  { name: 'RESEND_API_KEY', check: (v) => v.startsWith('re_'), hint: 'must start with re_' },
  { name: 'CUSTOMER_EMAIL_FROM', check: (v) => v.includes('@'), hint: 'must be a verified sender address' },
  { name: 'SESSION_SECRET', check: (v) => v.length >= 16, hint: 'any long random string' },
];

let allOk = true;
console.log('TopVPN Sandbox Preflight Check');
console.log('=============================');
console.log(`Env file: ${ENV_FILE}`);
console.log('');

for (const { name, check, hint } of required) {
  const val = env[name] || '';
  if (!val) {
    console.log(`  MISSING  ${name}`);
    console.log(`           -> ${hint}`);
    allOk = false;
  } else if (!check(val)) {
    console.log(`  INVALID  ${name}`);
    console.log(`           -> ${hint}`);
    allOk = false;
  } else {
    console.log(`  OK       ${name}`);
  }
}

// Check Stripe key is test mode
const sk = env['STRIPE_SECRET_KEY'] || '';
if (sk && sk.startsWith('sk_live_')) {
  console.log('');
  console.log('  WARNING: STRIPE_SECRET_KEY appears to be a LIVE key. Use sk_test_ only.');
  allOk = false;
}

console.log('');
if (allOk) {
  console.log('All required variables are present and valid. Sandbox ready.');
  process.exit(0);
} else {
  console.log('Some variables are missing or invalid. See above.');
  process.exit(1);
}
