import { describe, expect, it } from 'vitest';
import {
  checkImageSignature,
  extensionForMime,
  fileExtension,
  isAnimatedImage,
  isValidDestinationUrl,
  isValidEmail,
  normalizeWebsite,
  validateImageFile,
  validateOrderInput,
} from '../validation';
import { fixtureBytes } from './helpers';

const PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
]);
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const WEBP = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x1a, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50, 0x56, 0x50, 0x38, 0x4c,
]);

describe('contact field validation', () => {
  it('accepts well-formed emails and rejects malformed ones', () => {
    expect(isValidEmail('advertiser@example.com')).toBe(true);
    expect(isValidEmail('a.b+c@sub.example.co')).toBe(true);
    expect(isValidEmail('not-an-email')).toBe(false);
    expect(isValidEmail('missing@domain')).toBe(false);
    expect(isValidEmail('spaces in@example.com')).toBe(false);
    expect(isValidEmail('')).toBe(false);
  });

  it('normalises websites and rejects non-http(s) schemes', () => {
    expect(normalizeWebsite('example.com')).toBe('https://example.com/');
    expect(normalizeWebsite('http://example.com/path')).toBe('http://example.com/path');
    expect(normalizeWebsite('javascript:alert(1)')).toBeNull();
    expect(normalizeWebsite('')).toBeNull();
    expect(normalizeWebsite('localhost')).toBeNull();
  });

  it('only allows http(s) destination URLs', () => {
    expect(isValidDestinationUrl('https://example.com/landing')).toBe(true);
    expect(isValidDestinationUrl('data:text/html,<script>1</script>')).toBe(false);
    expect(isValidDestinationUrl('javascript:alert(1)')).toBe(false);
    expect(isValidDestinationUrl('')).toBe(false);
  });
});

describe('order input validation', () => {
  const base = {
    name: 'Jane Advertiser',
    email: 'jane@example.com',
    website: 'https://example.com',
    placement: 'header',
    duration: '3',
    format: 'text',
    terms: 'on',
    copy: 'Privacy-first VPN with a 30-day money-back guarantee.',
    destinationUrl: 'https://example.com/offer',
  };

  it('accepts a valid text order', () => {
    const result = validateOrderInput(base);
    expect(result.ok).toBe(true);
    expect(result.value).toMatchObject({
      placement: 'header',
      duration: 3,
      format: 'text',
      copy: base.copy,
      destinationUrl: base.destinationUrl,
    });
  });

  it('rejects every missing required field', () => {
    for (const field of ['name', 'email', 'website', 'placement', 'duration', 'format', 'terms']) {
      const input = { ...base, [field]: '' };
      const result = validateOrderInput(input);
      expect(result.ok).toBe(false);
      expect(result.errors?.[field]).toBeTruthy();
    }
  });

  it('rejects an unaccepted terms checkbox', () => {
    expect(validateOrderInput({ ...base, terms: 'off' }).ok).toBe(false);
  });

  it('requires copy and a destination URL for text creatives', () => {
    expect(validateOrderInput({ ...base, copy: '' }).ok).toBe(false);
    expect(validateOrderInput({ ...base, destinationUrl: 'not-a-url' }).ok).toBe(false);
  });

  it('enforces advertising-copy length bounds', () => {
    expect(validateOrderInput({ ...base, copy: 'too short' }).ok).toBe(false);
    expect(validateOrderInput({ ...base, copy: 'x'.repeat(501) }).ok).toBe(false);
    expect(validateOrderInput({ ...base, copy: 'x'.repeat(500) }).ok).toBe(true);
  });

  it('rejects an unknown placement or duration', () => {
    expect(validateOrderInput({ ...base, placement: 'sidebar' }).ok).toBe(false);
    expect(validateOrderInput({ ...base, duration: '2' }).ok).toBe(false);
  });

  it('does not require copy for image creatives', () => {
    const result = validateOrderInput({ ...base, format: 'image', copy: '', destinationUrl: '' });
    expect(result.ok).toBe(true);
  });

  it('silently rejects honeypot-filled submissions', () => {
    const result = validateOrderInput({ ...base, honeypot: 'SEO Bot Inc' });
    expect(result.ok).toBe(false);
  });
});

describe('image signature checking', () => {
  it('detects real PNG, JPEG and WebP magic bytes', () => {
    expect(checkImageSignature(PNG, 'png')).toBe(true);
    expect(checkImageSignature(JPEG, 'jpg')).toBe(true);
    expect(checkImageSignature(WEBP, 'webp')).toBe(true);
  });

  it('rejects mismatched families and forgeries', () => {
    expect(checkImageSignature(PNG, 'jpg')).toBe(false);
    expect(checkImageSignature(JPEG, 'png')).toBe(false);
    expect(checkImageSignature(new TextEncoder().encode('<html></html>'), 'png')).toBe(false);
    expect(checkImageSignature(new Uint8Array([0x89, 0x50, 0x4e]), 'png')).toBe(false); // truncated
  });
});

describe('animation detection', () => {
  it('flags an animated WebP (ANIM/ANMF chunks) and passes a static one', () => {
    expect(isAnimatedImage(fixtureBytes('WEBP_ANIMATED'), 'webp')).toBe(true);
    expect(isAnimatedImage(fixtureBytes('WEBP_WIDE'), 'webp')).toBe(false);
  });

  it('flags an APNG (acTL chunk) and passes a static PNG', () => {
    expect(isAnimatedImage(fixtureBytes('PNG_ANIMATED'), 'png')).toBe(true);
    expect(isAnimatedImage(fixtureBytes('PNG_WIDE'), 'png')).toBe(false);
  });

  it('returns false for families without animation support', () => {
    expect(isAnimatedImage(fixtureBytes('JPEG_WIDE'), 'jpg')).toBe(false);
  });

  it('maps MIME types to extension families', () => {
    expect(extensionForMime('image/png')).toBe('png');
    expect(extensionForMime('image/jpeg')).toBe('jpg');
    expect(extensionForMime('image/webp')).toBe('webp');
    expect(extensionForMime('image/svg+xml')).toBeNull();
  });

  it('parses file extensions case-insensitively', () => {
    expect(fileExtension('Banner.PNG')).toBe('png');
    expect(fileExtension('banner')).toBe('');
  });

  it('validates extension, MIME, size and bytes together', () => {
    const ok = validateImageFile({ fileName: 'banner.png', mimeType: 'image/png', bytes: PNG });
    expect(ok.ok).toBe(true);
    expect(ok.extension).toBe('png');

    expect(validateImageFile({ fileName: 'banner.png', mimeType: 'image/png', bytes: JPEG }).ok).toBe(false);
    expect(validateImageFile({ fileName: 'banner.png', mimeType: 'image/jpeg', bytes: PNG }).ok).toBe(false);
    expect(validateImageFile({ fileName: 'banner.gif', mimeType: 'image/gif', bytes: PNG }).ok).toBe(false);
    expect(validateImageFile({ fileName: 'banner.exe', mimeType: 'application/octet-stream', bytes: PNG }).ok).toBe(false);
  });

  it('enforces the documented size limit', () => {
    const oversized = new Uint8Array(5 * 1024 * 1024 + 1);
    oversized.set(PNG);
    const ok = validateImageFile({ fileName: 'big.png', mimeType: 'image/png', bytes: oversized });
    expect(ok.ok).toBe(false);
    expect(ok.error).toMatch(/5 MB/);
  });

  it('rejects empty uploads', () => {
    expect(validateImageFile({ fileName: 'empty.png', mimeType: 'image/png', bytes: new Uint8Array() }).ok).toBe(false);
  });
});
