import { type CashSession, uuidv7 } from '@mpf/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type World, call, createWorld, makeOrder } from './helpers.ts';

let w: World;
const put = (session: CashSession, terminal: 'A' | 'B' = 'A', id = session.id) =>
  call(w.app, w.terminals[terminal].token, 'PUT', `/cash-sessions/${id}`, session);

/** A drawer opened with one 50.000 bill and four 1.000 coins. */
function drawer(): CashSession {
  return {
    id: uuidv7(),
    businessDate: '2026-10-07',
    openedBy: w.cashierId,
    openedAt: '2026-10-07T13:00:00.000Z',
    openingCount: { '5000000': 1, '100000': 4 },
    openingCents: 5_400_000,
    movements: [],
    closing: null,
  };
}
const closing = (expectedCents: number, countedCents = expectedCents, note = '') => ({
  closedBy: w.cashierId,
  closedAt: '2026-10-08T01:00:00.000Z',
  // 50.000 bills, then 1.000 coins for the rest.
  count: { '5000000': Math.floor(countedCents / 5_000_000), '100000': (countedCents % 5_000_000) / 100_000 },
  countedCents,
  expectedCents,
  note,
});
const movement = (kind: 'in' | 'out', amountCents: number) => ({
  id: uuidv7(),
  kind,
  amountCents,
  reason: kind === 'in' ? 'Más sencillo' : 'A la caja fuerte',
  userId: w.cashierId,
  createdAt: '2026-10-07T18:00:00.000Z',
});

beforeAll(async () => {
  w = await createWorld('cash');
});
afterAll(() => w.close());

describe('cash drawer', () => {
  it('saves a drawer, then its movements and closing; repeating changes nothing', async () => {
    const d = drawer();
    expect((await put(d)).json).toEqual({ status: 'saved' });
    const moves = [movement('in', 1_000_000), movement('out', 1_400_000)];
    expect((await put({ ...d, movements: moves })).status).toBe(200);
    const closed = { ...d, movements: moves, closing: closing(5_000_000) };
    expect((await put(closed)).status).toBe(200);
    expect((await put(closed)).status).toBe(200); // a retry after a lost response

    const [row] = await w.sql`
      select store_id, terminal_id, opening_cents, opening_counts, counted_cents, expected_cents, close_note
      from cash_sessions where id = ${d.id}`;
    expect(row).toEqual({
      storeId: w.storeId,
      terminalId: w.terminals.A.id,
      openingCents: 5_400_000,
      openingCounts: { '5000000': 1, '100000': 4 },
      countedCents: 5_000_000,
      expectedCents: 5_000_000,
      closeNote: '',
    });
    const saved = await w.sql`select kind, amount_cents from cash_movements where session_id = ${d.id} order by kind`;
    expect(saved).toEqual([
      { kind: 'in', amountCents: 1_000_000 },
      { kind: 'out', amountCents: 1_400_000 },
    ]);
  });

  it('refuses drawers that do not add up', async () => {
    const d = drawer();
    const wrongTotal = await put({ ...d, openingCents: 5_000_000 });
    expect(wrongTotal.status).toBe(400);
    expect(wrongTotal.json.error).toBe('invalid_cash_session');
    // Counted 50.000 where 54.000 was expected, and nobody said why.
    expect((await put({ ...d, closing: closing(5_400_000, 5_000_000) })).status).toBe(400);
    expect((await put({ ...d, closing: closing(5_400_000, 5_000_000, 'Faltan 4.000') })).status).toBe(200);
    expect((await put({ ...d, openingCount: { '7000': 1 } })).status).toBe(400); // no such coin
    expect((await put(d, 'A', uuidv7())).status).toBe(400); // URL and body disagree
    expect((await put({ ...drawer(), openedBy: uuidv7() })).status).toBe(422); // unknown person
  });

  it('never rewrites an opening or a closing', async () => {
    const d = drawer();
    expect((await put({ ...d, closing: closing(5_400_000) })).status).toBe(200);
    // The same drawer told differently, or claimed by another register.
    expect((await put({ ...d, openingCount: { '5000000': 1, '200000': 2 } })).status).toBe(409);
    expect((await put({ ...d, closing: closing(5_400_000, 5_000_000, 'Otra cuenta') })).status).toBe(409);
    expect((await put(d, 'B')).status).toBe(409);
    // A late push from before the closing is fine, and the drawer stays closed.
    expect((await put(d)).status).toBe(200);
    const [row] = await w.sql`select counted_cents from cash_sessions where id = ${d.id}`;
    expect(row!.countedCents).toBe(5_400_000);
  });

  it('remembers which drawer each sale went into, even if the sale arrives first', async () => {
    const d = drawer();
    const order = { ...makeOrder(w, 'A', 1, { brownie: 1 }), cashSessionId: d.id };
    expect((await call(w.app, w.terminals.A.token, 'POST', '/orders', { order, stockPolicy: 'strict' })).status).toBe(200);
    await put(d);
    const [row] = await w.sql`select cash_session_id from orders where id = ${order.id}`;
    expect(row!.cashSessionId).toBe(d.id);
  });
});
