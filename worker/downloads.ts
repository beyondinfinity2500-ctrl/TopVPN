/**
 * White-label installer downloads.
 *
 * Cloudflare caps static assets at 25 MiB per file, so the 50-80 MB
 * installers are served from the `topvpn-downloads` R2 bucket
 * (binding DOWNLOADS) at the same /downloads/<file> URLs. Small files can
 * still ship as regular assets — this route only runs when no asset matches.
 *
 * Keep the allowlist in sync with the brandedApps list in src/pages/apps.astro.
 */

const DOWNLOADS = new Set([
  'TOPVPN.TOP-Windows.exe',
  'TOPVPN.TOPApple-Mac.dmg',
  'TOPVPN.TOP-Linux.run',
  'TOPVPN.TOPFirestick-Android_TV.apk',
]);

const MIME: Record<string, string> = {
  '.exe': 'application/octet-stream',
  '.dmg': 'application/octet-stream',
  '.run': 'application/octet-stream',
  '.apk': 'application/vnd.android.package-archive',
};

export interface DownloadEnv {
  DOWNLOADS?: R2Bucket;
}

/** Exported for tests. Returns the exact bucket key or null. */
export function resolveDownloadKey(name: string): string | null {
  return DOWNLOADS.has(name) ? name : null;
}

function fileHeaders(key: string, size: number, range?: { start: number; end: number }): HeadersInit {
  const ext = key.slice(key.lastIndexOf('.'));
  const partial = range !== undefined;
  const headers: Record<string, string> = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${key}"`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'public, max-age=86400',
  };
  if (partial && range) {
    headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`;
  } else {
    headers['Content-Length'] = String(size);
  }
  return headers;
}

export async function downloadRoute(request: Request, env: DownloadEnv, name: string): Promise<Response> {
  const key = resolveDownloadKey(name);
  if (!key) return new Response('Not found', { status: 404 });
  const bucket = env.DOWNLOADS;
  if (!bucket) return new Response('Downloads not configured', { status: 503 });

  const head = await bucket.head(key);
  if (!head) return new Response('Not found', { status: 404 });

  // Byte ranges keep 50-80 MB downloads resumable for browsers/managers.
  const match = request.headers.get('Range')?.match(/^bytes=(\d+)-(\d*)$/);
  if (match) {
    const start = Number(match[1]);
    const end = Math.min(Number(match[2]) || head.size - 1, head.size - 1);
    if (start >= head.size || start > end) {
      return new Response('Range not satisfiable', { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    }
    const obj = await bucket.get(key, { range: { offset: start, length: end - start + 1 } });
    if (!obj) return new Response('Not found', { status: 404 });
    return new Response(obj.body, { status: 206, headers: fileHeaders(key, head.size, { start, end }) });
  }

  const obj = await bucket.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, { status: 200, headers: fileHeaders(key, head.size) });
}
