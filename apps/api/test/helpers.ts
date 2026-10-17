import { type Order, buildOrder } from '@mpf/shared';
import postgres from 'postgres';
import { type App, createApp } from '../src/app.ts';
import { type Sql, connect, migrate } from '../src/db.ts';
import { createProduct, createStore, createTerminal, createUser } from '../src/fixtures.ts';

const BASE_URL = process.env.TEST_DATABASE_URL ?? 'postgres://mpf:mpf@localhost:5433/mpf';

/** Creates a fresh, migrated database named mpf_test_<name>. */
export async function createTestDb(name: string): Promise<Sql> {
  const dbName = `mpf_test_${name}`;
  const admin = postgres(BASE_URL, { max: 1, onnotice: () => {} });
  await admin.unsafe(`drop database if exists ${dbName} with (force)`);
  await admin.unsafe(`create database ${dbName}`);
  await admin.end();
  const url = new URL(BASE_URL);
  url.pathname = `/${dbName}`;
  const sql = connect(url.href);
  await migrate(sql);
  return sql;
}

export interface World {
  sql: Sql;
  app: App;
  storeId: string;
  terminals: Record<'A' | 'B', { id: string; token: string }>;
  adminId: string;
  cashierId: string;
  /** flan: 3 in stock. brownie: 10 in stock. coffee: untracked. */
  products: Record<'flan' | 'brownie' | 'coffee', string>;
  close(): Promise<void>;
}

export async function createWorld(name: string): Promise<World> {
  const sql = await createTestDb(name);
  const storeId = await createStore(sql, { code: 'MAIN', name: 'Main', taxRateBps: 1300 });
  return {
    sql,
    app: createApp({ sql, sessionSecret: 'test-secret-test-secret' }),
    storeId,
    terminals: {
      A: await createTerminal(sql, { storeId, code: 'A', name: 'Register A' }),
      B: await createTerminal(sql, { storeId, code: 'B', name: 'Register B' }),
    },
    adminId: await createUser(sql, { username: 'admin', name: 'Admin', role: 'admin', password: 'admin123' }),
    cashierId: await createUser(sql, { username: 'cashier', name: 'Cashier', role: 'cashier', password: '1234', storeId }),
    products: {
      flan: await createProduct(sql, { name: 'Flan', priceCents: 1200 }, { storeId, quantity: 3 }),
      brownie: await createProduct(sql, { name: 'Brownie', priceCents: 1000 }, { storeId, quantity: 10 }),
      coffee: await createProduct(sql, { name: 'Coffee', priceCents: 900, trackStock: false }),
    },
    close: () => sql.end(),
  };
}

/** An order paid in full by one digital payment. */
export function makeOrder(
  world: World,
  terminalCode: 'A' | 'B',
  ticketSeq: number,
  items: Partial<Record<keyof World['products'], number>>,
): Order {
  const prices = { flan: 1200, brownie: 1000, coffee: 900 };
  const cart = Object.entries(items).map(([name, quantity]) => ({
    productId: world.products[name as keyof World['products']],
    name,
    unitPriceCents: prices[name as keyof typeof prices],
    quantity: quantity!,
  }));
  const totalCents = cart.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
  return buildOrder({
    cart,
    payments: [{ method: 'digital', amountCents: totalCents }],
    cashierId: world.cashierId,
    terminalCode,
    ticketSeq,
    taxRateBps: 1300,
    taxIncluded: true,
  });
}

export async function call<T = any>(
  app: App,
  token: string | null,
  method: string,
  path: string,
  body?: unknown,
  session?: string,
): Promise<{ status: number; json: T }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (session) headers['X-Session'] = session;
  const res = await app.request(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text(); // empty on 204
  return { status: res.status, json: (text ? JSON.parse(text) : null) as T };
}

export async function stockOf(world: World, product: keyof World['products']): Promise<number> {
  const [row] = await world.sql<{ quantity: number }[]>`
    select quantity from stock where store_id = ${world.storeId} and product_id = ${world.products[product]}`;
  return row!.quantity;
}
