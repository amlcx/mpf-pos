// Real terminals' logic against the real API and Postgres; only the network
// in between is simulated, so it can be cut.
import { type World, call, createWorld, stockOf } from '@mpf/api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApiClient } from '../src/lib/api.ts';
import { login } from '../src/lib/auth.ts';
import { checkout } from '../src/lib/checkout.ts';
import { type LocalDb, migrateLocal } from '../src/lib/local-db.ts';
import { countBySyncStatus, getOrder, listProducts, loadContext } from '../src/lib/repo.ts';
import { type SyncDeps, syncOnce } from '../src/lib/sync.ts';
import { createNodeDb } from './node-db.ts';

let w: World;

interface Terminal extends SyncDeps {
  net: { up: boolean; dropResponses: boolean };
  sell(items: Partial<Record<keyof World['products'], number>>, online?: boolean): ReturnType<typeof checkout>;
  available(product: keyof World['products']): Promise<number | null>;
}

async function terminal(code: 'A' | 'B', db: LocalDb = createNodeDb()): Promise<Terminal> {
  const net = { up: true, dropResponses: false };
  const api = new ApiClient('http://api.test', w.terminals[code].token, async (url, init) => {
    if (!net.up) throw new TypeError('fetch failed');
    const res = await w.app.request(url, init);
    if (net.dropResponses) throw new TypeError('connection reset');
    return res;
  });
  await migrateLocal(db);
  const deps = { db, api };
  await syncOnce(deps);
  return {
    ...deps,
    net,
    async sell(items, online = net.up) {
      const products = await listProducts(db);
      const cart = Object.entries(items).map(([name, quantity]) => {
        const p = products.find((x) => x.id === w.products[name as keyof World['products']])!;
        return { productId: p.id, name: p.name, unitPriceCents: p.priceCents, quantity: quantity! };
      });
      const total = cart.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
      return checkout(deps, {
        cart,
        payments: [
          { method: 'cash', amountCents: 500, tenderedCents: 1000 },
          { method: 'digital', amountCents: total - 500 },
        ],
        cashierId: w.cashierId,
        online,
      });
    },
    async available(product) {
      return (await listProducts(db)).find((p) => p.id === w.products[product])!.available;
    },
  };
}

async function setStock(product: 'flan' | 'brownie', quantity: number) {
  const session = (await call(w.app, w.terminals.A.token, 'POST', '/auth/login', { username: 'admin', password: 'admin123' })).json.token;
  await call(w.app, w.terminals.A.token, 'PUT', `/admin/products/${w.products[product]}/stock`, { quantity }, session);
}

beforeAll(async () => {
  w = await createWorld('e2e');
});
afterAll(() => w.close());

describe('terminals against the server', () => {
  let a: Terminal;
  let b: Terminal;

  it('pulls the catalog on first sync', async () => {
    a = await terminal('A');
    b = await terminal('B');
    expect(await a.available('flan')).toBe(3);
    expect(await a.available('coffee')).toBeNull();
    expect((await loadContext(a.db))!.store.code).toBe('MAIN');
  });

  it('online sale: confirmed by the server before it counts', async () => {
    const result = await a.sell({ flan: 2, coffee: 1 });
    expect(result).toMatchObject({ ok: true, synced: true, order: { ticketNumber: 'A-0001' } });
    expect(await stockOf(w, 'flan')).toBe(1);
    expect(await a.available('flan')).toBe(1);
    expect((await loadContext(a.db))!.nextTicketSeq).toBe(2);
  });

  it('online sale: a terminal with stale stock cannot sell the same dessert', async () => {
    expect(await b.available('flan')).toBe(3); // B has not synced since A's sale
    const result = await b.sell({ flan: 2 });
    expect(result).toMatchObject({ ok: false, reason: 'insufficient_stock', items: [{ available: 1 }] });
    // Nothing is left behind, the ticket number is free again, stock is fresh.
    expect(await countBySyncStatus(b.db)).toMatchObject({ submitting: 0, pending: 0, synced: 0 });
    expect((await loadContext(b.db))!.nextTicketSeq).toBe(1);
    expect(await b.available('flan')).toBe(1);
    expect(await stockOf(w, 'flan')).toBe(1);
  });

  it('refuses locally what the terminal already knows is gone', async () => {
    const result = await a.sell({ flan: 5 });
    expect(result).toMatchObject({ ok: false, reason: 'insufficient_stock' });
    expect((await loadContext(a.db))!.nextTicketSeq).toBe(2);
  });

  it('offline: both terminals sell the last unit; sync flags the oversell', async () => {
    a.net.up = b.net.up = false;
    const fromA = await a.sell({ flan: 1 });
    const fromB = await b.sell({ flan: 1, brownie: 2 });
    expect(fromA).toMatchObject({ ok: true, synced: false });
    expect(fromB).toMatchObject({ ok: true, synced: false, order: { ticketNumber: 'B-0001' } });
    expect(await a.available('flan')).toBe(0); // counted locally right away
    expect(await stockOf(w, 'flan')).toBe(1); // the server has not heard yet
    expect((await syncOnce(a)).online).toBe(false);

    a.net.up = b.net.up = true;
    expect((await syncOnce(a)).online).toBe(true);
    await syncOnce(b);
    expect(await stockOf(w, 'flan')).toBe(-1);
    expect(await stockOf(w, 'brownie')).toBe(8);
    if (!fromA.ok || !fromB.ok) throw new Error('unreachable');
    expect(await getOrder(a.db, fromA.order.id)).toMatchObject({ syncStatus: 'synced', oversold: false });
    expect(await getOrder(b.db, fromB.order.id)).toMatchObject({ syncStatus: 'synced', oversold: true });
    const conflicts = await w.sql`select shortfall from stock_conflicts where order_id = ${fromB.order.id}`;
    expect(conflicts).toEqual([{ shortfall: 1 }]);
    // A synced before B's sale arrived; it learns of it on its next round.
    expect(await a.available('flan')).toBe(0);
    await syncOnce(a);
    expect(await a.available('flan')).toBe(-1);
  });

  it('a lost response never records or charges stock twice', async () => {
    await setStock('brownie', 10);
    await syncOnce(a);
    a.net.dropResponses = true;
    const result = await a.sell({ brownie: 3 });
    expect(result).toMatchObject({ ok: true, synced: false }); // the client could not know
    expect(await stockOf(w, 'brownie')).toBe(7); // but the server did record it
    expect(await a.available('brownie')).toBe(7);

    a.net.dropResponses = false;
    await syncOnce(a);
    if (!result.ok) throw new Error('unreachable');
    expect((await getOrder(a.db, result.order.id))!.syncStatus).toBe('synced');
    expect(await stockOf(w, 'brownie')).toBe(7);
    expect(await a.available('brownie')).toBe(7);
    const rows = await w.sql`select 1 from orders where id = ${result.order.id}`;
    expect(rows).toHaveLength(1);
  });

  it('a void on the server reaches the terminal that made the sale', async () => {
    const result = await a.sell({ brownie: 1 });
    if (!result.ok) throw new Error('unreachable');
    expect(await login(a, 'admin', 'admin123')).toMatchObject({ online: true, user: { role: 'admin' } });
    await a.api.voidOrder(result.order.id, 'customer changed their mind');
    await syncOnce(a);
    expect((await getOrder(a.db, result.order.id))!.status).toBe('voided');
    expect(await a.available('brownie')).toBe(7);
  });

  it('a cashier voids their own sale once logged in online', async () => {
    const result = await a.sell({ brownie: 2 });
    if (!result.ok) throw new Error('unreachable');
    expect(await login(a, 'cashier', '1234')).toMatchObject({ online: true, user: { role: 'cashier' } });
    await a.api.voidOrder(result.order.id, 'rang it up twice');
    await syncOnce(a);
    expect((await getOrder(a.db, result.order.id))!.status).toBe('voided');
    expect(await a.available('brownie')).toBe(7);
    const [row] = await w.sql`select voided_by, void_reason from orders where id = ${result.order.id}`;
    expect(row).toEqual({ voidedBy: w.cashierId, voidReason: 'rang it up twice' });
  });

  it('a product marked sold out on one terminal stops selling on the other', async () => {
    await a.api.setSoldOut(w.products.coffee, true); // still logged in as the cashier
    // B has not heard yet: the server refuses, and B comes back up to date.
    expect(await b.available('coffee')).toBeNull();
    expect(await b.sell({ coffee: 1 })).toMatchObject({ ok: false, reason: 'insufficient_stock', items: [{ available: 0 }] });
    expect(await b.available('coffee')).toBe(0);
    // Now B knows, and refuses without asking, online or not.
    const tickets = (await loadContext(b.db))!.nextTicketSeq;
    expect(await b.sell({ coffee: 1 }, false)).toMatchObject({ ok: false, reason: 'insufficient_stock' });
    expect((await loadContext(b.db))!.nextTicketSeq).toBe(tickets);

    await a.api.setSoldOut(w.products.coffee, false);
    await syncOnce(b);
    expect(await b.available('coffee')).toBeNull();
    expect(await b.sell({ coffee: 1 })).toMatchObject({ ok: true, synced: true });
  });

  it('logs in offline with cached credentials, without admin powers', async () => {
    a.net.up = false;
    expect(await login(a, 'cashier', 'wrong')).toBeNull();
    expect(await login(a, 'cashier', '1234')).toMatchObject({ online: false, user: { username: 'cashier' } });
    expect(a.api.sessionToken).toBeNull();
    a.net.up = true;
    expect(await login(a, 'cashier', 'wrong')).toBeNull();
  });

  it('a reinstalled terminal continues its ticket numbers', async () => {
    const before = (await loadContext(a.db))!.nextTicketSeq;
    const fresh = await terminal('A');
    expect((await loadContext(fresh.db))!.nextTicketSeq).toBe(before);
    expect(await fresh.sell({ coffee: 1 })).toMatchObject({ ok: true, synced: true });
  });
});
