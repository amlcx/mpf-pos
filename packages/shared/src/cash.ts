/**
 * The cash drawer of a register: counted at opening, moved during the day,
 * counted again at closing. Money is in cents like everywhere else.
 */
import { localDate } from './report.ts';
import type { CashSession } from './schemas.ts';

/** Colombian bills and coins, largest first. */
export const DENOMINATIONS = [
  { cents: 10_000_000, kind: 'bill' },
  { cents: 5_000_000, kind: 'bill' },
  { cents: 2_000_000, kind: 'bill' },
  { cents: 1_000_000, kind: 'bill' },
  { cents: 500_000, kind: 'bill' },
  { cents: 200_000, kind: 'bill' },
  { cents: 100_000, kind: 'coin' },
  { cents: 50_000, kind: 'coin' },
  { cents: 20_000, kind: 'coin' },
  { cents: 10_000, kind: 'coin' },
  { cents: 5_000, kind: 'coin' },
] as const;

/** How many of each denomination, keyed by its value in cents ("10000000": 2). */
export type CashCount = Record<string, number>;

/** What a count adds up to. Unknown denominations are refused by CashCountSchema. */
export function countCents(count: CashCount): number {
  return Object.entries(count).reduce((sum, [cents, pieces]) => sum + Number(cents) * pieces, 0);
}

/**
 * A drawer's business day starts at this local hour, not at midnight, so a
 * shift running past 00:00 does not suddenly belong to the next day.
 */
export const DAY_STARTS_AT_HOUR = 5;

/** The business day `now` falls in, as yyyy-mm-dd. */
export function businessDate(now: Date = new Date()): string {
  return localDate(new Date(now.getTime() - DAY_STARTS_AT_HOUR * 60 * 60 * 1000));
}

/**
 * Arithmetic invariants of a drawer, like orderProblems for orders. The
 * register checks before saving; the server refuses a drawer that fails.
 */
export function cashSessionProblems(session: CashSession): string[] {
  const problems: string[] = [];
  if (countCents(session.openingCount) !== session.openingCents) {
    problems.push('opening total does not match its count');
  }
  const closing = session.closing;
  if (closing) {
    if (countCents(closing.count) !== closing.countedCents) {
      problems.push('closing total does not match its count');
    }
    if (closing.countedCents !== closing.expectedCents && closing.note.trim() === '') {
      problems.push('a closing that does not match needs a note');
    }
    if (closing.closedAt < session.openedAt) problems.push('closed before it was opened');
  }
  return problems;
}
