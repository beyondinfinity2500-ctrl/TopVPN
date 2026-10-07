export interface Provider {
  name: string;
  slug: string;
  affiliateUrl: string;
  monthlyPrice: number | null;
  sixMonthPrice: number | null;
  longTermPrice: number | null;
  locations: number | null;
  devices: number | null;
  protocols: string[];
  bestFor: string;
  pros: string[];
  cons: string[];
  rating: number | null;
}

export const providers: Provider[] = [
  {
    name: 'NordVPN',
    slug: 'nordvpn',
    affiliateUrl: '#',
    monthlyPrice: null,
    sixMonthPrice: null,
    longTermPrice: null,
    locations: null,
    devices: null,
    protocols: ['WireGuard', 'OpenVPN', 'IKEv2'],
    bestFor: 'All-round security and speed',
    pros: [
      'Strong encryption standards',
      'Large server network',
      'Includes additional security features',
    ],
    cons: [
      'Premium pricing on monthly plans',
      'App can feel feature-heavy',
    ],
    rating: null,
  },
  {
    name: 'ExpressVPN',
    slug: 'expressvpn',
    affiliateUrl: '#',
    monthlyPrice: null,
    sixMonthPrice: null,
    longTermPrice: null,
    locations: null,
    devices: null,
    protocols: ['Lightway', 'OpenVPN', 'IKEv2'],
    bestFor: 'Fast, reliable connections worldwide',
    pros: [
      'Consistently fast speeds',
      'Easy-to-use apps',
      'Wide device compatibility',
    ],
    cons: [
      'Higher price point',
      'Fewer simultaneous connections',
    ],
    rating: null,
  },
  {
    name: 'Surfshark',
    slug: 'surfshark',
    affiliateUrl: '#',
    monthlyPrice: null,
    sixMonthPrice: null,
    longTermPrice: null,
    locations: null,
    devices: null,
    protocols: ['WireGuard', 'OpenVPN', 'IKEv2'],
    bestFor: 'Budget-friendly unlimited devices',
    pros: [
      'Unlimited simultaneous devices',
      'Competitive long-term pricing',
      'Clean interface',
    ],
    cons: [
      'Speeds can vary by server',
      'Customer support slower off-peak',
    ],
    rating: null,
  },
  {
    name: 'Proton VPN',
    slug: 'proton-vpn',
    affiliateUrl: '#',
    monthlyPrice: null,
    sixMonthPrice: null,
    longTermPrice: null,
    locations: null,
    devices: null,
    protocols: ['WireGuard', 'OpenVPN', 'IKEv2'],
    bestFor: 'Privacy-first with free tier',
    pros: [
      'Strong privacy track record',
      'Free plan available',
      'Based in privacy-friendly jurisdiction',
    ],
    cons: [
      'Free tier has speed limits',
      'Fewer servers than competitors',
    ],
    rating: null,
  },
  {
    name: 'CyberGhost',
    slug: 'cyberghost',
    affiliateUrl: '#',
    monthlyPrice: null,
    sixMonthPrice: null,
    longTermPrice: null,
    locations: null,
    devices: null,
    protocols: ['WireGuard', 'OpenVPN', 'IKEv2'],
    bestFor: 'Beginners and streaming',
    pros: [
      'Beginner-friendly apps',
      'Large server network',
      'Generous money-back guarantee',
    ],
    cons: [
      'Speeds inconsistent on distant servers',
      'Fewer advanced features',
    ],
    rating: null,
  },
  {
    name: 'PureVPN',
    slug: 'purevpn',
    affiliateUrl: 'https://billing.purevpn.com/aff.php?aff=49385888',
    monthlyPrice: 12.95,
    sixMonthPrice: null,
    longTermPrice: 2.15,
    locations: null,
    devices: null,
    protocols: ['WireGuard', 'OpenVPN', 'IKEv2'],
    bestFor: 'Long-term value and feature bundles',
    pros: [
      'Competitive advertised long-term price',
      '31-day money-back guarantee',
      'Multiple plan tiers',
    ],
    cons: [
      'Promotional pricing can change',
      'Renewal price is higher than the introductory rate',
    ],
    rating: null,
  },
  {
    name: 'Private Internet Access',
    slug: 'private-internet-access',
    affiliateUrl: '#',
    monthlyPrice: null,
    sixMonthPrice: null,
    longTermPrice: null,
    locations: null,
    devices: null,
    protocols: ['WireGuard', 'OpenVPN', 'IKEv2'],
    bestFor: 'Transparency and open-source',
    pros: [
      'Open-source apps',
      'Strong privacy commitment',
      'Affordable long-term plans',
    ],
    cons: [
      'Interface less polished',
      'Streaming support varies',
    ],
    rating: null,
  },
];

export function formatPrice(value: number | null): string {
  if (value === null) return 'Check latest price';
  return `$${value.toFixed(2)}`;
}

export function formatRating(value: number | null): string {
  if (value === null) return 'N/A';
  return value.toFixed(1);
}
