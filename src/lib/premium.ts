/**
 * Single source of truth for TopVPN Premium plan pricing.
 *
 * HONESTY NOTE — read before changing anything here:
 * These are the *published marketing prices* for TopVPN Premium, our own VPN
 * service. There is currently NO VPN reseller / provisioning integration in this
 * codebase (the Stripe + Worker system in `src/lib/ads/` and `worker/` sells
 * advertising placements, not VPN accounts). Until a verified provisioning and
 * checkout workflow exists, the plan CTAs link to /contact rather than a live
 * payment form — see the checkout blocker in the project report. Do not present
 * these as a working checkout until a reseller backend is wired and verified.
 */

export const PLAN_IDS = ['monthly', 'annual', 'two-year'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export interface PremiumPlan {
  id: PlanId;
  name: string;
  /** Effective monthly equivalent in USD. */
  perMonth: number;
  /** Total billed today for the full term, in USD. */
  totalBilled: number;
  /** Short billing description shown under the price. */
  billingPeriod: string;
  /** Regular monthly price before any promotion (monthly plan only). */
  regularMonthly?: number;
  /** One-time first-month promotional price (monthly plan only). */
  firstMonthPromo?: number;
  /** Honest note explaining the promotion / renewal terms. */
  billingNote: string;
  /** Short marketing bullets. Only pricing/transparency facts — no unverified specs. */
  features: string[];
  /** Savings vs paying monthly for the same term. */
  savingsNote?: string;
  /** Highlighted as the best-value plan. */
  highlighted?: boolean;
}

export const PREMIUM_PLANS: PremiumPlan[] = [
  {
    id: 'monthly',
    name: 'Monthly',
    perMonth: 9,
    totalBilled: 3,
    billingPeriod: '$3 first month, then $9/month',
    regularMonthly: 9,
    firstMonthPromo: 3,
    billingNote:
      'The $3 price is a one-time promotion for your first month only. From month two onward the plan renews at $9 per month until you cancel.',
    features: ['Premium VPN experience', 'Billed month to month', 'First month just $3', 'Secure payment'],
  },
  {
    id: 'annual',
    name: 'Annual',
    perMonth: 6,
    totalBilled: 72,
    billingPeriod: 'Billed $72 once for 12 months',
    billingNote:
      'One payment of $72 covers 12 months — that works out to $6 per month. Renews at the standard annual rate unless cancelled.',
    features: ['Premium VPN experience', 'Save 33% vs paying monthly', 'One payment for 12 months', 'Secure payment'],
    savingsNote: 'Save 33% vs paying monthly',
    highlighted: true,
  },
  {
    id: 'two-year',
    name: 'Two-Year',
    perMonth: 5,
    totalBilled: 120,
    billingPeriod: 'Billed $120 once for 24 months',
    billingNote:
      'One payment of $120 covers 24 months — that works out to $5 per month. Renews at the standard two-year rate unless cancelled.',
    features: ['Premium VPN experience', 'Save 44% vs paying monthly', 'One payment for 24 months', 'Secure payment'],
    savingsNote: 'Save 44% vs paying monthly',
  },
];

/** Format a USD amount without a trailing .00 for whole dollars. */
export function formatUsd(amount: number): string {
  return `$${amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2)}`;
}
