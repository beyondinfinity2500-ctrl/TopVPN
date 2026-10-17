/**
 * Ingest-time image optimization via the Cloudflare Images binding.
 *
 * Advertiser uploads are validated, transcoded to a single optimized WebP and
 * stored in the private R2 bucket. Only successfully optimized output is ever
 * stored — an unoptimized original is never written to R2.
 *
 * Verified against @cloudflare/workers-types and the local (miniflare/sharp)
 * binding implementation:
 * - `info()` rejects undecodable bytes (production ImagesError 9412).
 * - `transform({fit:'scale-down'})` preserves aspect ratio and never upscales.
 * - `output({format, quality, anim})` returns `.image()` (ReadableStream).
 */
import type { Env } from './env';

/** Maximum output width. Taller/shorter images keep their aspect ratio. */
export const MAX_OUTPUT_WIDTH = 1600;

/** Output format is always WebP: universally supported and efficiently compressed. */
export const OUTPUT_FORMAT = 'image/webp' as const;
export const OUTPUT_QUALITY = 80;

export type CreativeStatus = 'pending' | 'ready' | 'failed';

export interface OptimizedCreative {
  kind: 'ready';
  /** Optimized WebP bytes, for `env.CREATIVES.put()`. */
  bytes: Uint8Array;
  contentType: string;
  width: number;
  height: number;
}

/**
 * Failure classification, so callers can decide between rejecting the upload
 * (the file is invalid) and keeping the order with a failed creative
 * (the file was fine but the optimization service was unavailable/over quota).
 */
export type OptimizeFailure =
  | { kind: 'invalid'; error: string }
  | { kind: 'unavailable'; error: string };

export type OptimizeResult = OptimizedCreative | OptimizeFailure;

function asStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body as ReadableStream<Uint8Array>;
}

/**
 * True only for a genuine optimization-service failure (over quota or
 * unavailable), where the file itself is valid and a retry can succeed.
 *
 * Classification reads ImagesError.code, never the message: the local binding
 * wraps every error in a generic "Unexpected error response 500" string, so
 * message matching cannot work. Probe-verified error codes:
 *   - 9422 = quota exceeded (documented; the only service-failure code)
 *   - 9523 = corrupt input, seen locally (9412 in production)
 * Any other numeric code is treated as an invalid upload, so the customer is
 * asked to re-upload rather than the order silently sitting in retry state.
 */
function isServiceFailure(err: unknown): boolean {
  let cursor: unknown = err;
  for (let depth = 0; depth < 5 && cursor; depth++) {
    if (typeof cursor === 'object' && cursor !== null) {
      const code = (cursor as { code?: unknown }).code;
      if (code === 9422) return true;
      if (typeof code === 'number') return false;
    }
    cursor = (cursor as { cause?: unknown }).cause;
  }
  // No code available (e.g. a plain network Error): assume a transient service
  // fault and keep the order for the admin to retry.
  const message = err instanceof Error ? err.message : String(err);
  return !/corrupt|invalid|not an image|unsupported/i.test(message);
}

/**
 * Runs the single transformation and reports exact output dimensions computed
 * from the source: `fit: 'scale-down'` caps width at MAX_OUTPUT_WIDTH, never
 * upscales, and preserves the aspect ratio exactly.
 */
async function transformToWebp(env: Env, bytes: Uint8Array): Promise<OptimizedCreative> {
  const info = await env.IMAGES.info(asStream(bytes));

  // SVG reports { format: 'image/svg+xml' } with no dimensions; Images never
  // resizes it and our allowlist excludes it, so treat it as invalid input.
  if (!('width' in info) || !('height' in info)) {
    throw new Error('unsupported-format');
  }

  const result = await env.IMAGES.input(asStream(bytes))
    .transform({ width: MAX_OUTPUT_WIDTH, fit: 'scale-down' })
    .output({ format: OUTPUT_FORMAT, quality: OUTPUT_QUALITY, anim: false });

  // Materialize the optimized bytes before storage: the binding's output stream
  // is single-use and R2 needs a re-readable source on a retry.
  const optimized = new Uint8Array(await new Response(result.image()).arrayBuffer());
  if (optimized.byteLength === 0) throw new Error('empty-output');

  const width = Math.min(info.width, MAX_OUTPUT_WIDTH);
  const height = Math.round((info.height * width) / info.width);

  return { kind: 'ready', bytes: optimized, contentType: OUTPUT_FORMAT, width, height };
}

/**
 * Validates, resizes and optimizes an uploaded creative.
 *
 * Returns `{kind:'invalid'}` for corrupt/animated/unsupported files — callers
 * reject the submission with HTTP 400 and never create an order or R2 object.
 * Returns `{kind:'unavailable'}` when the file is valid but the Images service
 * could not produce output (over quota or unavailable) — callers keep the order
 * with a failed creative status and no R2 object.
 */
export async function optimizeCreative(env: Env, bytes: Uint8Array): Promise<OptimizeResult> {
  try {
    return await transformToWebp(env, bytes);
  } catch (err) {
    if (isServiceFailure(err)) {
      return {
        kind: 'unavailable',
        error: 'Image optimization is temporarily unavailable. Your order was saved and our team will process the creative.',
      };
    }
    return {
      kind: 'invalid',
      error: 'The image could not be processed. Please upload a valid static PNG, JPEG or WebP file.',
    };
  }
}
