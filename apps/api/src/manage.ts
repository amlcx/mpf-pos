import {
  ADMIN_PASSWORD_MIN,
  LoginRequestSchema,
  type ManagedTerminal,
  type ManagedUser,
  ProductInputSchema,
  ProductPatchSchema,
  ReportRangeSchema,
  StockChangeSchema,
  type StoreInfo,
  StoreInputSchema,
  StorePatchSchema,
  TerminalInputSchema,
  TerminalPatchSchema,
  UserInputSchema,
  UserPatchSchema,
  VoidOrderSchema,
  hashPassword,
  verifyPassword,
} from '@mpf/shared';
import { type Context, Hono } from 'hono';
import { sign, verify } from 'hono/jwt';
import * as v from 'valibot';
import { SESSION_TTL_SECONDS, hashToken, newTerminalToken } from './auth.ts';
import type { Sql } from './db.ts';
import { body, fail, idParam, parse } from './http.ts';
import { voidOrder } from './orders.ts';
import { changeStock, getProduct, listConflicts, listOrders, listProducts, resolveConflict } from './store-ops.ts';

/**
 * API of the web admin panel. Unlike the register routes there is no
 * terminal: a person logs in, and the store comes from the URL.
 *
 * - Only admins get in.
 * - An admin with a store (users.store_id) may act on that store only; an
 *   admin without one (an "org admin") may act on every store, create stores
 *   and manage every user. `storeParam` and `requireOrg` enforce this; every
 *   route that touches a store must go through `storeParam`.
 */
interface AdminCtx {
  id: string;
  storeId: string | null;
}
type Env = { Variables: { admin: AdminCtx } };

const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

const Resolution = v.object({ resolution: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)) });
const USER_COLUMNS = (sql: Sql) => sql`id, username, name, role, store_id, active`;

export function createManageRoutes(deps: { sql: Sql; sessionSecret: string }) {
  const { sql, sessionSecret } = deps;
  const m = new Hono<Env>();

  // This login faces the internet, so guessing is slowed down per username.
  // Kept in memory: enough for one API process, and it resets on restart.
  const failures = new Map<string, { count: number; since: number }>();

  m.post('/login', async (c) => {
    const { username, password } = await body(c, LoginRequestSchema);
    const key = username.toLowerCase();
    const failed = failures.get(key);
    if (failed && Date.now() - failed.since > LOCKOUT_MS) failures.delete(key);
    if ((failures.get(key)?.count ?? 0) >= MAX_FAILED_LOGINS) fail(429, 'too_many_attempts');

    const [row] = await sql<(ManagedUser & { passwordHash: string })[]>`
      select ${USER_COLUMNS(sql)}, password_hash from users where username = ${key} and active`;
    if (!row || !(await verifyPassword(password, row.passwordHash))) {
      const entry = failures.get(key) ?? { count: 0, since: Date.now() };
      entry.count += 1;
      failures.set(key, entry);
      fail(401, 'bad_credentials');
    }
    failures.delete(key);
    if (row.role !== 'admin') fail(403, 'admin_required');
    const { passwordHash: _, ...user } = row;
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    return c.json({ token: await sign({ sub: user.id, exp }, sessionSecret, 'HS256'), user });
  });

  m.use(async (c, next) => {
    const token = c.req.header('X-Session');
    if (!token) fail(401, 'session_required');
    const payload = await verify(token, sessionSecret, 'HS256').catch(() => fail(401, 'session_invalid'));
    // Re-read the user so a deactivated or demoted admin loses access at once.
    const [user] = await sql<{ id: string; role: string; storeId: string | null }[]>`
      select id, role, store_id from users where id = ${String(payload.sub)} and active`;
    if (!user) fail(401, 'session_invalid');
    if (user.role !== 'admin') fail(403, 'admin_required');
    c.set('admin', { id: user.id, storeId: user.storeId });
    await next();
  });

  /** The store in the URL, after checking this admin may act on it. */
  const storeParam = (c: Context<Env>): string => {
    const storeId = idParam(c, 'storeId');
    const own = c.var.admin.storeId;
    if (own !== null && own !== storeId) fail(403, 'store_forbidden');
    return storeId;
  };
  const requireOrg = (c: Context<Env>) => {
    if (c.var.admin.storeId !== null) fail(403, 'org_admin_required');
  };

  m.get('/me', async (c) => {
    const [user] = await sql<ManagedUser[]>`select ${USER_COLUMNS(sql)} from users where id = ${c.var.admin.id}`;
    return c.json({ user: user! });
  });

  // ------------------------------------------------------------ stores
  const STORE_COLUMNS = sql`id, code, name, currency_symbol, tax_rate_bps, tax_included`;

  m.get('/stores', async (c) => {
    const own = c.var.admin.storeId;
    const stores = await sql<StoreInfo[]>`
      select ${STORE_COLUMNS} from stores ${own === null ? sql`` : sql`where id = ${own}`} order by name`;
    return c.json({ stores });
  });

  m.post('/stores', async (c) => {
    requireOrg(c);
    const input = await body(c, StoreInputSchema);
    const [store] = await sql<StoreInfo[]>`insert into stores ${sql(input)} returning ${STORE_COLUMNS}`;
    return c.json({ store: store! }, 201);
  });

  m.patch('/stores/:storeId', async (c) => {
    const storeId = storeParam(c);
    const patch = await body(c, StorePatchSchema);
    if (Object.keys(patch).length > 0) await sql`update stores set ${sql(patch)} where id = ${storeId}`;
    const [store] = await sql<StoreInfo[]>`select ${STORE_COLUMNS} from stores where id = ${storeId}`;
    if (!store) fail(404, 'not_found');
    return c.json({ store });
  });

  // --------------------------------------------------------- terminals
  const TERMINAL_COLUMNS = sql`id, store_id, code, name, active, last_seen_at`;

  m.get('/stores/:storeId/terminals', async (c) => {
    const terminals = await sql<ManagedTerminal[]>`
      select ${TERMINAL_COLUMNS} from terminals where store_id = ${storeParam(c)} order by code`;
    return c.json({ terminals });
  });

  /** The token is returned once and only its hash is kept. */
  m.post('/stores/:storeId/terminals', async (c) => {
    const storeId = storeParam(c);
    const input = await body(c, TerminalInputSchema);
    const token = newTerminalToken();
    const [terminal] = await sql<ManagedTerminal[]>`
      insert into terminals ${sql({ ...input, storeId, tokenHash: hashToken(token) })}
      returning ${TERMINAL_COLUMNS}`;
    return c.json({ terminal: terminal!, token }, 201);
  });

  m.patch('/stores/:storeId/terminals/:id', async (c) => {
    const storeId = storeParam(c);
    const patch = await body(c, TerminalPatchSchema);
    const id = idParam(c);
    if (Object.keys(patch).length > 0) {
      await sql`update terminals set ${sql(patch)} where id = ${id} and store_id = ${storeId}`;
    }
    const [terminal] = await sql<ManagedTerminal[]>`
      select ${TERMINAL_COLUMNS} from terminals where id = ${id} and store_id = ${storeId}`;
    if (!terminal) fail(404, 'not_found');
    return c.json({ terminal });
  });

  /** Replaces the token; the register stops syncing until it gets the new one. */
  m.post('/stores/:storeId/terminals/:id/token', async (c) => {
    const token = newTerminalToken();
    const rows = await sql`
      update terminals set token_hash = ${hashToken(token)}
      where id = ${idParam(c)} and store_id = ${storeParam(c)} returning id`;
    if (rows.length === 0) fail(404, 'not_found');
    return c.json({ token });
  });

  // ------------------------------------------------------------- users
  // A store admin sees and manages only people assigned to their own store.
  const checkPassword = (role: string, password: string | undefined) => {
    if (role === 'admin' && password !== undefined && password.length < ADMIN_PASSWORD_MIN) {
      fail(400, 'admin_password_too_short', { min: ADMIN_PASSWORD_MIN });
    }
  };

  m.get('/users', async (c) => {
    const own = c.var.admin.storeId;
    const users = await sql<ManagedUser[]>`
      select ${USER_COLUMNS(sql)} from users
      ${own === null ? sql`` : sql`where store_id = ${own}`} order by active desc, username`;
    return c.json({ users });
  });

  m.post('/users', async (c) => {
    const { password, ...input } = await body(c, UserInputSchema);
    const own = c.var.admin.storeId;
    if (own !== null && input.storeId !== own) fail(403, 'store_forbidden');
    checkPassword(input.role, password);
    const [user] = await sql<ManagedUser[]>`
      insert into users ${sql({ ...input, passwordHash: await hashPassword(password) })}
      returning ${USER_COLUMNS(sql)}`;
    return c.json({ user: user! }, 201);
  });

  m.patch('/users/:id', async (c) => {
    const id = idParam(c);
    const { password, ...patch } = await body(c, UserPatchSchema);
    const own = c.var.admin.storeId;
    const [target] = await sql<ManagedUser[]>`select ${USER_COLUMNS(sql)} from users where id = ${id}`;
    if (!target || (own !== null && target.storeId !== own)) fail(404, 'not_found');
    if (own !== null && patch.storeId !== undefined && patch.storeId !== own) fail(403, 'store_forbidden');

    const next = { ...target, ...patch };
    if (id === c.var.admin.id && (!next.active || next.role !== 'admin' || next.storeId !== target.storeId)) {
      fail(409, 'cannot_change_own_access');
    }
    // A cashier's short PIN must not become an admin password.
    if (next.role === 'admin' && target.role !== 'admin' && password === undefined) {
      fail(400, 'admin_password_required', { min: ADMIN_PASSWORD_MIN });
    }
    checkPassword(next.role, password);

    const changes = password === undefined ? patch : { ...patch, passwordHash: await hashPassword(password) };
    if (Object.keys(changes).length > 0) await sql`update users set ${sql(changes)} where id = ${id}`;
    const [user] = await sql<ManagedUser[]>`select ${USER_COLUMNS(sql)} from users where id = ${id}`;
    return c.json({ user: user! });
  });

  // ------------------------------------------------- catalog and stock
  // The catalog is shared by all stores; any admin may edit it.
  m.get('/stores/:storeId/products', async (c) =>
    c.json({ products: await listProducts(sql, storeParam(c)) }),
  );

  m.post('/products', async (c) => {
    const input = await body(c, ProductInputSchema);
    const [row] = await sql<{ id: string }[]>`insert into products ${sql(input)} returning id`;
    return c.json({ id: row!.id }, 201);
  });

  m.patch('/products/:id', async (c) => {
    const id = idParam(c);
    const patch = await body(c, ProductPatchSchema);
    const rows =
      Object.keys(patch).length > 0
        ? await sql`update products set ${sql(patch)}, updated_at = now() where id = ${id} returning id`
        : await sql`select id from products where id = ${id}`;
    if (rows.length === 0) fail(404, 'not_found');
    return c.json({ id });
  });

  m.put('/stores/:storeId/products/:id/stock', async (c) => {
    const storeId = storeParam(c);
    const productId = idParam(c);
    const change = await body(c, StockChangeSchema);
    if (!(await getProduct(sql, storeId, productId))) fail(404, 'not_found');
    if (!(await changeStock(sql, { storeId, productId, userId: c.var.admin.id, change }))) {
      fail(409, 'stock_would_be_negative');
    }
    return c.json({ product: (await getProduct(sql, storeId, productId))! });
  });

  // -------------------------------------------------- orders, conflicts
  m.get('/stores/:storeId/orders', async (c) => {
    const storeId = storeParam(c);
    const { from, to } = parse(ReportRangeSchema, c.req.query());
    return c.json({ orders: await listOrders(sql, storeId, from, to) });
  });

  m.post('/stores/:storeId/orders/:id/void', async (c) => {
    const storeId = storeParam(c);
    const { reason } = await body(c, VoidOrderSchema);
    const result = await voidOrder(sql, { orderId: idParam(c), storeId, userId: c.var.admin.id, reason });
    if (result === 'not_found') fail(404, 'not_found');
    return c.json({ status: result });
  });

  m.get('/stores/:storeId/conflicts', async (c) =>
    c.json({ conflicts: await listConflicts(sql, storeParam(c)) }),
  );

  m.post('/stores/:storeId/conflicts/:id/resolve', async (c) => {
    const storeId = storeParam(c);
    const { resolution } = await body(c, Resolution);
    const done = await resolveConflict(sql, { storeId, id: idParam(c), userId: c.var.admin.id, resolution });
    if (!done) fail(404, 'not_found');
    return c.json({ status: 'resolved' });
  });

  return m;
}
