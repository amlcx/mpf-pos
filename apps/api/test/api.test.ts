import type { PullResponse } from '@mpf/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore, createTerminal } from '../src/fixtures.ts';
import { type World, call, createWorld, makeOrder, stockOf } from './helpers.ts';

let w: World;
let seq = 0;
let adminSession: string;
let cashierSession: string;
const tokenA = () => w.terminals.A.token;
const tokenB = () => w.terminals.B.token;

beforeAll(async () => {
  w = await createWorld('api');
  adminSession = (await call(w.app, tokenA(), 'POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  cashierSession = (await call(w.app, tokenA(), 'POST', '/auth/login', { username: 'cashier', password: '1234' })).json.token;
});
afterAll(() => w.close());

const setStock = (product: 'flan' | 'brownie', quantity: number) =>
  call(w.app, tokenA(), 'PUT', `/admin/products/${w.products[product]}/stock`, { quantity }, adminSession);

describe('auth and sync', () => {
  it('rejects unknown terminals and bad logins', async () => {
    expect((await call(w.app, null, 'GET', '/sync/pull')).status).toBe(401);
    expect((await call(w.app, 'mpf_nope', 'GET', '/sync/pull')).status).toBe(401);
    const bad = await call(w.app, tokenA(), 'POST', '/auth/login', { username: 'admin', password: 'x' });
    expect(bad.status).toBe(401);
    expect(adminSession).toBeTruthy();
  });

  it('pulls a full snapshot for the terminal store', async () => {
    const { status, json } = await call<PullResponse>(w.app, tokenA(), 'GET', '/sync/pull');
    expect(status).toBe(200);
    expect(json.store.code).toBe('MAIN');
    expect(json.terminal).toMatchObject({ code: 'A', lastTicketSeq: 0 });
    const byName = Object.fromEntries(json.products.map((p) => [p.name, p.stockQty]));
    expect(byName).toEqual({ Flan: 3, Brownie: 10, Coffee: null });
    expect(json.users.map((u) => u.username).sort()).toEqual(['admin', 'cashier']);
    expect(json.users[0]!.passwordHash).toMatch(/^pbkdf2\$/);
  });
});

describe('orders and stock', () => {
  it('strict: decrements stock, then rejects what is not there', async () => {
    const ok = await call(w.app, tokenA(), 'POST', '/orders', {
      order: makeOrder(w, 'A', ++seq, { flan: 2, coffee: 5 }),
      stockPolicy: 'strict',
    });
    expect(ok).toEqual({ status: 200, json: { status: 'accepted', oversold: [] } });
    expect(await stockOf(w, 'flan')).toBe(1);

    const rejected = makeOrder(w, 'B', 1, { flan: 2, brownie: 1 });
    const no = await call(w.app, tokenB(), 'POST', '/orders', { order: rejected, stockPolicy: 'strict' });
    expect(no.status).toBe(409);
    expect(no.json).toEqual({
      error: 'insufficient_stock',
      items: [{ productId: w.products.flan, requested: 2, available: 1 }],
    });
    // Nothing from the rejected order was kept.
    expect(await stockOf(w, 'flan')).toBe(1);
    expect(await stockOf(w, 'brownie')).toBe(10);
    expect(await w.sql`select 1 from orders where id = ${rejected.id}`).toHaveLength(0);
  });

  it('strict: concurrent terminals never sell the same unit twice', async () => {
    await setStock('flan', 3);
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        call(w.app, i % 2 ? tokenA() : tokenB(), 'POST', '/orders', {
          order: makeOrder(w, i % 2 ? 'A' : 'B', 100 + i, { flan: 1 }),
          stockPolicy: 'strict',
        }),
      ),
    );
    expect(results.filter((r) => r.status === 200)).toHaveLength(3);
    expect(results.filter((r) => r.status === 409)).toHaveLength(5);
    expect(await stockOf(w, 'flan')).toBe(0);
  });

  it('is idempotent on the order id', async () => {
    await setStock('brownie', 10);
    const order = makeOrder(w, 'A', ++seq, { brownie: 2 });
    const first = await call(w.app, tokenA(), 'POST', '/orders', { order, stockPolicy: 'strict' });
    const again = await call(w.app, tokenA(), 'POST', '/orders', { order, stockPolicy: 'accept' });
    expect(first.json.status).toBe('accepted');
    expect(again.json.status).toBe('duplicate');
    expect(await stockOf(w, 'brownie')).toBe(8);
  });

  it('rejects orders whose arithmetic is wrong', async () => {
    const order = makeOrder(w, 'A', ++seq, { brownie: 1 });
    order.totalCents += 1;
    const res = await call(w.app, tokenA(), 'POST', '/orders', { order, stockPolicy: 'strict' });
    expect(res.status).toBe(400);
    expect(res.json.error).toBe('invalid_order');
  });

  it('accept: records an offline oversell as a conflict; void undoes it', async () => {
    await setStock('flan', 1);
    const order = makeOrder(w, 'A', ++seq, { flan: 3 });
    const res = await call(w.app, tokenA(), 'POST', '/orders', { order, stockPolicy: 'accept' });
    expect(res.json).toEqual({
      status: 'accepted',
      oversold: [{ productId: w.products.flan, shortfall: 2 }],
    });
    expect(await stockOf(w, 'flan')).toBe(-2);

    const list = await call(w.app, tokenA(), 'GET', '/admin/conflicts', undefined, adminSession);
    expect(list.json.conflicts).toMatchObject([
      { orderId: order.id, ticketNumber: order.ticketNumber, productName: 'Flan', shortfall: 2 },
    ]);

    const voided = await call(w.app, tokenA(), 'POST', `/orders/${order.id}/void`, { reason: 'oversold' }, adminSession);
    expect(voided.json.status).toBe('voided');
    expect(await stockOf(w, 'flan')).toBe(1);
    const after = await call(w.app, tokenA(), 'GET', '/admin/conflicts', undefined, adminSession);
    expect(after.json.conflicts).toEqual([]);

    // Voiding twice does not return the stock twice.
    const twice = await call(w.app, tokenA(), 'POST', `/orders/${order.id}/void`, { reason: 'again' }, adminSession);
    expect(twice.json.status).toBe('already_voided');
    expect(await stockOf(w, 'flan')).toBe(1);

    const pull = await call<PullResponse>(w.app, tokenA(), 'GET', '/sync/pull');
    expect(pull.json.voidedOrderIds).toEqual([order.id]);
    expect(pull.json.terminal.lastTicketSeq).toBeGreaterThanOrEqual(seq);
  });

  it('keeps a ledger row for every stock change', async () => {
    const rows = await w.sql<{ productId: string; moved: number; quantity: number }[]>`
      select s.product_id, s.quantity,
        (select coalesce(sum(delta), 0)::int from stock_movements m
          where m.product_id = s.product_id and m.store_id = s.store_id) as moved
      from stock s`;
    // Fixtures insert opening stock directly: flan 3, brownie 10.
    const opening = { [w.products.flan]: 3, [w.products.brownie]: 10 };
    for (const row of rows) expect(row.quantity).toBe(opening[row.productId]! + row.moved);
  });
});

describe('admin', () => {
  it('requires an admin session', async () => {
    const input = { name: 'Alfajor', priceCents: 800 };
    expect((await call(w.app, tokenA(), 'POST', '/admin/products', input)).status).toBe(401);
    expect((await call(w.app, tokenA(), 'POST', '/admin/products', input, cashierSession)).status).toBe(403);
    expect((await call(w.app, tokenA(), 'POST', '/admin/products', input, 'garbage')).status).toBe(401);
  });

  it('creates and edits products', async () => {
    const created = await call(w.app, tokenA(), 'POST', '/admin/products', { name: ' Alfajor ', priceCents: 800 }, adminSession);
    expect(created.status).toBe(201);
    expect(created.json).toMatchObject({ name: 'Alfajor', category: '', trackStock: true, stockQty: 0 });

    const id = created.json.id;
    const patched = await call(w.app, tokenA(), 'PATCH', `/admin/products/${id}`, { priceCents: 850, active: false }, adminSession);
    expect(patched.json).toMatchObject({ priceCents: 850, active: false, name: 'Alfajor' });

    const stocked = await call(w.app, tokenA(), 'PUT', `/admin/products/${id}/stock`, { quantity: 25 }, adminSession);
    expect(stocked.json.stockQty).toBe(25);
    const bad = await call(w.app, tokenA(), 'PATCH', `/admin/products/${id}`, { priceCents: -1 }, adminSession);
    expect(bad.status).toBe(400);
  });
});

describe('reports', () => {
  const query = (from: Date, to: Date) => `/admin/orders?from=${from.toISOString()}&to=${to.toISOString()}`;
  const hour = 3_600_000;

  it('lists the store orders in a time range, with lines and payments', async () => {
    const order = makeOrder(w, 'B', 900, { coffee: 2 });
    await call(w.app, tokenB(), 'POST', '/orders', { order, stockPolicy: 'strict' });
    const now = Date.now();
    const res = await call(w.app, tokenA(), 'GET', query(new Date(now - hour), new Date(now + hour)), undefined, adminSession);
    expect(res.status).toBe(200);
    const found = res.json.orders.find((o: { id: string }) => o.id === order.id);
    expect(found).toMatchObject({
      ticketNumber: 'B-0900',
      status: 'completed',
      cashierName: 'Cashier',
      totalCents: 1800,
      lines: [{ name: 'coffee', quantity: 2, lineTotalCents: 1800 }],
      payments: [{ method: 'digital', amountCents: 1800, tenderedCents: null }],
    });
    expect(res.json.orders.some((o: { status: string }) => o.status === 'voided')).toBe(true);
    const total = await w.sql`select count(*)::int as n from orders where store_id = ${w.storeId}`;
    expect(res.json.orders).toHaveLength(total[0]!.n);

    const past = await call(w.app, tokenA(), 'GET', query(new Date(now - 3 * hour), new Date(now - 2 * hour)), undefined, adminSession);
    expect(past.json.orders).toEqual([]);
  });

  it('is admin only and validates the range', async () => {
    const path = query(new Date(0), new Date());
    expect((await call(w.app, tokenA(), 'GET', path, undefined, cashierSession)).status).toBe(403);
    expect((await call(w.app, tokenA(), 'GET', '/admin/orders?from=yesterday', undefined, adminSession)).status).toBe(400);
  });
});

describe('multiple stores', () => {
  it('keeps stock and orders separate per store', async () => {
    const otherStore = await createStore(w.sql, { code: 'NORTH', name: 'North' });
    const other = await createTerminal(w.sql, { storeId: otherStore, code: 'A', name: 'North A' });

    const pull = await call<PullResponse>(w.app, other.token, 'GET', '/sync/pull');
    expect(pull.json.store.code).toBe('NORTH');
    expect(pull.json.products.find((p) => p.name === 'Brownie')!.stockQty).toBe(0);
    // The MAIN-only cashier cannot log in at NORTH; the org-wide admin can.
    expect(pull.json.users.map((u) => u.username)).toEqual(['admin']);

    const before = await stockOf(w, 'brownie');
    const res = await call(w.app, other.token, 'POST', '/orders', {
      order: { ...makeOrder(w, 'A', 1, { brownie: 1 }), cashierId: w.adminId },
      stockPolicy: 'strict',
    });
    expect(res.status).toBe(409);
    expect(await stockOf(w, 'brownie')).toBe(before);

    const mainOrder = makeOrder(w, 'A', ++seq, { coffee: 1 });
    await call(w.app, tokenA(), 'POST', '/orders', { order: mainOrder, stockPolicy: 'strict' });
    const session = (await call(w.app, other.token, 'POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
    const cross = await call(w.app, other.token, 'POST', `/orders/${mainOrder.id}/void`, { reason: 'x' }, session);
    expect(cross.status).toBe(404);
  });
});
