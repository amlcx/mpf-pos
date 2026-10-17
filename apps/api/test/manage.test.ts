import type { PullResponse } from '@mpf/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createStore, createUser } from '../src/fixtures.ts';
import { type World, call, createWorld, makeOrder, stockOf } from './helpers.ts';

let w: World;
let org: string; // session of the admin with no store: may do everything
let local: string; // session of an admin tied to MAIN
let northId: string;

const login = (username: string, password: string) =>
  call(w.app, null, 'POST', '/manage/login', { username, password });
/** A /manage call: no terminal token, only a session. */
const manage = (session: string | undefined, method: string, path: string, body?: unknown) =>
  call(w.app, null, method, `/manage${path}`, body, session);

beforeAll(async () => {
  w = await createWorld('manage');
  northId = await createStore(w.sql, { code: 'NORTH', name: 'North' });
  await createUser(w.sql, { username: 'boss', name: 'Store Boss', role: 'admin', password: 'boss-password', storeId: w.storeId });
  org = (await login('admin', 'admin123')).json.token;
  local = (await login('boss', 'boss-password')).json.token;
});
afterAll(() => w.close());

describe('panel login', () => {
  it('lets admins in without a terminal, and nobody else', async () => {
    expect(org).toBeTruthy();
    expect((await login('cashier', '1234')).status).toBe(403);
    expect((await login('admin', 'nope')).status).toBe(401);
    expect((await manage(undefined, 'GET', '/stores')).status).toBe(401);
    expect((await manage('garbage', 'GET', '/stores')).status).toBe(401);
    const me = await manage(local, 'GET', '/me');
    expect(me.json.user).toMatchObject({ username: 'boss', storeId: w.storeId });
    expect(me.json.user.passwordHash).toBeUndefined();
  });

  it('locks a username after repeated failures', async () => {
    await createUser(w.sql, { username: 'victim', name: 'V', role: 'admin', password: 'right-password' });
    for (let i = 0; i < 5; i++) expect((await login('victim', 'wrong')).status).toBe(401);
    expect((await login('victim', 'right-password')).status).toBe(429);
    expect((await login('admin', 'admin123')).status).toBe(200); // others are unaffected
  });
});

describe('store scoping', () => {
  it('a store admin sees and touches only their store', async () => {
    expect((await manage(org, 'GET', '/stores')).json.stores).toHaveLength(2);
    expect((await manage(local, 'GET', '/stores')).json.stores).toMatchObject([{ code: 'MAIN' }]);
    for (const path of ['/terminals', '/products', '/conflicts', `/orders?from=${new Date(0).toISOString()}&to=${new Date().toISOString()}`]) {
      expect((await manage(local, 'GET', `/stores/${northId}${path}`)).status, path).toBe(403);
      expect((await manage(local, 'GET', `/stores/${w.storeId}${path}`)).status, path).toBe(200);
    }
    expect((await manage(local, 'PATCH', `/stores/${northId}`, { name: 'Mine now' })).status).toBe(403);
    expect((await manage(local, 'PUT', `/stores/${northId}/products/${w.products.flan}/stock`, { quantity: 99 })).status).toBe(403);
    expect((await manage(local, 'PUT', `/stores/${northId}/products/${w.products.coffee}/sold-out`, { soldOut: true })).status).toBe(403);
    const soldOut = await manage(local, 'PUT', `/stores/${w.storeId}/products/${w.products.coffee}/sold-out`, { soldOut: true });
    expect(soldOut.json.product).toMatchObject({ soldOut: true });
    const north = (await manage(org, 'GET', `/stores/${northId}/products`)).json.products;
    expect(north.some((p: { soldOut: boolean }) => p.soldOut)).toBe(false);
    await manage(local, 'PUT', `/stores/${w.storeId}/products/${w.products.coffee}/sold-out`, { soldOut: false });
    expect((await manage(local, 'POST', '/stores', { code: 'X', name: 'X' })).status).toBe(403);
  });

  it('a store admin cannot create or reach people outside their store', async () => {
    const outsider = { username: 'outsider', name: 'O', role: 'admin', password: 'long-enough', storeId: null };
    expect((await manage(local, 'POST', '/users', outsider)).status).toBe(403);
    expect((await manage(local, 'POST', '/users', { ...outsider, storeId: northId })).status).toBe(403);
    const visible = (await manage(local, 'GET', '/users')).json.users.map((u: { username: string }) => u.username);
    expect(visible.sort()).toEqual(['boss', 'cashier']);
    expect((await manage(local, 'PATCH', `/users/${w.adminId}`, { active: false })).status).toBe(404);
    expect((await manage(local, 'PATCH', `/users/${w.cashierId}`, { storeId: null })).status).toBe(403);
  });
});

describe('stores and registers', () => {
  it('creates a store and enrols a register whose token works once issued', async () => {
    const created = await manage(org, 'POST', '/stores', { code: 'sur', name: 'Sur', taxRateBps: 800 });
    expect(created.status).toBe(201);
    expect(created.json.store).toMatchObject({ code: 'SUR', currencySymbol: '$', taxRateBps: 800, taxIncluded: true });
    expect((await manage(org, 'POST', '/stores', { code: 'SUR', name: 'Again' })).status).toBe(409);
    const storeId = created.json.store.id;
    const patched = await manage(org, 'PATCH', `/stores/${storeId}`, { name: 'Sede Sur', taxIncluded: false });
    expect(patched.json.store).toMatchObject({ name: 'Sede Sur', taxIncluded: false, taxRateBps: 800 });

    const enrolled = await manage(org, 'POST', `/stores/${storeId}/terminals`, { code: 'a', name: 'Caja A' });
    expect(enrolled.status).toBe(201);
    const { terminal, token } = enrolled.json;
    expect(terminal).toMatchObject({ code: 'A', active: true, lastSeenAt: null });
    const pull = await call<PullResponse>(w.app, token, 'GET', '/sync/pull');
    expect(pull.json.store.name).toBe('Sede Sur');

    const listed = await manage(org, 'GET', `/stores/${storeId}/terminals`);
    expect(listed.json.terminals[0].lastSeenAt).not.toBeNull();
    expect(JSON.stringify(listed.json)).not.toContain('token');

    const rotated = await manage(org, 'POST', `/stores/${storeId}/terminals/${terminal.id}/token`);
    expect((await call(w.app, token, 'GET', '/sync/pull')).status).toBe(401);
    expect((await call(w.app, rotated.json.token, 'GET', '/sync/pull')).status).toBe(200);

    await manage(org, 'PATCH', `/stores/${storeId}/terminals/${terminal.id}`, { active: false });
    expect((await call(w.app, rotated.json.token, 'GET', '/sync/pull')).status).toBe(401);
    // A register cannot be reached through another store's URL.
    expect((await manage(org, 'PATCH', `/stores/${northId}/terminals/${terminal.id}`, { active: true })).status).toBe(404);
  });

  it('puts a register in a release ring and shows the version it runs', async () => {
    const path = `/stores/${w.storeId}/terminals/${w.terminals.A.id}`;
    await w.app.request('/sync/pull', { headers: { Authorization: `Bearer ${w.terminals.A.token}`, 'X-App-Version': '1.4.0' } });
    const before = (await manage(local, 'GET', `/stores/${w.storeId}/terminals`)).json.terminals;
    expect(before.find((t: { id: string }) => t.id === w.terminals.A.id)).toMatchObject({
      appVersion: '1.4.0',
      releaseRing: 'stable',
    });

    const moved = await manage(local, 'PATCH', path, { releaseRing: 'pilot' });
    expect(moved.json.terminal).toMatchObject({ releaseRing: 'pilot', appVersion: '1.4.0' });
    expect((await manage(local, 'PATCH', path, { releaseRing: 'beta' })).status).toBe(400);
    // Through storeParam like every store route: a store admin cannot reach another store.
    expect((await manage(local, 'PATCH', `/stores/${northId}/terminals/${w.terminals.A.id}`, { releaseRing: 'stable' })).status).toBe(403);
    await manage(local, 'PATCH', path, { releaseRing: 'stable' });
  });
});

describe('users', () => {
  it('creates, edits and resets passwords', async () => {
    const created = await manage(org, 'POST', '/users', { username: ' Ana.Perez ', name: 'Ana', role: 'cashier', storeId: w.storeId, password: '4321' });
    expect(created.status).toBe(201);
    expect(created.json.user).toMatchObject({ username: 'ana.perez', role: 'cashier', active: true });
    expect(created.json.user.passwordHash).toBeUndefined();
    const id = created.json.user.id;
    const terminalLogin = (password: string) =>
      call(w.app, w.terminals.A.token, 'POST', '/auth/login', { username: 'ana.perez', password });
    expect((await terminalLogin('4321')).status).toBe(200);

    await manage(org, 'PATCH', `/users/${id}`, { password: '9999', name: 'Ana P.' });
    expect((await terminalLogin('4321')).status).toBe(401);
    expect((await terminalLogin('9999')).status).toBe(200);

    await manage(org, 'PATCH', `/users/${id}`, { active: false });
    expect((await terminalLogin('9999')).status).toBe(401);
    expect((await manage(org, 'POST', '/users', { username: 'ana.perez', name: 'Dup', role: 'cashier', storeId: null, password: '1111' })).status).toBe(409);
  });

  it('demands real passwords for admins', async () => {
    const short = { username: 'shorty', name: 'S', role: 'admin', storeId: null, password: '1234' };
    expect((await manage(org, 'POST', '/users', short)).json.error).toBe('admin_password_too_short');
    // Promoting a cashier needs a new password, so a PIN never opens the panel.
    expect((await manage(org, 'PATCH', `/users/${w.cashierId}`, { role: 'admin' })).json.error).toBe('admin_password_required');
    expect((await manage(org, 'PATCH', `/users/${w.cashierId}`, { role: 'admin', password: 'short' })).status).toBe(400);
    expect((await login('cashier', '1234')).status).toBe(403);
  });

  it('will not let admins lock themselves out, and cuts access at once', async () => {
    for (const patch of [{ active: false }, { role: 'cashier' }, { storeId: northId }]) {
      expect((await manage(org, 'PATCH', `/users/${w.adminId}`, patch)).json.error).toBe('cannot_change_own_access');
    }
    const bossId = (await manage(local, 'GET', '/me')).json.user.id;
    await manage(org, 'PATCH', `/users/${bossId}`, { role: 'cashier' });
    expect((await manage(local, 'GET', '/stores')).status).toBe(403);
    await manage(org, 'PATCH', `/users/${bossId}`, { role: 'admin', password: 'boss-password' });
    expect((await manage(local, 'GET', '/stores')).status).toBe(200);
  });
});

describe('catalog and stock', () => {
  it('edits the catalog and keeps stock per store, with a ledger', async () => {
    const created = await manage(local, 'POST', '/products', { name: 'Alfajor', priceCents: 800_000 });
    const id = created.json.id;
    await manage(local, 'PATCH', `/products/${id}`, { category: 'Horneados' });
    const stockUrl = (storeId: string) => `/stores/${storeId}/products/${id}/stock`;

    expect((await manage(org, 'PUT', stockUrl(w.storeId), { quantity: 10 })).json.product.stockQty).toBe(10);
    expect((await manage(org, 'PUT', stockUrl(w.storeId), { delta: 5 })).json.product.stockQty).toBe(15);
    expect((await manage(org, 'PUT', stockUrl(w.storeId), { delta: -20 })).json.error).toBe('stock_would_be_negative');
    expect((await manage(org, 'PUT', stockUrl(w.storeId), { delta: -15 })).json.product.stockQty).toBe(0);
    expect((await manage(org, 'PUT', stockUrl(northId), { quantity: 3 })).json.product.stockQty).toBe(3);
    expect((await manage(org, 'PUT', stockUrl(w.storeId), { quantity: -1 })).status).toBe(400);

    const main = (await manage(org, 'GET', `/stores/${w.storeId}/products`)).json.products;
    expect(main.find((p: { id: string }) => p.id === id)).toMatchObject({ category: 'Horneados', stockQty: 0 });
    const moves = await w.sql`
      select delta from stock_movements where product_id = ${id} and store_id = ${w.storeId} order by created_at, delta desc`;
    expect(moves.map((m) => m.delta).sort((a, b) => a - b)).toEqual([-15, 5, 10]);
  });
});

describe('orders', () => {
  it('reports and voids orders of a store', async () => {
    const order = makeOrder(w, 'A', 1, { flan: 2 });
    await call(w.app, w.terminals.A.token, 'POST', '/orders', { order, stockPolicy: 'accept' });
    const oversell = makeOrder(w, 'A', 2, { flan: 2 });
    await call(w.app, w.terminals.A.token, 'POST', '/orders', { order: oversell, stockPolicy: 'accept' });

    const range = `from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${new Date(Date.now() + 3_600_000).toISOString()}`;
    const report = await manage(local, 'GET', `/stores/${w.storeId}/orders?${range}`);
    expect(report.json.orders.map((o: { ticketNumber: string }) => o.ticketNumber)).toEqual(['A-0002', 'A-0001']);
    expect((await manage(org, 'GET', `/stores/${northId}/orders?${range}`)).json.orders).toEqual([]);

    const conflicts = (await manage(local, 'GET', `/stores/${w.storeId}/conflicts`)).json.conflicts;
    expect(conflicts).toMatchObject([{ orderId: oversell.id, shortfall: 1 }]);
    // Not through the wrong store.
    expect((await manage(org, 'POST', `/stores/${northId}/orders/${oversell.id}/void`, { reason: 'x' })).status).toBe(404);
    expect((await manage(org, 'POST', `/stores/${northId}/conflicts/${conflicts[0].id}/resolve`, { resolution: 'ok' })).status).toBe(404);

    const voided = await manage(local, 'POST', `/stores/${w.storeId}/orders/${oversell.id}/void`, { reason: 'oversold' });
    expect(voided.json.status).toBe('voided');
    expect(await stockOf(w, 'flan')).toBe(1);
    expect((await manage(local, 'GET', `/stores/${w.storeId}/conflicts`)).json.conflicts).toEqual([]);
  });
});
