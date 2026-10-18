import { relative } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import {
  CashSessionSchema,
  type LoginResponse,
  LoginRequestSchema,
  ProductInputSchema,
  ProductPatchSchema,
  type PullResponse,
  ReportRangeSchema,
  type Role,
  SoldOutSchema,
  StockSetSchema,
  SubmitOrderRequestSchema,
  type UpdateManifest,
  type User,
  VERSION_PATTERN,
  VersionSchema,
  VoidOrderSchema,
  cashSessionProblems,
  isNewerVersion,
  orderProblems,
  verifyPassword,
} from '@mpf/shared';
import { type Context, Hono } from 'hono';
import { cors } from 'hono/cors';
import { HTTPException } from 'hono/http-exception';
import { sign, verify } from 'hono/jwt';
import * as v from 'valibot';
import { SESSION_TTL_SECONDS, type SessionCtx, type TerminalCtx, hashToken } from './auth.ts';
import type { Sql } from './db.ts';
import { body, fail, idParam, parse } from './http.ts';
import { saveCashSession } from './cash.ts';
import { createManageRoutes } from './manage.ts';
import { submitOrder, voidOrder } from './orders.ts';
import { createReleaseRoutes } from './releases.ts';
import {
  changeStock,
  getProduct,
  listConflicts,
  listOrders,
  listProducts,
  resolveConflict,
  setSoldOut,
} from './store-ops.ts';

type Env = { Variables: { terminal: TerminalCtx; session: SessionCtx } };

const Resolution = v.object({ resolution: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)) });

export interface AppDeps {
  sql: Sql;
  sessionSecret: string;
  /** Release this server runs, reported by /health so deploys can wait for it. */
  version?: string;
  /** SHA-256 of the release workflows' token; without it /releases refuses everyone. */
  releaseTokenSha256?: string;
  /** Folder with the built admin panel (apps/admin/dist), served at /panel/. */
  panelDir?: string;
}

export function createApp(deps: AppDeps) {
  const { sql, sessionSecret } = deps;
  const app = new Hono<Env>();

  app.use(cors({ origin: '*', allowHeaders: ['Authorization', 'Content-Type', 'X-Session', 'X-App-Version'] }));

  app.onError((err, c) => {
    if (err instanceof HTTPException) return err.getResponse();
    // Postgres: unique / foreign-key violations are the caller's fault.
    const code = (err as { code?: string }).code;
    if (code === '23505') return c.json({ error: 'conflict', detail: String(err.message) }, 409);
    if (code === '23503') return c.json({ error: 'unknown_reference', detail: String(err.message) }, 422);
    console.error(err);
    return c.json({ error: 'internal' }, 500);
  });

  app.get('/health', async (c) => {
    await sql`select 1`;
    return c.json({ ok: true, version: deps.version ?? 'dev' });
  });

  // The web admin panel and its API authenticate people, not terminals, so
  // they are mounted before the terminal check.
  app.route('/manage', createManageRoutes(deps));
  app.route('/releases', createReleaseRoutes(deps));
  if (deps.panelDir) {
    const root = relative(process.cwd(), deps.panelDir) || '.';
    app.get('/', (c) => c.redirect('/panel/'));
    app.get('/panel', (c) => c.redirect('/panel/'));
    app.use('/panel/*', serveStatic({ root, rewriteRequestPath: (path) => path.replace(/^\/panel/, '') }));
  }

  // Everything below requires an enrolled terminal.
  app.use(async (c, next) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
    if (!token) fail(401, 'terminal_token_required');
    const [terminal] = await sql<TerminalCtx[]>`
      select id, store_id, code, name, release_ring, app_version from terminals
      where token_hash = ${hashToken(token)} and active`;
    if (!terminal) fail(401, 'terminal_token_invalid');
    // Registers say which version they run on every request. Written only
    // when it changes, so the usual request costs no extra write.
    const appVersion = c.req.header('X-App-Version');
    if (appVersion && VERSION_PATTERN.test(appVersion) && appVersion !== terminal.appVersion) {
      await sql`update terminals set app_version = ${appVersion} where id = ${terminal.id}`;
      terminal.appVersion = appVersion;
    }
    c.set('terminal', terminal);
    await next();
  });

  /**
   * Tauri's updater asks here (endpoint .../updates/{{target}}/{{arch}}/{{current_version}}).
   * 204 means "stay as you are". Only Windows installers are published, and
   * the register downloads the file from the GitHub Release itself.
   */
  app.get('/updates/:target/:arch/:currentVersion', async (c) => {
    const { target, arch, currentVersion } = c.req.param();
    const current = parse(VersionSchema, currentVersion);
    if (target !== 'windows' || arch !== 'x86_64') return c.body(null, 204);
    const [release] = await sql<{ version: string; url: string; signature: string; notes: string; pubDate: Date | null }[]>`
      select version, url, signature, notes, pub_date from register_releases
      where ring = ${c.var.terminal.releaseRing}`;
    if (!release || !isNewerVersion(release.version, current)) return c.body(null, 204);
    const { version, url, signature, notes, pubDate } = release;
    return c.json({
      version,
      notes,
      url,
      signature,
      ...(pubDate ? { pub_date: pubDate.toISOString() } : {}),
    } satisfies UpdateManifest);
  });

  /** A person logged in online at this terminal's store; with `role`, only that role. */
  const requireSession = (role?: Role) => async (c: Context<Env>, next: () => Promise<void>) => {
    const token = c.req.header('X-Session');
    if (!token) fail(401, 'session_required');
    const payload = await verify(token, sessionSecret, 'HS256').catch(() => fail(401, 'session_invalid'));
    // Re-read the user so a deactivated, moved or demoted one loses access at once.
    const [user] = await sql<{ id: string; role: Role }[]>`
      select id, role from users
      where id = ${String(payload.sub)} and active
        and (store_id is null or store_id = ${c.var.terminal.storeId})`;
    if (!user) fail(401, 'session_invalid');
    if (role && user.role !== role) fail(403, 'admin_required');
    c.set('session', { userId: user.id, role: user.role });
    await next();
  };
  const requireAdmin = requireSession('admin');

  app.post('/auth/login', async (c) => {
    const { username, password } = await body(c, LoginRequestSchema);
    const { storeId } = c.var.terminal;
    const [row] = await sql<(User & { passwordHash: string })[]>`
      select id, username, name, role, password_hash from users
      where username = ${username} and active and (store_id is null or store_id = ${storeId})`;
    if (!row || !(await verifyPassword(password, row.passwordHash))) fail(401, 'bad_credentials');
    const { passwordHash: _, ...user } = row;
    const exp = Math.floor(Date.now() / 1000) + SESSION_TTL_SECONDS;
    const token = await sign({ sub: user.id, exp }, sessionSecret, 'HS256');
    return c.json({ token, user } satisfies LoginResponse);
  });

  app.get('/sync/pull', async (c) => {
    const terminal = c.var.terminal;
    const [store] = await sql<PullResponse['store'][]>`
      select id, code, name, currency_symbol, tax_rate_bps, tax_included
      from stores where id = ${terminal.storeId}`;
    const products = await listProducts(sql, terminal.storeId);
    const users = await sql<PullResponse['users']>`
      select id, username, name, role, password_hash from users
      where active and (store_id is null or store_id = ${terminal.storeId})`;
    const voided = await sql<{ id: string }[]>`
      select id from orders
      where terminal_id = ${terminal.id} and status = 'voided' and voided_at > now() - interval '30 days'`;
    const [seq] = await sql<{ last: number }[]>`
      select coalesce(max(ticket_seq), 0)::int as last from orders where terminal_id = ${terminal.id}`;
    await sql`update terminals set last_seen_at = now() where id = ${terminal.id}`;
    return c.json({
      serverTime: new Date().toISOString(),
      store: store!,
      terminal: { id: terminal.id, code: terminal.code, name: terminal.name, lastTicketSeq: seq!.last },
      products,
      users,
      voidedOrderIds: voided.map((r) => r.id),
    } satisfies PullResponse);
  });

  app.post('/orders', async (c) => {
    const { order, stockPolicy } = await body(c, SubmitOrderRequestSchema);
    const problems = orderProblems(order);
    if (problems.length > 0) fail(400, 'invalid_order', { problems });
    const result = await submitOrder(sql, c.var.terminal, order, stockPolicy);
    if (!result.ok) return c.json({ error: 'insufficient_stock', items: result.items }, 409);
    return c.json(result.response);
  });

  /**
   * The register's cash drawer, whole, every time. Like orders, it needs no
   * online login: drawers are opened and closed offline too.
   */
  app.put('/cash-sessions/:id', async (c) => {
    const session = await body(c, CashSessionSchema);
    if (session.id !== idParam(c)) fail(400, 'id_mismatch');
    const problems = cashSessionProblems(session);
    if (problems.length > 0) fail(400, 'invalid_cash_session', { problems });
    const result = await saveCashSession(sql, c.var.terminal, session);
    if (result === 'conflict') fail(409, 'cash_session_conflict');
    return c.json({ status: result });
  });

  // Cashiers void too: the reason is mandatory and the session says who did it.
  app.post('/orders/:id/void', requireSession(), async (c) => {
    const { reason } = await body(c, VoidOrderSchema);
    const result = await voidOrder(sql, {
      orderId: idParam(c),
      storeId: c.var.terminal.storeId,
      userId: c.var.session.userId,
      reason,
    });
    if (result === 'not_found') fail(404, 'not_found');
    return c.json({ status: result });
  });

  /** Whoever prepares a made-on-demand product says when it has run out. */
  app.put('/products/:id/sold-out', requireSession(), async (c) => {
    const productId = idParam(c);
    const { soldOut } = await body(c, SoldOutSchema);
    const { storeId } = c.var.terminal;
    const result = await setSoldOut(sql, { storeId, productId, userId: c.var.session.userId, soldOut });
    if (result === 'not_found') fail(404, 'not_found');
    if (result === 'tracked') fail(409, 'product_tracks_stock');
    return c.json((await getProduct(sql, storeId, productId))!);
  });

  // ------------------------------------------------------------- admin
  // Admin actions from a register, always on the register's own store.
  const admin = new Hono<Env>();
  admin.use(requireAdmin);

  const loadProduct = async (c: Context<Env>, id: string) =>
    (await getProduct(sql, c.var.terminal.storeId, id)) ?? fail(404, 'not_found');

  admin.post('/products', async (c) => {
    const input = await body(c, ProductInputSchema);
    const [row] = await sql<{ id: string }[]>`insert into products ${sql(input)} returning id`;
    return c.json(await loadProduct(c, row!.id), 201);
  });

  admin.patch('/products/:id', async (c) => {
    const id = idParam(c);
    const patch = await body(c, ProductPatchSchema);
    if (Object.keys(patch).length > 0) {
      await sql`update products set ${sql(patch)}, updated_at = now() where id = ${id}`;
    }
    return c.json(await loadProduct(c, id));
  });

  /** Sets the counted quantity for this terminal's store. */
  admin.put('/products/:id/stock', async (c) => {
    const productId = idParam(c);
    const change = await body(c, StockSetSchema);
    await loadProduct(c, productId);
    await changeStock(sql, { storeId: c.var.terminal.storeId, productId, userId: c.var.session.userId, change });
    return c.json(await loadProduct(c, productId));
  });

  admin.get('/orders', async (c) => {
    const { from, to } = parse(ReportRangeSchema, c.req.query());
    return c.json({ orders: await listOrders(sql, c.var.terminal.storeId, from, to) });
  });

  admin.get('/conflicts', async (c) =>
    c.json({ conflicts: await listConflicts(sql, c.var.terminal.storeId) }),
  );

  admin.post('/conflicts/:id/resolve', async (c) => {
    const { resolution } = await body(c, Resolution);
    const done = await resolveConflict(sql, {
      storeId: c.var.terminal.storeId,
      id: idParam(c),
      userId: c.var.session.userId,
      resolution,
    });
    if (!done) fail(404, 'not_found');
    return c.json({ status: 'resolved' });
  });

  app.route('/admin', admin);
  return app;
}

export type App = ReturnType<typeof createApp>;
