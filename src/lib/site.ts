/** Single source of truth for site-wide constants. */
export const SITE = {
  name: 'TopVPN',
  url: 'https://www.topvpn.top',
  tagline: 'Premium VPN Service at an Affordable Price.',
  /** Date the static pages were last meaningfully edited (used in the sitemap). Update when you change page content. */
  updated: '2026-11-10',
  /** Set to true once AdSense is approved; empty placeholder boxes are hidden until then. */
  ads: false,
} as const;

/**
 * URL-safe tag slug: "public Wi-Fi" -> "public-wi-fi"; "الخصوصية" -> "الخصوصية".
 * Arabic tags keep their letters — browsers and search engines handle RTL slugs
 * natively — while English tags keep the ASCII-only rule for cleanliness.
 */
export function slugifyTag(tag: string): string {
  const isArabic = /[\u0600-\u06FF]/.test(tag);
  if (isArabic) {
    return tag
      .normalize('NFD')
      // strip harakat, tatweel, Arabic presentation forms and zero-width marks
      .replace(/[\u064B-\u065F\u0670\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED\u200B-\u200D\uFEFF]/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase();
  }
  return tag.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}