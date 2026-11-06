import { describe, expect, it } from 'vitest';
import {
  CURRENCY,
  PLANS,
  PLAN_IDS,
  formatUsdCents,
  getPlan,
  hasIntroOffer,
  isPlanId,
  monthlyEquivalentCents,
  orderAmountCents,
  planList,
  recurringCents,
} from '../../src/lib/plans';
import { PREMIUM_PLANS, formatUsd } from '../../src/lib/premium';

describe('plan catalogue', () => {
  it('defines exactly the three published plans', () => {
    expect([...PLAN_IDS]).toEqual(['monthly', 'annual', 'two-year']);
    expect(planList().map((p) => p.id)).toEqual(['monthly', 'annual', 'two-year']);
    expect(CURRENCY).toBe('USD');
  });

  it('holds the published regular prices in cents', () => {
    expect(PLANS.monthly.regularCents).toBe(900); // $9/month
    expect(PLANS.annual.regularCents).toBe(7200); // $72 / 12 months
    expect(PLANS['two-year'].regularCents).toBe(12000); // $120 / 24 months
  });

  it('derives the advertised monthly equivalents', () => {
    expect(monthlyEquivalentCents('monthly')).toBe(900); // $9
    expect(monthlyEquivalentCents('annual')).toBe(600); // $6
    expect(monthlyEquivalentCents('two-year')).toBe(500); // $5
  });

  it('applies the $3 intro only to the first monthly payment', () => {
    expect(hasIntroOffer('monthly')).toBe(true);
    expect(hasIntroOffer('annual')).toBe(false);
    expect(hasIntroOffer('two-year')).toBe(false);

    expect(orderAmountCents('monthly', { introEligible: true })).toBe(300);
    expect(orderAmountCents('monthly', { introEligible: false })).toBe(900);
    // Intro eligibility is ignored for plans without an intro price.
    expect(orderAmountCents('annual', { introEligible: true })).toBe(7200);
    expect(orderAmountCents('two-year', { introEligible: true })).toBe(12000);
  });

  it('reports recurring amounts (never the intro price)', () => {
    expect(recurringCents('monthly')).toBe(900);
    expect(recurringCents('annual')).toBe(7200);
    expect(recurringCents('two-year')).toBe(12000);
  });

  it('validates plan ids without accepting arbitrary strings', () => {
    expect(isPlanId('monthly')).toBe(true);
    expect(isPlanId('annual')).toBe(true);
    expect(isPlanId('two-year')).toBe(true);
    expect(isPlanId('weekly')).toBe(false);
    expect(isPlanId('')).toBe(false);
    expect(isPlanId(null)).toBe(false);
    expect(isPlanId(3)).toBe(false);
  });

  it('formats cents as USD', () => {
    expect(formatUsdCents(300)).toBe('$3');
    expect(formatUsdCents(600)).toBe('$6');
    expect(formatUsdCents(900)).toBe('$9');
    expect(formatUsdCents(1250)).toBe('$12.50');
  });

  it('returns a plan definition by id', () => {
    expect(getPlan('annual').intervalMonths).toBe(12);
    expect(getPlan('two-year').intervalMonths).toBe(24);
    expect(PLANS.monthly.providerPlanId).toBeNull(); // not verified yet
  });
});

describe('premium display layer stays in sync with the catalogue', () => {
  it('exposes every plan exactly once, in catalogue order', () => {
    expect(PREMIUM_PLANS.map((p) => p.id)).toEqual([...PLAN_IDS]);
  });

  it('derives display amounts from the catalogue', () => {
    const byId = Object.fromEntries(PREMIUM_PLANS.map((p) => [p.id, p]));
    expect(byId.monthly.totalBilled).toBe(9);
    expect(byId.monthly.regularMonthly).toBe(9);
    expect(byId.monthly.firstMonthPromo).toBe(3);
    expect(byId.annual.perMonth).toBe(6);
    expect(byId.annual.totalBilled).toBe(72);
    expect(byId['two-year'].perMonth).toBe(5);
    expect(byId['two-year'].totalBilled).toBe(120);
  });

  it('exposes interval and savings data used by the pricing UI', () => {
    const byId = Object.fromEntries(PREMIUM_PLANS.map((p) => [p.id, p]));
    expect(byId.monthly.intervalMonths).toBe(1);
    expect(byId.annual.intervalMonths).toBe(12);
    expect(byId['two-year'].intervalMonths).toBe(24);
    expect(byId.monthly.savingsPercent).toBe(0);
    expect(byId.annual.savingsPercent).toBe(33);
    expect(byId['two-year'].savingsPercent).toBe(44);
  });

  it('states honest savings percentages', () => {
    const byId = Object.fromEntries(PREMIUM_PLANS.map((p) => [p.id, p]));
    expect(byId.monthly.savingsNote).toBeUndefined();
    expect(byId.annual.savingsNote).toBe('Save 33% vs paying monthly');
    expect(byId['two-year'].savingsNote).toBe('Save 44% vs paying monthly');
  });

  it('marks exactly one plan as highlighted', () => {
    expect(PREMIUM_PLANS.filter((p) => p.highlighted)).toHaveLength(1);
    expect(PREMIUM_PLANS.find((p) => p.highlighted)?.id).toBe('annual');
  });

  it('keeps dollar formatting used by the components', () => {
    expect(formatUsd(3)).toBe('$3');
    expect(formatUsd(6)).toBe('$6');
    expect(formatUsd(12.5)).toBe('$12.50');
  });
});
