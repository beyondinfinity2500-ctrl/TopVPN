/**
 * Trusted plan catalogue for TopVPN Premium.
 *
 * This is the single source of truth for what a plan costs. All amounts are in
 * cents so the server and the display layer never disagree about rounding.
 * The Worker imports this module to calculate order amounts — a browser may
 * never submit its own price.
 *
 * IMPORTANT: `providerPlanId` stays null until the matching VPNResellers
 * product/plan id is confirmed from the dashboard/API. Do not invent one.
 */

export const PLAN_IDS = ['monthly', 'annual', 'two-year'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

export const CURRENCY = 'USD';

export interface PlanDefinition {
  id: PlanId;
  name: string;
  /** Billing interval covered by one payment. */
  intervalMonths: number;
  /** Regular price for one interval, in cents. */
  regularCents: number;
  /** One-time introductory price for the first interval only, in cents. */
  introCents?: number;
  /** Provider plan/product id once verified with VPNResellers; null until then. */
  providerPlanId: string | null;
}

export const PLANS: Record<PlanId, PlanDefinition> = {
  monthly: {
    id: 'monthly',
    name: 'Monthly',
    intervalMonths: 1,
    regularCents: 900,
    introCents: 300,
    providerPlanId: null,
  },
  annual: {
    id: 'annual',
    name: 'Annual',
    intervalMonths: 12,
    regularCents: 7200,
    providerPlanId: null,
  },
  'two-year': {
    id: 'two-year',
    name: 'Two-Year',
    intervalMonths: 24,
    regularCents: 12000,
    providerPlanId: null,
  },
};

export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}

export function getPlan(id: PlanId): PlanDefinition {
  return PLANS[id];
}

export function planList(): PlanDefinition[] {
  return PLAN_IDS.map((id) => PLANS[id]);
}

export function hasIntroOffer(id: PlanId): boolean {
  return PLANS[id].introCents !== undefined;
}

/**
 * Amount charged for the first payment. The intro price is a one-time offer,
 * so callers must decide eligibility from trusted customer history and pass it
 * in — never from a browser-supplied flag.
 */
export function orderAmountCents(id: PlanId, opts: { introEligible: boolean }): number {
  const plan = PLANS[id];
  return opts.introEligible && plan.introCents !== undefined ? plan.introCents : plan.regularCents;
}

/** Amount charged on every payment after the first one. */
export function recurringCents(id: PlanId): number {
  return PLANS[id].regularCents;
}

export function monthlyEquivalentCents(id: PlanId): number {
  const plan = PLANS[id];
  return Math.round(plan.regularCents / plan.intervalMonths);
}

/** Format a cents amount as USD without trailing zeroes for whole dollars. */
export function formatUsdCents(cents: number): string {
  const dollars = cents / 100;
  return `$${dollars % 1 === 0 ? dollars.toFixed(0) : dollars.toFixed(2)}`;
}
