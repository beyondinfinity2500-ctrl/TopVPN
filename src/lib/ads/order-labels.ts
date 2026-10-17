/**
 * Pure label builders + the price table handed to the client script.
 * Single source of truth: everything derives from src/lib/ads/pricing.ts,
 * the same module the Worker uses for the authoritative server-side price.
 */
import {
  DURATIONS,
  PLACEMENTS,
  PLACEMENT_LABELS,
  discountPercent,
  priceFor,
  unitPrice,
  type Duration,
  type Placement,
} from './pricing';

export interface PriceEntry {
  unit: number;
  total: number;
  discount: number;
}
export type PriceTable = Record<string, Record<string, PriceEntry>>;

export const money = (value: number): string =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);

/** "Header Banner — from $30/mo" (starting price = the 1-month term). */
export function placementOptionLabel(placement: Placement): string {
  return `${PLACEMENT_LABELS[placement]} — from ${money(priceFor(placement, 1))}/mo`;
}

/** "3 months — $81 total" for the currently selected placement. */
export function durationOptionLabel(placement: Placement, months: Duration): string {
  const label = months === 1 ? '1 month' : `${months} months`;
  return `${label} — ${money(priceFor(placement, months))} total`;
}

/** The JSON price table injected into the page for live selector updates. */
export function buildPriceTable(): PriceTable {
  const table: PriceTable = {};
  for (const placement of PLACEMENTS) {
    table[placement] = {};
    for (const months of DURATIONS) {
      table[placement][months] = {
        unit: Number(unitPrice(placement, months).toFixed(2)),
        total: priceFor(placement, months),
        discount: discountPercent(placement, months),
      };
    }
  }
  return table;
}
