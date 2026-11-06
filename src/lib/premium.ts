/**
 * Presentation data for TopVPN Premium plans.
 *
 * Money comes from src/lib/plans.ts (authoritative, in cents). This module only
 * shapes it for the pricing components, so a price change happens in one place.
 *
 * HONESTY NOTE — there is no live VPN checkout yet (no provisioning backend is
 * wired), so plan CTAs link to /contact. See docs/PLATFORM_IMPLEMENTATION.md.
 */
import {
  PLANS,
  PLAN_IDS,
  formatUsdCents,
  monthlyEquivalentCents,
  recurringCents,
  type PlanId,
} from './plans';

export { PLAN_IDS };
export type { PlanId };

export interface PremiumPlan {
  id: PlanId;
  name: string;
  /** Billing interval covered by one payment. */
  intervalMonths: number;
  /** Effective monthly equivalent in dollars. */
  perMonth: number;
  /** Total billed for the first payment, in dollars. */
  totalBilled: number;
  /** Short billing description shown under the price. */
  billingPeriod: string;
  /** Regular monthly price in dollars (monthly plan only). */
  regularMonthly?: number;
  /** One-time first-month promotional price in dollars (monthly plan only). */
  firstMonthPromo?: number;
  /** Honest note explaining the promotion / renewal terms. */
  billingNote: string;
  /** Short marketing bullets. Pricing/transparency facts only. */
  features: string[];
  /** Savings vs paying monthly for the same term. */
  savingsNote?: string;
  /** Savings percentage vs paying monthly (0 for the monthly plan). */
  savingsPercent: number;
  /** Highlighted as the best-value plan. */
  highlighted?: boolean;
}

const dollars = (cents: number): number => cents / 100;

const monthlyBaseCents = recurringCents('monthly');
const savingsPercent = (id: PlanId): number =>
  Math.round((1 - monthlyEquivalentCents(id) / monthlyBaseCents) * 100);

const monthlyIntro = PLANS.monthly.introCents!;
const monthlyRegular = recurringCents('monthly');
const annualTotal = recurringCents('annual');
const twoYearTotal = recurringCents('two-year');

export const PREMIUM_PLANS: PremiumPlan[] = [
  {
    id: 'monthly',
    name: PLANS.monthly.name,
    intervalMonths: PLANS.monthly.intervalMonths,
    perMonth: dollars(monthlyRegular),
    totalBilled: dollars(monthlyRegular),
    billingPeriod: `${formatUsdCents(monthlyRegular)} for one month`,
    regularMonthly: dollars(monthlyRegular),
    firstMonthPromo: dollars(monthlyIntro),
    billingNote:
      `The ${formatUsdCents(monthlyIntro)} first-month price requires a verified account and is not available at checkout yet. ` +
      `The regular price is ${formatUsdCents(monthlyRegular)} for one month, paid once. No automatic renewal.`,
    features: [
      'Premium VPN experience',
      'Billed month to month',
      'Intro price after account verification',
      'Secure payment',
    ],
    savingsPercent: savingsPercent('monthly'),
  },
  {
    id: 'annual',
    name: PLANS.annual.name,
    intervalMonths: PLANS.annual.intervalMonths,
    perMonth: dollars(monthlyEquivalentCents('annual')),
    totalBilled: dollars(annualTotal),
    billingPeriod: `Billed ${formatUsdCents(annualTotal)} once for 12 months`,
    billingNote:
      `One payment of ${formatUsdCents(annualTotal)} covers 12 months — that works out to ` +
      `${formatUsdCents(monthlyEquivalentCents('annual'))} per month. This is a one-time period with no automatic renewal.`,
    features: [
      'Premium VPN experience',
      `Save ${savingsPercent('annual')}% vs paying monthly`,
      'One payment for 12 months',
      'Secure payment',
    ],
    savingsNote: `Save ${savingsPercent('annual')}% vs paying monthly`,
    savingsPercent: savingsPercent('annual'),
    highlighted: true,
  },
  {
    id: 'two-year',
    name: PLANS['two-year'].name,
    intervalMonths: PLANS['two-year'].intervalMonths,
    perMonth: dollars(monthlyEquivalentCents('two-year')),
    totalBilled: dollars(twoYearTotal),
    billingPeriod: `Billed ${formatUsdCents(twoYearTotal)} once for 24 months`,
    billingNote:
      `One payment of ${formatUsdCents(twoYearTotal)} covers 24 months — that works out to ` +
      `${formatUsdCents(monthlyEquivalentCents('two-year'))} per month. This is a one-time period with no automatic renewal.`,
    features: [
      'Premium VPN experience',
      `Save ${savingsPercent('two-year')}% vs paying monthly`,
      'One payment for 24 months',
      'Secure payment',
    ],
    savingsNote: `Save ${savingsPercent('two-year')}% vs paying monthly`,
    savingsPercent: savingsPercent('two-year'),
  },
];

/** Format a dollar amount (used by the pricing components). */
export function formatUsd(amount: number): string {
  return `$${amount % 1 === 0 ? amount.toFixed(0) : amount.toFixed(2)}`;
}
