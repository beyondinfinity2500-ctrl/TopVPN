/** Single source of truth for site-wide constants. */
export const SITE = {
  name: 'TopVPN',
  url: 'https://www.topvpn.top',
  tagline: 'Premium VPN Service at an Affordable Price.',
  /** Date the static pages were last meaningfully edited (used in the sitemap). Update when you change page content. */
  updated: '2026-10-27',
  /** Set to true once AdSense is approved; empty placeholder boxes are hidden until then. */
  ads: false,
} as const;
