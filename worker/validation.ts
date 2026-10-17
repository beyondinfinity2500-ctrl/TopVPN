/**
 * Server-side validation for advertising orders.
 *
 * Every field that arrives from the client is validated here; the price is
 * never accepted from the client (see worker/routes/api.ts -> createOrder).
 */
import {
  AD_COPY_MAX,
  AD_COPY_MIN,
  ALLOWED_IMAGE_EXTENSIONS,
  ALLOWED_IMAGE_MIME,
  DESTINATION_URL_MAX,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_BYTES_LABEL,
  isCreativeFormat,
  isDuration,
  isPlacement,
} from '../src/lib/ads/pricing';

export type FieldErrors = Record<string, string>;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i;

/** Allowed image magic-number prefixes, keyed by canonical extension family. */
const MAGIC_BYTES: Record<string, number[][]> = {
  png: [[0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]],
  jpg: [[0xff, 0xd8, 0xff]],
  webp: [[0x52, 0x49, 0x46, 0x46, 0x57, 0x45, 0x42, 0x50]], // RIFF....WEBP
};

export function isValidEmail(value: string): boolean {
  return typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value.trim());
}

/**
 * Normalises a user-supplied website to a full https?:// URL and validates it.
 * Returns null when the value cannot be a safe http(s) URL.
 */
export function normalizeWebsite(raw: string): string | null {
  const value = (raw || '').trim();
  if (!value || value.length > 2048) return null;
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withScheme);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (!url.hostname.includes('.')) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** Destination URL for text ads: http(s) only, no javascript:/data: schemes. */
export function isValidDestinationUrl(raw: string): boolean {
  const value = (raw || '').trim();
  if (!value || value.length > DESTINATION_URL_MAX) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

export function fileExtension(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  return i < 0 ? '' : fileName.slice(i + 1).toLowerCase();
}

export function extensionForMime(mime: string): string | null {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/jpeg':
      return 'jpg';
    case 'image/webp':
      return 'webp';
    default:
      return null;
  }
}

/**
 * Verifies a claimed extension against the file's actual magic bytes.
 * The client-provided MIME type is never trusted on its own.
 */
export function checkImageSignature(bytes: Uint8Array, extension: string): boolean {
  const family = extension === 'jpeg' ? 'jpg' : extension;
  const prefixes = MAGIC_BYTES[family];
  if (!prefixes) return false;
  return prefixes.some((prefix) => {
    if (bytes.length < prefix.length) return false;
    // WebP: 4 size bytes sit between "RIFF" and "WEBP" (offsets 4..7 skipped).
    if (family === 'webp') {
      if (bytes.length < 12) return false;
      const head = [0x52, 0x49, 0x46, 0x46];
      const tail = [0x57, 0x45, 0x42, 0x50];
      return head.every((b, i) => bytes[i] === b) && tail.every((b, i) => bytes[i + 8] === b);
    }
    return prefix.every((b, i) => bytes[i] === b);
  });
}

export interface ParsedOrderInput {
  name: string;
  email: string;
  website: string;
  placement: string;
  duration: string;
  format: string;
  terms: string;
  copy?: string;
  destinationUrl?: string;
  honeypot?: string;
}

export interface ValidatedOrder {
  name: string;
  email: string;
  website: string;
  placement: 'header' | 'incontent' | 'footer' | 'fullsite';
  duration: 1 | 3 | 6 | 12;
  format: 'text' | 'image';
  copy: string | null;
  destinationUrl: string | null;
}

/**
 * Validates the non-file part of an order. Returns { ok, value, errors }.
 * The creative file is validated separately (see validateImageFile).
 */
export function validateOrderInput(input: ParsedOrderInput): {
  ok: boolean;
  value?: ValidatedOrder;
  errors?: FieldErrors;
} {
  const errors: FieldErrors = {};

  // Honeypot: must stay empty (bots tend to fill hidden fields).
  if (input.honeypot && input.honeypot.trim() !== '') {
    return { ok: false, errors: { form: 'Submission rejected.' } };
  }

  const name = (input.name || '').trim();
  if (name.length < 2 || name.length > 100) errors.name = 'Please enter your name (2–100 characters).';

  const email = (input.email || '').trim();
  if (!isValidEmail(email)) errors.email = 'Please enter a valid email address.';

  const website = normalizeWebsite(input.website || '');
  if (!website) errors.website = 'Please enter a valid website URL (e.g. https://example.com).';

  if (!isPlacement(input.placement)) errors.placement = 'Please choose an advertising placement.';

  const duration = Number(input.duration);
  if (!isDuration(duration)) errors.duration = 'Please choose a contract duration.';

  if (!isCreativeFormat(input.format)) errors.format = 'Please choose a creative format.';

  const accepted = input.terms === 'on' || input.terms === 'true' || input.terms === '1';
  if (!accepted) errors.terms = 'You must accept the advertising terms and refund policy.';

  const format = isCreativeFormat(input.format) ? (input.format as 'text' | 'image') : null;

  let copy: string | null = null;
  let destinationUrl: string | null = null;
  if (format === 'text') {
    const text = (input.copy || '').trim();
    if (text.length < AD_COPY_MIN || text.length > AD_COPY_MAX) {
      errors.copy = `Advertising copy must be between ${AD_COPY_MIN} and ${AD_COPY_MAX} characters.`;
    } else {
      copy = text;
    }
    if (!isValidDestinationUrl(input.destinationUrl || '')) {
      errors.destinationUrl = 'Please enter a valid destination URL (https://...).';
    } else {
      destinationUrl = (input.destinationUrl as string).trim();
    }
  }

  if (Object.keys(errors).length > 0) return { ok: false, errors };

  return {
    ok: true,
    value: {
      name,
      email,
      website: website as string,
      placement: input.placement as 'header' | 'incontent' | 'footer' | 'fullsite',
      duration: duration as 1 | 3 | 6 | 12,
      format: format as 'text' | 'image',
      copy,
      destinationUrl,
    },
  };
}

export interface ImageCheck {
  ok: boolean;
  error?: string;
  extension?: string;
}

/**
 * Detects animated images from the raw bytes, per format.
 *
 * The Images binding's `anim:false` would silently keep only the first frame;
 * the terms instead require rejecting animation outright. GIF is already
 * excluded by the extension/MIME allowlist, so only WebP and PNG need scanning.
 */
export function isAnimatedImage(bytes: Uint8Array, family: string): boolean {
  if (family === 'webp') {
    // RIFF....WEBP then chunks: FourCC(4) + size(4, LE) + payload (padded).
    let i = 12;
    while (i + 8 <= bytes.length) {
      const fourcc = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
      if (fourcc === 'ANIM' || fourcc === 'ANMF') return true;
      const size = bytes[i + 4] | (bytes[i + 5] << 8) | (bytes[i + 6] << 16) | (bytes[i + 7] << 24);
      i += 8 + size + (size % 2); // chunks are padded to even offsets
    }
    return false;
  }
  if (family === 'png') {
    // 8-byte signature, then chunks: type(4) + length(4, BE) + data + CRC(4).
    let i = 8;
    while (i + 8 <= bytes.length) {
      const type = String.fromCharCode(bytes[i], bytes[i + 1], bytes[i + 2], bytes[i + 3]);
      if (type === 'acTL') return true; // APNG animation control chunk
      const length = (bytes[i + 4] << 24) | (bytes[i + 5] << 16) | (bytes[i + 6] << 8) | bytes[i + 7];
      i += 12 + length;
    }
    return false;
  }
  return false;
}

/** Validates an uploaded creative: extension, MIME, size and magic bytes. */
export function validateImageFile(args: {
  fileName: string;
  mimeType: string;
  bytes: Uint8Array;
}): ImageCheck {
  const { fileName, mimeType, bytes } = args;

  if (!fileName) return { ok: false, error: 'No image file was uploaded.' };
  if (bytes.byteLength === 0) return { ok: false, error: 'The uploaded image is empty.' };
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `Image is larger than the ${MAX_IMAGE_BYTES_LABEL} limit (received ${Math.max(1, Math.round(bytes.byteLength / 1024 / 1024))} MB).`,
    };
  }

  const ext = fileExtension(fileName);
  if (!(ALLOWED_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    return { ok: false, error: `Unsupported file type. Allowed: ${ALLOWED_IMAGE_EXTENSIONS.join(', ')}.` };
  }
  if (!(ALLOWED_IMAGE_MIME as readonly string[]).includes(mimeType)) {
    return { ok: false, error: `Unsupported MIME type. Allowed: ${ALLOWED_IMAGE_MIME.join(', ')}.` };
  }

  // Declared MIME must agree with the extension family, and the bytes must
  // actually be that format.
  const mimeExt = extensionForMime(mimeType);
  const mimeFamily = mimeExt === 'jpeg' ? 'jpg' : mimeExt;
  const extFamily = ext === 'jpeg' ? 'jpg' : ext;
  if (mimeFamily !== extFamily) {
    return { ok: false, error: 'The file extension does not match its declared type.' };
  }
  if (!checkImageSignature(bytes, extFamily)) {
    return { ok: false, error: 'The file contents do not match the declared image format.' };
  }

  return { ok: true, extension: ext };
}
