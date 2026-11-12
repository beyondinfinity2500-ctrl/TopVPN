/**
 * Installer download route tests: allowlist enforcement, R2 streaming,
 * range requests, and graceful behavior without the DOWNLOADS binding.
 * R2 is stubbed — the route only calls head() and get().
 */
import { describe, expect, it } from 'vitest';
import { downloadRoute, resolveDownloadKey } from '../downloads';
import type { DownloadEnv } from '../downloads';

interface HeadCall { key: string }
interface GetCall { key: string; range?: { offset: number; length: number } }

function stubR2(size: number, calls: { heads: HeadCall[]; gets: GetCall[] }) {
  return {
    async head(key: string) {
      calls.heads.push({ key });
      return { size } as unknown as R2Object;
    },
    async get(key: string, opts?: { range?: { offset: number; length: number } }) {
      calls.gets.push({ key, range: opts?.range });
      return { body: 'DATA', size } as unknown as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

function request(headers: Record<string, string> = {}): Request {
  return new Request('https://topvpn.test/downloads/TOPVPN.TOP-Windows.exe', { headers });
}

describe('resolveDownloadKey', () => {
  it('accepts exactly the published installers', () => {
    expect(resolveDownloadKey('TOPVPN.TOP-Windows.exe')).toBe('TOPVPN.TOP-Windows.exe');
    expect(resolveDownloadKey('TOPVPN.TOPApple-Mac.dmg')).toBe('TOPVPN.TOPApple-Mac.dmg');
    expect(resolveDownloadKey('TOPVPN.TOP-Linux.run')).toBe('TOPVPN.TOP-Linux.run');
    expect(resolveDownloadKey('TOPVPN.TOPFirestick-Android_TV.apk')).toBe('TOPVPN.TOPFirestick-Android_TV.apk');
  });

  it('rejects traversal and unknown files', () => {
    expect(resolveDownloadKey('../.dev.vars')).toBeNull();
    expect(resolveDownloadKey('topvpn-windows.exe')).toBeNull();
    expect(resolveDownloadKey('anything.zip')).toBeNull();
  });
});

describe('downloadRoute', () => {
  it('streams the object with attachment headers', async () => {
    const calls = { heads: [] as HeadCall[], gets: [] as GetCall[] };
    const env: DownloadEnv = { DOWNLOADS: stubR2(80 * 1024 * 1024, calls) };
    const res = await downloadRoute(request(), env, 'TOPVPN.TOP-Windows.exe');
    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Disposition')).toContain('TOPVPN.TOP-Windows.exe');
    expect(res.headers.get('Content-Length')).toBe(String(80 * 1024 * 1024));
    expect(res.headers.get('Accept-Ranges')).toBe('bytes');
    expect(calls.gets[0]?.key).toBe('TOPVPN.TOP-Windows.exe');
  });

  it('serves byte ranges as 206 with Content-Range', async () => {
    const calls = { heads: [] as HeadCall[], gets: [] as GetCall[] };
    const env: DownloadEnv = { DOWNLOADS: stubR2(1000, calls) };
    const res = await downloadRoute(request({ Range: 'bytes=100-199' }), env, 'TOPVPN.TOP-Linux.run');
    expect(res.status).toBe(206);
    expect(res.headers.get('Content-Range')).toBe('bytes 100-199/1000');
    expect(calls.gets[0]?.range).toEqual({ offset: 100, length: 100 });
  });

  it('returns 416 for an out-of-bounds range', async () => {
    const env: DownloadEnv = { DOWNLOADS: stubR2(1000, { heads: [], gets: [] }) };
    const res = await downloadRoute(request({ Range: 'bytes=2000-3000' }), env, 'TOPVPN.TOP-Linux.run');
    expect(res.status).toBe(416);
  });

  it('returns 404 for unknown names and missing objects, 503 without binding', async () => {
    const env: DownloadEnv = { DOWNLOADS: stubR2(10, { heads: [], gets: [] }) };
    expect((await downloadRoute(request(), env, 'not-on-list.exe')).status).toBe(404);
    expect((await downloadRoute(request(), {}, 'TOPVPN.TOP-Windows.exe')).status).toBe(503);
  });
});
