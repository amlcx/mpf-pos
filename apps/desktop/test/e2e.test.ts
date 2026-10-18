// Real terminals' logic against the real API and Postgres; only the network
// in between is simulated, so it can be cut.
import { type World, call, createWorld, stockOf } from '@mpf/api/testing';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { ApiClient, type FetchLike } from '../src/lib/api.ts';
import { closeDrawer, drawerStatus, moveCash, openDrawer } from '../src/lib/cash.ts';
import { login } from '../src/lib/auth.ts';
import { cartFromOrder, checkout, checkoutInProgress } from '../src/lib/checkout.ts';
import { type LocalDb, migrateLocal } from '../src/lib/local-db.ts';
import { countBySyncStatus, getOrder, listProducts, loadContext } from '../src/lib/repo.ts';
import { type SyncDeps, syncOnce } from '../src/lib/sync.ts';
import { type Updater, Updates } from '../src/lib/updates.ts';
import { createNodeDb } from './node-db.ts';

let w: World;

const APP_VERSION = '0.1.0';

interface Terminal extends SyncDeps {
  /** hold: while set, requests wait for it before reaching the server. */
  net: { up: boolean; dropResponses: boolean; hold: Promise<void> | null };
  fetch: FetchLike;
  sell(items: Partial<Record<keyof World['products'], number>>, online?: boolean): ReturnType<typeof checkout>;
  available(product: keyof World['products']): Promise<number | null>;
}

async function terminal(code: 'A' | 'B', db: LocalDb = createNodeDb(), openDrawerFirst = true): Promise<Terminal> {
  const net: Terminal['net'] = { up: true, dropResponses: false, hold: null };
  const fetch: FetchLike = async (url, init) => {
    if (!net.up) throw new TypeError('fetch failed');
    if (net.hold) await net.hold;
    const res = await w.app.request(url, init);
    if (net.dropResponses) throw new TypeError('connection reset');
    return res;
  };
  const api = new ApiClient('http://api.test', w.terminals[code].token, fetch, APP_VERSION);
  await migrateLocal(db);
  const deps = { db, api };
  await syncOnce(deps);
  // Selling needs a counted drawer; these registers start with an empty one.
  if (openDrawerFirst) await openDrawer(db, { count: {}, userId: w.cashierId });
  return {
    ...deps,
    net,
    fetch,
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

/**
 * Updates for a terminal, with Tauri's updater replaced by one that asks the
 * real /updates route through the terminal's network, the way the plugin
 * does. Installing only records the version.
 */
function updatesFor(t: Terminal, updater?: Updater) {
  const installed: string[] = [];
  const viaServer: Updater = {
    async check(endpoint, terminalToken) {
      const url = endpoint
        .replace('{{target}}', 'windows')
        .replace('{{arch}}', 'x86_64')
        .replace('{{current_version}}', APP_VERSION);
      const res = await t.fetch(url, { headers: { Authorization: `Bearer ${terminalToken}` } });
      if (res.status === 204) return null;
      if (!res.ok) throw new Error(`update check answered ${res.status}`);
      const manifest = (await res.json()) as { version: string; notes: string };
      return {
        version: manifest.version,
        notes: manifest.notes,
        download: async () => {},
        install: async () => void installed.push(manifest.version),
      };
    },
  };
  const updates = new Updates({
    updater: updater ?? viaServer,
    server: () => ({ apiUrl: 'http://api.test', terminalToken: w.terminals.A.token }),
    busy: checkoutInProgress,
  });
  return { updates, installed };
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

  it('a sale voided for the wrong payment method is charged again as it was', async () => {
    const stockBefore = await stockOf(w, 'brownie');
    const first = await a.sell({ brownie: 2 }); // part cash, part digital
    if (!first.ok) throw new Error('unreachable');
    // The catalog moves on before the cashier notices the mistake.
    await w.sql`update products set price_cents = 1500 where id = ${w.products.brownie}`;
    await syncOnce(a);

    await a.api.voidOrder(first.order.id, 'Cambio de método de pago'); // still logged in as the cashier
    await syncOnce(a);
    const cart = cartFromOrder(first.order);
    expect(cart).toEqual([{ productId: w.products.brownie, name: 'Brownie', unitPriceCents: 1000, quantity: 2 }]);
    const again = await checkout(a, {
      cart,
      payments: [{ method: 'digital', amountCents: first.order.totalCents }],
      cashierId: w.cashierId,
      online: true,
    });
    expect(again).toMatchObject({ ok: true, synced: true, order: { totalCents: first.order.totalCents } });
    if (!again.ok) throw new Error('unreachable');
    expect(again.order.ticketSeq).toBeGreaterThan(first.order.ticketSeq);

    const rows = await w.sql<{ id: string; status: string }[]>`
      select id, status from orders where id in ${w.sql([first.order.id, again.order.id])} order by ticket_seq`;
    expect(rows.map((r) => r.status)).toEqual(['voided', 'completed']);
    const payments = await w.sql`select method, amount_cents from payments where order_id = ${again.order.id}`;
    expect(payments).toEqual([{ method: 'digital', amountCents: first.order.totalCents }]);
    // Sold once in the end: the void put back what the first sale took.
    expect(await stockOf(w, 'brownie')).toBe(stockBefore - 2);
    await w.sql`update products set price_cents = 1000 where id = ${w.products.brownie}`;
    await syncOnce(a);
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

  it('a loyalty card sale is charged at half, online or offline, and survives the sync', async () => {
    const coffee = (await listProducts(a.db)).find((p) => p.id === w.products.coffee)!;
    const sale = (online: boolean) =>
      checkout(a, {
        cart: [{ productId: coffee.id, name: coffee.name, unitPriceCents: coffee.priceCents, quantity: 2 }],
        payments: [{ method: 'cash', amountCents: coffee.priceCents, tenderedCents: coffee.priceCents }],
        cashierId: w.cashierId,
        discountKind: 'loyalty_card',
        online,
      });
    const online = await sale(true);
    expect(online).toMatchObject({ ok: true, synced: true, order: { discountKind: 'loyalty_card', totalCents: coffee.priceCents } });

    a.net.up = false;
    const offline = await sale(false);
    a.net.up = true;
    if (!online.ok || !offline.ok) throw new Error('unreachable');
    expect(offline.order).toMatchObject({ syncStatus: 'pending', discountCents: coffee.priceCents });
    await syncOnce(a);
    expect((await getOrder(a.db, offline.order.id))!.syncStatus).toBe('synced');
    const rows = await w.sql`
      select discount_kind, discount_cents, total_cents from orders where id in ${w.sql([online.order.id, offline.order.id])}`;
    const stored = { discountKind: 'loyalty_card', discountCents: coffee.priceCents, totalCents: coffee.priceCents };
    expect(rows).toEqual([stored, stored]);
  });

  it('logs in offline with cached credentials, without admin powers', async () => {
    a.net.up = false;
    expect(await login(a, 'cashier', 'wrong')).toBeNull();
    expect(await login(a, 'cashier', '1234')).toMatchObject({ online: false, user: { username: 'cashier' } });
    expect(a.api.sessionToken).toBeNull();
    a.net.up = true;
    expect(await login(a, 'cashier', 'wrong')).toBeNull();
  });

  it('tells the server which version it runs', async () => {
    const [row] = await w.sql<{ appVersion: string }[]>`select app_version from terminals where id = ${w.terminals.A.id}`;
    expect(row!.appVersion).toBe(APP_VERSION);
  });

  it('an update check while offline never blocks a sale', async () => {
    a.net.up = false;
    const { updates } = updatesFor(a);
    const checking = updates.check();
    expect(await a.sell({ coffee: 1 })).toMatchObject({ ok: true, synced: false });
    await expect(checking).resolves.toBeUndefined();
    expect(updates.state).toEqual({ status: 'idle' });

    // Nor does a check that never answers: it holds nothing a sale needs.
    const stuck = updatesFor(a, { check: () => new Promise(() => {}) }).updates;
    void stuck.check();
    expect(await a.sell({ coffee: 1 })).toMatchObject({ ok: true, synced: false });
    a.net.up = true;
    await syncOnce(a);
    expect(await countBySyncStatus(a.db)).toMatchObject({ pending: 0, submitting: 0 });
  });

  it('install is refused while a checkout is in progress', async () => {
    await w.sql`
      insert into register_releases (ring, version, url, signature)
      values ('stable', '0.2.0', 'https://github.com/amlcx/mpf-pos/releases/download/v0.2.0/setup.exe', 'sig')`;
    const { updates, installed } = updatesFor(a);
    await updates.check();
    expect(updates.state).toMatchObject({ status: 'ready', version: '0.2.0' });

    // The server is slow to confirm this sale: the checkout stays open.
    let answer!: () => void;
    a.net.hold = new Promise((resolve) => (answer = resolve));
    const sale = a.sell({ coffee: 1 });
    await vi.waitFor(() => expect(checkoutInProgress()).toBe(true));
    expect(await updates.install()).toBe('busy');
    expect(installed).toEqual([]);

    a.net.hold = null;
    answer();
    expect(await sale).toMatchObject({ ok: true, synced: true });
    expect(checkoutInProgress()).toBe(false);
    expect(await updates.install()).toBe('installing');
    expect(installed).toEqual(['0.2.0']);
    await w.sql`delete from register_releases`;
  });

  it('a reinstalled terminal continues its ticket numbers', async () => {
    const before = (await loadContext(a.db))!.nextTicketSeq;
    const fresh = await terminal('A');
    expect((await loadContext(fresh.db))!.nextTicketSeq).toBe(before);
    expect(await fresh.sell({ coffee: 1 })).toMatchObject({ ok: true, synced: true });
  });
});

describe('cash drawer', () => {
  /** A register as it is first thing in the morning: synced, drawer not opened. */
  const fresh = (code: 'A' | 'B') => terminal(code, createNodeDb(), false);

  it('selling needs a drawer opened for the day', async () => {
    const t = await fresh('B');
    const tickets = (await loadContext(t.db))!.nextTicketSeq;
    expect(await t.sell({ brownie: 1 })).toEqual({ ok: false, reason: 'drawer_closed' });
    expect((await loadContext(t.db))!.nextTicketSeq).toBe(tickets);

    const opened = await openDrawer(t.db, { count: { '2000000': 1 }, userId: w.cashierId });
    if (!opened.ok) throw new Error('unreachable');
    const sale = await t.sell({ brownie: 1 });
    expect(sale).toMatchObject({ ok: true, synced: true, order: { cashSessionId: opened.drawer.id } });
    expect(await openDrawer(t.db, { count: {}, userId: w.cashierId })).toEqual({ ok: false, reason: 'already_open' });
  });

  it('a whole day offline: opened, sold, cash moved, closed blind, and the server gets it all', async () => {
    await setStock('brownie', 50);
    const t = await fresh('A');
    t.net.up = false;
    const opened = await openDrawer(t.db, { count: { '5000000': 1 }, userId: w.cashierId }); // 50.000
    if (!opened.ok) throw new Error('unreachable');
    const products = await listProducts(t.db);
    const brownie = products.find((p) => p.id === w.products.brownie)!;
    // Five brownies at $10 each, paid in cash: one $50 coin.
    const sale = await checkout(t, {
      cart: [{ productId: brownie.id, name: brownie.name, unitPriceCents: brownie.priceCents, quantity: 5 }],
      payments: [{ method: 'cash', amountCents: 5000, tenderedCents: 5000 }],
      cashierId: w.cashierId,
      online: false,
    });
    expect(sale).toMatchObject({ ok: true, synced: false });
    expect(await moveCash(t.db, { kind: 'out', amountCents: 1_000_000, reason: 'A la caja fuerte', userId: w.cashierId })).toEqual({ ok: true });
    expect(await moveCash(t.db, { kind: 'in', amountCents: 200_000, reason: 'Más sencillo', userId: w.cashierId })).toEqual({ ok: true });
    expect(await moveCash(t.db, { kind: 'out', amountCents: 100, reason: '  ', userId: w.cashierId })).toEqual({ ok: false, reason: 'invalid' });

    // 50.000 + 50 - 10.000 + 2.000 = 42.050 expected. The cashier forgets the coin:
    const short = await closeDrawer(t.db, { count: { '2000000': 2, '200000': 1 }, userId: w.cashierId });
    expect(short).toEqual({ ok: false, reason: 'note_required', expectedCents: 4_205_000, countedCents: 4_200_000 });
    expect((await drawerStatus(t.db)).state).toBe('open'); // nothing saved yet
    // ...counts again and it matches.
    const closed = await closeDrawer(t.db, { count: { '2000000': 2, '200000': 1, '5000': 1 }, userId: w.cashierId });
    expect(closed).toMatchObject({ ok: true, expectedCents: 4_205_000, countedCents: 4_205_000 });
    expect((await drawerStatus(t.db)).state).toBe('closed');
    expect(await t.sell({ brownie: 1 }, false)).toEqual({ ok: false, reason: 'drawer_closed' });

    t.net.up = true;
    await syncOnce(t);
    const [row] = await w.sql`
      select terminal_id, opening_cents, counted_cents, expected_cents, close_note,
        (select count(*)::int from cash_movements m where m.session_id = s.id) as movements
      from cash_sessions s where id = ${opened.drawer.id}`;
    expect(row).toEqual({
      terminalId: w.terminals.A.id,
      openingCents: 5_000_000,
      countedCents: 4_205_000,
      expectedCents: 4_205_000,
      closeNote: '',
      movements: 2,
    });
    if (!sale.ok) throw new Error('unreachable');
    const [order] = await w.sql`select cash_session_id from orders where id = ${sale.order.id}`;
    expect(order!.cashSessionId).toBe(opened.drawer.id);
    // Nothing left to send: a second round changes nothing.
    await syncOnce(t);
    expect((await w.sql`select count(*)::int as n from cash_movements where session_id = ${opened.drawer.id}`)[0]!.n).toBe(2);
  });

  it('a drawer left open from an earlier day is closed before anything else', async () => {
    const t = await fresh('B');
    const yesterday = new Date(Date.now() - 30 * 60 * 60 * 1000);
    await openDrawer(t.db, { count: {}, userId: w.cashierId, now: yesterday });
    expect((await drawerStatus(t.db)).state).toBe('stale');
    expect(await t.sell({ brownie: 1 })).toEqual({ ok: false, reason: 'drawer_closed' });
    expect(await openDrawer(t.db, { count: {}, userId: w.cashierId })).toEqual({ ok: false, reason: 'already_open' });

    expect(await closeDrawer(t.db, { count: {}, userId: w.cashierId })).toMatchObject({ ok: true });
    expect((await openDrawer(t.db, { count: {}, userId: w.cashierId })).ok).toBe(true);
    expect(await t.sell({ brownie: 1 })).toMatchObject({ ok: true, synced: true });
  });
});
