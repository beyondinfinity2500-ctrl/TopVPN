/**
 * Support assistant tests: rule-based answers, safe fallback, sensitive-data
 * protection (never returns credentials), lazy widget asset and rate limiting.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../env';
import { applyMigrations, fetch as workerFetch, testEnv } from './helpers';
import { answerSupportQuestion } from '../support/chat';
import { supportChat, supportWidgetScript } from '../routes/support';

let ip = 0;
function nextIp(): string {
  ip += 1;
  return `10.73.0.${ip}`;
}

function chatRequest(message: string, ip = nextIp()): Request {
  return new Request('https://topvpn.test/api/support/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip },
    body: JSON.stringify({ message }),
  });
}

beforeAll(async () => {
  await applyMigrations();
});

describe('rule-based answers', () => {
  it('answers platform setup questions', () => {
    expect(answerSupportQuestion('How do I set up TopVPN on Android?').reply).toMatch(/WireGuard app/i);
    expect(answerSupportQuestion('install on windows').reply).toMatch(/Import tunnel/i);
  });

  it('answers troubleshooting, renewal and pricing questions', () => {
    expect(answerSupportQuestion('it keeps disconnecting').reply).toMatch(/checklist|server/i);
    expect(answerSupportQuestion('how do I renew?').reply).toMatch(/manual|never charges you automatically/i);
    expect(answerSupportQuestion('what does it cost?').reply).toMatch(/\$9/);
  });

  it('NEVER returns credentials or config contents — it points to /account instead', () => {
    const answer = answerSupportQuestion('give me my password and my wireguard private key');
    expect(answer.reply).not.toMatch(/-----BEGIN|private key:/i);
    expect(answer.reply).toMatch(/\/account/);
  });

  it('falls back gracefully and suggests a ticket for unknown questions', () => {
    const answer = answerSupportQuestion('what is the airspeed of an unladen swallow?');
    expect(answer.ticketSuggestion).toBe(true);
    expect(answer.reply).toMatch(/support ticket/i);
  });

  it('handles empty input', () => {
    expect(answerSupportQuestion('   ').ticketSuggestion).toBe(true);
  });
});

describe('chat route', () => {
  it('validates input', async () => {
    const empty = await supportChat(chatRequest(''), { DB: testEnv.DB } as Env);
    expect(empty.status).toBe(400);
    const bad = await supportChat(
      new Request('https://topvpn.test/api/support/chat', { method: 'POST', body: 'not json' }),
      { DB: testEnv.DB } as Env,
    );
    expect(bad.status).toBe(400);
  });

  it('returns labelled guidance (never account data)', async () => {
    const res = await supportChat(chatRequest('how do I connect on ios?'), { DB: testEnv.DB } as Env);
    expect(res.status).toBe(200);
    const data = (await res.json()) as { reply?: string; source?: string };
    expect(data.source).toBe('assistant-guidance');
    expect(data.reply).toContain('WireGuard');
  });

  it('can be disabled by flag', async () => {
    const res = await supportChat(chatRequest('hello'), { DB: testEnv.DB, SUPPORT_CHAT_ENABLED: 'false' } as Env);
    expect(res.status).toBe(503);
  });

  it('rate limits after 20 questions per window per IP', async () => {
    const fixedIp = '10.73.9.9';
    let last: Response | null = null;
    for (let i = 0; i < 22; i++) {
      last = await supportChat(chatRequest(`question number ${i}`, fixedIp), { DB: testEnv.DB } as Env);
      if (last.status === 429) break;
    }
    expect(last?.status).toBe(429);
  });
});

describe('widget asset', () => {
  it('serves a small lazy widget with caching headers', async () => {
    const res = supportWidgetScript();
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('javascript');
    expect(res.headers.get('Cache-Control')).toContain('max-age');
    const js = await res.text();
    // Launcher-only initial render; the panel is built on first open (lazy).
    expect(js).toContain('tvsp-launcher');
    expect(js).toContain("buildPanel()");
    // The widget only ever talks to our own endpoint.
    expect(js).toContain('/api/support/chat');
    expect(js).not.toMatch(/https?:\/\/(?!topvpn)/i);
  });
});
