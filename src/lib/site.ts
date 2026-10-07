/** Single source of truth for site-wide constants. */
export const SITE = {
  name: 'TopVPN',
  url: 'https://www.topvpn.top',
  tagline: 'Independent VPN comparisons and guides in plain language.',
  /** Date the static pages were last meaningfully edited (used in the sitemap). Update when you change page content. */
  updated: '2026-10-07',
  /** Set to true once AdSense is approved; empty placeholder boxes are hidden until then. */
  ads: false,
} as const;
