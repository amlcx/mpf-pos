/**
 * All money is an integer number of minor units ("cents"). Never use floats
 * for amounts; convert only at the edges (parsing input, formatting output).
 */

/**
 * Amounts are shown the Colombian way: "." groups thousands, "," marks
 * decimals, and decimals are left out when they are zero ("$12.000").
 */
export function formatCents(cents: number, symbol = ''): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = String(Math.floor(abs / 100)).replace(/\B(?=(\d{3})+$)/g, '.');
  const frac = abs % 100;
  return `${sign}${symbol}${whole}${frac ? `,${String(frac).padStart(2, '0')}` : ''}`;
}

/**
 * Parses "12000", "12.000" and "12.000,50" into cents. A "." is only ever a
 * thousands separator, so "12.5" is rejected (null) rather than guessed at.
 */
export function parseCents(input: string): number | null {
  const match = /^(\d+|\d{1,3}(?:\.\d{3})+)(?:,(\d{1,2}))?$/.exec(input.trim());
  if (!match) return null;
  const whole = Number(match[1]!.replaceAll('.', ''));
  const frac = Number((match[2] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + frac;
  return Number.isSafeInteger(cents) ? cents : null;
}

export interface Totals {
  subtotalCents: number;
  taxCents: number;
  totalCents: number;
}

/**
 * The single definition of how an order's totals derive from its lines.
 * Client and server both call this; the server rejects orders that disagree.
 *
 * taxIncluded = true: line prices already contain tax (total = sum of lines).
 * taxIncluded = false: tax is added on top of the sum of lines.
 */
export function computeTotals(
  lineTotalsCents: number[],
  taxRateBps: number,
  taxIncluded: boolean,
): Totals {
  const gross = lineTotalsCents.reduce((sum, n) => sum + n, 0);
  if (taxIncluded) {
    const taxCents = Math.round((gross * taxRateBps) / (10_000 + taxRateBps));
    return { subtotalCents: gross - taxCents, taxCents, totalCents: gross };
  }
  const taxCents = Math.round((gross * taxRateBps) / 10_000);
  return { subtotalCents: gross, taxCents, totalCents: gross + taxCents };
}
