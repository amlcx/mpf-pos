/**
 * The register's cash drawer. Opened with a count of bills and coins, cash
 * moved in and out during the day, closed with a blind count: the cashier
 * counts before the register says what it expected.
 *
 * Saved locally first like sales; every change bumps `version`, and a sync
 * round sends the whole drawer while `version > synced_version`.
 */
import {
  type CashCount,
  type CashMovement,
  type CashSession,
  businessDate,
  cashSessionProblems,
  countCents,
  expectedCashCents,
  uuidv7,
} from '@mpf/shared';
import type { LocalDb, Statement } from './local-db.ts';
import { listOrdersOfDrawer } from './repo.ts';

export interface LocalDrawer extends CashSession {
  syncError: string | null;
  /** Changed since the server last took it. */
  dirty: boolean;
}

export type DrawerStatus =
  /** Open for the current business day: selling is allowed. */
  | { state: 'open'; drawer: LocalDrawer }
  /** Left open from an earlier business day: it must be closed first. */
  | { state: 'stale'; drawer: LocalDrawer }
  /** No drawer open: it must be opened before selling. */
  | { state: 'closed' };

const DRAWER_SELECT = `select id, business_date as businessDate, opened_by as openedBy, opened_at as openedAt,
  opening_count as openingCount, opening_cents as openingCents, closed_by as closedBy, closed_at as closedAt,
  closing_count as closingCount, counted_cents as countedCents, expected_cents as expectedCents,
  close_note as closeNote, sync_error as syncError, version > synced_version as dirty, version
  from cash_sessions`;

async function hydrate(db: LocalDb, rows: any[]): Promise<(LocalDrawer & { version: number })[]> {
  const drawers = [];
  for (const r of rows) {
    const movements = await db.select<CashMovement>(
      `select id, kind, amount_cents as amountCents, reason, user_id as userId, created_at as createdAt
       from cash_movements where session_id = ? order by created_at, id`,
      [r.id],
    );
    drawers.push({
      id: r.id,
      businessDate: r.businessDate,
      openedBy: r.openedBy,
      openedAt: r.openedAt,
      openingCount: JSON.parse(r.openingCount) as CashCount,
      openingCents: r.openingCents,
      movements,
      closing: r.closedAt
        ? {
            closedBy: r.closedBy,
            closedAt: r.closedAt,
            count: JSON.parse(r.closingCount) as CashCount,
            countedCents: r.countedCents,
            expectedCents: r.expectedCents,
            note: r.closeNote,
          }
        : null,
      syncError: r.syncError,
      dirty: !!r.dirty,
      version: r.version,
    });
  }
  return drawers;
}

export async function getDrawer(db: LocalDb, id: string): Promise<LocalDrawer | null> {
  return (await hydrate(db, await db.select(`${DRAWER_SELECT} where id = ?`, [id])))[0] ?? null;
}

/** Whether this register can sell now, or must open or close its drawer first. */
export async function drawerStatus(db: LocalDb, now: Date = new Date()): Promise<DrawerStatus> {
  const [open] = await hydrate(db, await db.select(`${DRAWER_SELECT} where closed_at is null order by opened_at desc limit 1`));
  if (!open) return { state: 'closed' };
  return open.businessDate === businessDate(now) ? { state: 'open', drawer: open } : { state: 'stale', drawer: open };
}

/** Bumped on every change, so the next sync round sends the drawer. */
const touch = (id: string): Statement => ({ sql: 'update cash_sessions set version = version + 1 where id = ?', params: [id] });

/** Opens the drawer with what the cashier counted. Refused while one is open. */
export async function openDrawer(
  db: LocalDb,
  input: { count: CashCount; userId: string; now?: Date },
): Promise<{ ok: true; drawer: LocalDrawer } | { ok: false; reason: 'already_open' }> {
  if ((await drawerStatus(db, input.now)).state !== 'closed') return { ok: false, reason: 'already_open' };
  const now = input.now ?? new Date();
  const id = uuidv7(now.getTime());
  const count = withoutZeros(input.count);
  await db.batch([
    {
      sql: `insert into cash_sessions (id, business_date, opened_by, opened_at, opening_count, opening_cents)
            values (?, ?, ?, ?, ?, ?)`,
      params: [id, businessDate(now), input.userId, now.toISOString(), JSON.stringify(count), countCents(count)],
    },
  ]);
  return { ok: true, drawer: (await getDrawer(db, id))! };
}

/** Cash put into (in) or taken out of (out) the open drawer. */
export async function moveCash(
  db: LocalDb,
  input: { kind: CashMovement['kind']; amountCents: number; reason: string; userId: string; now?: Date },
): Promise<{ ok: true } | { ok: false; reason: 'no_open_drawer' | 'invalid' }> {
  const status = await drawerStatus(db, input.now);
  if (status.state !== 'open') return { ok: false, reason: 'no_open_drawer' };
  const reason = input.reason.trim();
  if (!Number.isSafeInteger(input.amountCents) || input.amountCents <= 0 || !reason) return { ok: false, reason: 'invalid' };
  const now = input.now ?? new Date();
  await db.batch([
    {
      sql: `insert into cash_movements (id, session_id, kind, amount_cents, reason, user_id, created_at)
            values (?, ?, ?, ?, ?, ?, ?)`,
      params: [uuidv7(now.getTime()), status.drawer.id, input.kind, input.amountCents, reason, input.userId, now.toISOString()],
    },
    touch(status.drawer.id),
  ]);
  return { ok: true };
}

/** What the open (or stale) drawer should hold right now. Not shown before the closing count. */
export async function expectedInDrawer(db: LocalDb, drawer: CashSession): Promise<number> {
  return expectedCashCents(drawer.openingCents, await listOrdersOfDrawer(db, drawer.id), drawer.movements);
}

export type CloseResult =
  | { ok: true; drawer: LocalDrawer; expectedCents: number; countedCents: number }
  /** Counted and expected differ: nothing saved until the cashier says why. */
  | { ok: false; reason: 'note_required'; expectedCents: number; countedCents: number }
  | { ok: false; reason: 'no_open_drawer' | 'unsynced_sales' };

/**
 * Closes the open drawer (today's or a stale one) with the cashier's count.
 * When it does not match, the first call only reports the difference; the
 * cashier then closes with a note.
 */
export async function closeDrawer(
  db: LocalDb,
  input: { count: CashCount; userId: string; note?: string; now?: Date },
): Promise<CloseResult> {
  const status = await drawerStatus(db, input.now);
  if (status.state === 'closed') return { ok: false, reason: 'no_open_drawer' };
  const drawer = status.drawer;
  // A sale still waiting for the server's yes or no may yet disappear, which
  // would change what the drawer should hold.
  const [row] = await db.select<{ waiting: number }>(
    "select count(*) as waiting from orders where cash_session_id = ? and sync_status = 'submitting'",
    [drawer.id],
  );
  if (row!.waiting > 0) return { ok: false, reason: 'unsynced_sales' };

  const count = withoutZeros(input.count);
  const countedCents = countCents(count);
  const expectedCents = await expectedInDrawer(db, drawer);
  const note = (input.note ?? '').trim();
  if (countedCents !== expectedCents && !note) return { ok: false, reason: 'note_required', expectedCents, countedCents };

  const now = input.now ?? new Date();
  const closing = { closedBy: input.userId, closedAt: now.toISOString(), count, countedCents, expectedCents, note };
  if (cashSessionProblems({ ...drawer, closing }).length > 0) throw new Error('drawer closing does not add up');
  await db.batch([
    {
      sql: `update cash_sessions set closed_by = ?, closed_at = ?, closing_count = ?, counted_cents = ?,
              expected_cents = ?, close_note = ? where id = ? and closed_at is null`,
      params: [input.userId, closing.closedAt, JSON.stringify(count), countedCents, expectedCents, note, drawer.id],
    },
    touch(drawer.id),
  ]);
  return { ok: true, drawer: (await getDrawer(db, drawer.id))!, expectedCents, countedCents };
}

/** Drawers the server has not taken in their latest form, oldest first. */
export async function listDirtyDrawers(db: LocalDb): Promise<(LocalDrawer & { version: number })[]> {
  return hydrate(
    db,
    await db.select(`${DRAWER_SELECT} where version > synced_version and sync_error is null order by opened_at`),
  );
}

export const markDrawerSynced = (id: string, version: number): Statement => ({
  sql: 'update cash_sessions set synced_version = max(synced_version, ?), sync_error = null where id = ?',
  params: [version, id],
});

export const markDrawerFailed = (id: string, error: string): Statement => ({
  sql: 'update cash_sessions set sync_error = ? where id = ?',
  params: [error, id],
});

/** Only the denominations that were actually counted. */
function withoutZeros(count: CashCount): CashCount {
  return Object.fromEntries(Object.entries(count).filter(([, pieces]) => pieces > 0));
}
