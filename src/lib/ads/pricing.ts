/**
 * Trusted, single source of truth for advertising pricing and limits.
 *
 * Imported by the /advertise page (build-time display) AND by the Worker
 * (server-side calculation). The Worker value is authoritative: clients can
 * never submit their own amount.
 */

export const PLACEMENTS = ['header', 'incontent', 'footer', 'fullsite'] as const;
export type Placement = (typeof PLACEMENTS)[number];

export const DURATIONS = [1, 3, 6, 12] as const;
export type Duration = (typeof DURATIONS)[number];

export const CREATIVE_FORMATS = ['text', 'image'] as const;
export type CreativeFormat = (typeof CREATIVE_FORMATS)[number];

export const CURRENCY = 'USD';

/** Prices in USD per placement x duration (whole months). */
export const PRICES: Record<Placement, Record<Duration, number>> = {
  header: { 1: 30, 3: 81, 6: 153, 12: 288 },
  incontent: { 1: 25, 3: 68, 6: 128, 12: 240 },
  footer: { 1: 9, 3: 24, 6: 45, 12: 81 },
  fullsite: { 1: 58, 3: 156, 6: 293, 12: 548 },
};

export const PLACEMENT_LABELS: Record<Placement, string> = {
  header: 'Header Banner',
  incontent: 'In-Content Ad',
  footer: 'Footer Banner',
  fullsite: 'Full-Site Sponsorship',
};

export const PLACEMENT_DESCRIPTIONS: Record<Placement, string> = {
  header: 'A compact sponsored strip under the navigation, visible site-wide.',
  incontent: 'A promotional unit inside the main content flow of substantive pages.',
  footer: 'A premium banner above the footer, visible site-wide.',
  fullsite: 'All three placements (Header, In-Content, Footer) for the selected duration.',
};

/* ---------- Creative upload limits (shared by client hints + server) ---------- */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MB
export const MAX_IMAGE_BYTES_LABEL = '5 MB';
export const ALLOWED_IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'] as const;
export const ALLOWED_IMAGE_MIME = ['image/png', 'image/jpeg', 'image/webp'] as const;

export const AD_COPY_MIN = 10;
export const AD_COPY_MAX = 500;
export const DESTINATION_URL_MAX = 2048;

export function isPlacement(value: unknown): value is Placement {
  return typeof value === 'string' && (PLACEMENTS as readonly string[]).includes(value);
}

export function isDuration(value: unknown): value is Duration {
  return typeof value === 'number' && Number.isInteger(value) && (DURATIONS as readonly number[]).includes(value);
}

export function isCreativeFormat(value: unknown): value is CreativeFormat {
  return typeof value === 'string' && (CREATIVE_FORMATS as readonly string[]).includes(value);
}

/** Trusted price in whole dollars for a placement x duration. Throws on invalid input. */
export function priceFor(placement: Placement, duration: Duration): number {
  if (!isPlacement(placement)) throw new Error(`Invalid placement: ${String(placement)}`);
  if (!isDuration(duration)) throw new Error(`Invalid duration: ${String(duration)}`);
  return PRICES[placement][duration];
}

/** Price per month for the given term. */
export function unitPrice(placement: Placement, duration: Duration): number {
  return priceFor(placement, duration) / duration;
}

/**
 * Discount percentage versus buying the same number of one-month terms
 * (the basis for the "long-term discount" line in the order summary).
 */
export function discountPercent(placement: Placement, duration: Duration): number {
  const monthly = priceFor(placement, 1) * duration;
  const term = priceFor(placement, duration);
  if (monthly <= 0) return 0;
  return Math.round((1 - term / monthly) * 100);
}

/** Campaign end date (ISO) for a start date and duration in months. */
export function campaignEnd(startIso: string, months: number): string {
  const d = new Date(startIso);
  const day = d.getUTCDate();
  d.setUTCMonth(d.getUTCMonth() + months);
  if (d.getUTCDate() < day) {
    // Month overflow (e.g. 31 Jan + 1 month): clamp to the last day of the
    // target month instead of rolling into the next one.
    d.setUTCDate(0);
  }
  return d.toISOString();
}
