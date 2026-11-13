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

/** URL-safe tag slug: "public Wi-Fi" -> "public-wifi". Used by tag pages,
 *  TagChips links and the sitemap so URLs match Google's clean-URL guidance. */
export function slugifyTag(tag: string): string {
  return tag.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
