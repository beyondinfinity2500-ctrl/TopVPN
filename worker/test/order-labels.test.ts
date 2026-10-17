import { describe, expect, it } from 'vitest';
import {
  DURATIONS,
  PLACEMENTS,
  PLACEMENT_LABELS,
  priceFor,
} from '../../src/lib/ads/pricing';
import {
  buildPriceTable,
  durationOptionLabel,
  placementOptionLabel,
} from '../../src/lib/ads/order-labels';

describe('order form price display', () => {
  it('covers every placement and duration', () => {
    const table = buildPriceTable();
    expect(Object.keys(table).sort()).toEqual([...PLACEMENTS].sort());
    for (const placement of PLACEMENTS) {
      expect(Object.keys(table[placement]).sort()).toEqual(
        DURATIONS.map(String).sort(),
      );
    }
  });

  it('displayed totals equal the server-side checkout amount for all 16 combinations', () => {
    // The Worker charges priceFor() — displayed totals must be the same numbers.
    const table = buildPriceTable();
    for (const placement of PLACEMENTS) {
      for (const months of DURATIONS) {
        expect(table[placement][months].total).toBe(priceFor(placement, months));
        expect(durationOptionLabel(placement, months)).toContain(
          priceFor(placement, months).toFixed(2),
        );
      }
    }
  });

  it('duration option totals update when the placement changes', () => {
    const table = buildPriceTable();
    const header3 = table['header'][String(3)].total;
    const incontent3 = table['incontent'][String(3)].total;
    expect(header3).toBe(81);
    expect(incontent3).toBe(68);
    expect(durationOptionLabel('header', 3)).toContain('$81.00');
    expect(durationOptionLabel('incontent', 3)).toContain('$68.00');
    expect(durationOptionLabel('header', 3)).not.toBe(
      durationOptionLabel('incontent', 3),
    );
  });

  it('placement options show the name and starting monthly price', () => {
    for (const placement of PLACEMENTS) {
      const label = placementOptionLabel(placement);
      expect(label).toContain(PLACEMENT_LABELS[placement]);
      expect(label).toContain(priceFor(placement, 1).toFixed(2));
    }
  });

  it('monthly equivalent is derived from the term, distinct from the total', () => {
    const table = buildPriceTable();
    const entry = table['header'][String(12)];
    expect(entry.total).toBe(288);
    expect(entry.unit).toBe(24); // 288 / 12
    expect(entry.unit).not.toBe(entry.total);
  });

  it('returns undefined for invalid selections (client guard)', () => {
    const table = buildPriceTable();
    expect(table['bogus']).toBeUndefined();
    expect(table['header']['99']).toBeUndefined();
  });

  it('keeps the full-site bundle cheaper than the three placements separately', () => {
    const table = buildPriceTable();
    for (const months of DURATIONS) {
      const separate =
        table['header'][String(months)].total +
        table['incontent'][String(months)].total +
        table['footer'][String(months)].total;
      expect(table['fullsite'][String(months)].total).toBeLessThan(separate);
    }
  });
});
