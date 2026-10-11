/**
 * NEWSIQ promotional campaign — rotating copy + verified destinations.
 *
 * Rotating copy lives here so editors can tune wording without touching the
 * component. Every destination was verified against the live NEWSIQ site
 * (2026-10-12); unverifiable deep links intentionally fall back to the
 * homepage rather than being guessed.
 *
 * These are paid promotional placements for NEWSIQ, not editorial picks.
 */

const HOME = 'https://www.newsiq.top';
const MARKETS = 'https://www.newsiq.top/en/markets';

export interface AdVariant {
  headline: string;
  description: string;
}

export interface NewsiqPlacement {
  /** Which layout to render: wide hero banner, a themed card, or the footer CTA. */
  variant: 'hero' | 'card' | 'footer';
  /** Visual identity. Cards keep a fixed theme while only their copy rotates. */
  theme: 'global' | 'bitcoin' | 'markets' | 'ai';
  destination: string;
  /** Accessible label for the CTA link, updated as copy rotates. */
  ctaBase: string;
  /** Rotating copy. The first entry is what renders before JS runs. */
  variants: AdVariant[];
  /** House ad: links to our own /advertise page, so no sponsored rel or _blank. */
  internal?: boolean;
  /** Brand label top-left. Defaults to the NEWSIQ wordmark. */
  brand?: { name: string; accent?: string };
  /** Small badge top-right. Defaults to "Sponsored". */
  badge?: string;
  /** CTA text. Defaults to "Learn more". */
  ctaLabel?: string;
}

/* ---------- Header / Hero ---------- */
export const newsiqHero: NewsiqPlacement = {
  variant: 'hero',
  theme: 'global',
  destination: HOME,
  ctaBase: 'Visit NEWSIQ',
  variants: [
    { headline: 'Turn Global News Into Better Decisions', description: 'Independent intelligence connecting world events to the markets they move.' },
    { headline: 'Understand the Events Moving Global Markets', description: 'Every story paired with structured, editorially reviewed market-impact analysis.' },
    { headline: 'The Bigger Picture Behind Breaking News', description: 'Context, evidence and market signals — in one place, the moment a story breaks.' },
    { headline: 'Global News. AI Analysis. Market Intelligence.', description: 'One platform connecting what is happening with what it means.' },
  ],
};

/* ---------- Thematic featured cards ---------- */
export const newsiqCards: NewsiqPlacement[] = [
  {
    variant: 'card',
    theme: 'global',
    destination: HOME,
    ctaBase: 'Read global news on NEWSIQ',
    variants: [
      { headline: 'Stay Ahead of the World’s Biggest Stories', description: 'Breaking and trending coverage, tracked across regions as it develops.' },
      { headline: 'Understand the Events Behind the Headlines', description: 'Context-first reporting that explains why a story matters now.' },
      { headline: 'Get More Context From Global News', description: 'Evidence, sources and background attached to every major story.' },
    ],
  },
  {
    variant: 'card',
    theme: 'bitcoin',
    // No dedicated /en/bitcoin route exists on NEWSIQ; markets is the verified
    // home of its Bitcoin market coverage.
    destination: MARKETS,
    ctaBase: 'Follow Bitcoin on NEWSIQ',
    variants: [
      { headline: 'Understand What Is Moving Bitcoin', description: 'Crypto events paired with the market context that explains the price action.' },
      { headline: 'Follow Bitcoin News With More Context', description: 'Every Bitcoin story linked to the broader market picture it belongs to.' },
      { headline: 'Connect Crypto Events With Market Intelligence', description: 'See how on-chain developments and macro forces line up.' },
    ],
  },
  {
    variant: 'card',
    theme: 'markets',
    destination: MARKETS,
    ctaBase: 'Explore markets on NEWSIQ',
    variants: [
      { headline: 'Stocks. Oil. Gold. USD. Bitcoin.', description: 'Regional and global market intelligence, organised the way you research.' },
      { headline: 'Understand the Events Shaping Global Markets', description: 'Indices, commodities and currencies explained through the events driving them.' },
      { headline: 'Follow the Signals Behind Market Movements', description: 'Structured analysis that connects news to the markets it touches.' },
    ],
  },
  {
    variant: 'card',
    theme: 'ai',
    destination: HOME,
    ctaBase: 'Try AI analysis on NEWSIQ',
    variants: [
      { headline: 'News Moves Fast. Understanding It Shouldn’t Take Hours.', description: 'AI-powered analysis gets you from breaking event to meaning in seconds.' },
      { headline: 'From Breaking Events to AI-Powered Analysis', description: 'Structured breakdowns, reviewed by editors, delivered while the story is fresh.' },
      { headline: 'Understand Why a Story Matters', description: 'Relevance, market links and evidence — surfaced automatically, checked by people.' },
    ],
  },
];

/* ---------- Footer ---------- */
export const newsiqFooter: NewsiqPlacement = {
  variant: 'footer',
  theme: 'global',
  destination: HOME,
  ctaBase: 'Visit NEWSIQ',
  variants: [
    { headline: 'Global News. Market Intelligence. AI Analysis.', description: 'One platform for people who need to understand the world as it moves.' },
    { headline: 'Understand the Event. Follow the Evidence. Watch the Market.', description: 'NEWSIQ connects what is happening with what it means.' },
    { headline: 'See the Bigger Picture With NEWSIQ.', description: 'Independent intelligence for a moving world.' },
  ],
};

/* ---------- House ad: TopVPN advertising itself slot ---------- */
export const newsiqHouse: NewsiqPlacement = {
  variant: 'footer',
  theme: 'global',
  destination: '/advertise',
  ctaBase: 'Advertise with TopVPN',
  internal: true,
  brand: { name: 'TOP', accent: 'VPN' },
  badge: 'House Ad',
  ctaLabel: 'Advertise with TopVPN',
  variants: [
    { headline: 'Your Ad Could Be Here.', description: 'This rotating placement is available. Put your brand in front of people ready to choose.' },
    { headline: 'Your Banner. Our Audience.', description: 'Reach visitors actively comparing VPNs, privacy and security tools.' },
    { headline: 'Advertise in This Rotation.', description: 'Tell us about your product and we will match it to the right placement.' },
  ],
};
