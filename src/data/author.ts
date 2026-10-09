/**
 * The human editorial voice behind TopVPN.
 *
 * NOTE: this is a team byline rather than a single named individual. Keep every
 * claim here truthful — E-E-A-T signals only help when they describe how the
 * work is genuinely produced. Do not invent credentials, employer names, or
 * hands-on test counts that are not real.
 */
export interface Author {
  /** Full name as it should appear in bylines and Person schema. */
  name: string;
  /** Professional title shown under the name. */
  role: string;
  /** One-line summary used on cards and the About page. */
  summary: string;
  /** Longer biography for the author block. */
  bio: string;
  /** What this person is responsible for on TopVPN. */
  responsibilities: string[];
  /** Honest statement of how reviews are actually produced. */
  methodology: string;
  /** Profile photo, stored under public/. */
  avatar: string;
  /** Verified social/profile links for the Person schema `sameAs`. */
  sameAs: string[];
}

export const AUTHOR: Author = {
  name: 'TopVPN Editorial Team',
  role: 'Independent VPN & Privacy Research Team',
  summary:
    'The research and editorial team behind TopVPN. We publish plain-language comparisons and guides about VPN services, online privacy, and safe access to the open internet.',
  bio: 'TopVPN exists for one reason: to make choosing a VPN easier and more transparent. We research and compare well-known VPN providers side by side — privacy policies, jurisdictions, speeds, server coverage, real prices, and device support — and explain what the differences actually mean for the person buying the service. Our revenue comes from affiliate commissions earned when readers buy through our links. That model funds the research and keeps every guide free, and it is disclosed openly on every page that carries an affiliate link. It never changes what we write: comparisons are built from verifiable facts, and when a provider has a weakness, we report it.',
  responsibilities: [
    'Researching and writing every guide and comparison published on TopVPN',
    'Verifying provider claims against their published privacy policies and independent audit reports',
    'Keeping country guides current as laws and service availability change',
    'Applying the same four criteria — privacy, speed, access, and value — to every provider we cover',
  ],
  methodology:
    'Every provider is evaluated against the same four criteria, applied identically across the whole comparison. Where we use a service hands-on, we describe what we found. Where we have not tested something ourselves, we rely on the provider’s own published documentation and any independent audit reports, and we say so plainly rather than implying first-hand experience. Prices shown are indicative because they change frequently; each comparison links to the provider so readers can confirm current pricing before buying.',
  avatar: '/authors/editor.svg',
  sameAs: [],
};
