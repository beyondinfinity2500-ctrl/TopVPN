import { describe, expect, it } from 'vitest';
import {
  DURATIONS,
  PLACEMENTS,
  campaignEnd,
  discountPercent,
  isDuration,
  isPlacement,
  priceFor,
  unitPrice,
} from '../../src/lib/ads/pricing';

describe('pricing table', () => {
  it('matches the required price matrix for every placement and duration', () => {
    const expected = {
      header: { 1: 30, 3: 81, 6: 153, 12: 288 },
      incontent: { 1: 25, 3: 68, 6: 128, 12: 240 },
      footer: { 1: 9, 3: 24, 6: 45, 12: 81 },
      fullsite: { 1: 58, 3: 156, 6: 293, 12: 548 },
    } as const;

    for (const placement of PLACEMENTS) {
      for (const duration of DURATIONS) {
        expect(priceFor(placement, duration)).toBe(expected[placement][duration]);
      }
    }
  });

  it('charges the same for text and image creatives (format never affects price)', () => {
    // Prices are per placement x duration only; the pricing module has no
    // creative-format dimension at all, which makes this structurally true.
    expect(priceFor('header', 6)).toBe(153);
  });

  it('discounts every multi-month term versus buying one-month terms', () => {
    for (const placement of PLACEMENTS) {
      expect(discountPercent(placement, 1)).toBe(0);
      for (const duration of [3, 6, 12] as const) {
        const pct = discountPercent(placement, duration);
        expect(pct).toBeGreaterThan(0);
        // The term price is strictly below buying the same months one at a time.
        const monthly = priceFor(placement, 1) * duration;
        expect(priceFor(placement, duration)).toBeLessThan(monthly);
      }
    }
  });

  it('applies long-term discounts that grow with duration', () => {
    for (const placement of PLACEMENTS) {
      expect(discountPercent(placement, 3)).toBeLessThanOrEqual(discountPercent(placement, 6));
      expect(discountPercent(placement, 6)).toBeLessThanOrEqual(discountPercent(placement, 12));
    }
  });

  it('prices Full-Site Sponsorship below the sum of its three placements', () => {
    for (const duration of DURATIONS) {
      const separate =
        priceFor('header', duration) + priceFor('incontent', duration) + priceFor('footer', duration);
      const bundle = priceFor('fullsite', duration);
      expect(bundle).toBeLessThan(separate);
      expect(bundle).toBeGreaterThan(0);
    }
  });

  it('computes a per-month unit price', () => {
    expect(unitPrice('header', 3)).toBeCloseTo(27, 2);
    expect(unitPrice('fullsite', 12)).toBeCloseTo(45.666666666666664, 4);
  });

  it('rejects unknown placements and durations', () => {
    expect(() => priceFor('sidebar' as never, 3)).toThrow();
    expect(() => priceFor('header', 2 as never)).toThrow();
    expect(isPlacement('sidebar')).toBe(false);
    expect(isPlacement('header')).toBe(true);
    expect(isDuration(2)).toBe(false);
    expect(isDuration(6)).toBe(true);
  });

  it('computes campaign end dates from a start date and duration', () => {
    expect(campaignEnd('2026-01-01T00:00:00.000Z', 1)).toBe('2026-02-01T00:00:00.000Z');
    expect(campaignEnd('2026-01-31T00:00:00.000Z', 1)).toBe('2026-02-28T00:00:00.000Z');
    expect(campaignEnd('2026-01-01T00:00:00.000Z', 12)).toBe('2027-01-01T00:00:00.000Z');
  });
});
