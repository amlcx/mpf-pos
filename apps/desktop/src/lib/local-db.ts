export type SqlValue = string | number | null;

export interface Statement {
  sql: string;
  params?: SqlValue[];
}

/**
 * The terminal's SQLite database. Implemented by Tauri commands in the app
 * and by node:sqlite in tests, so everything above this interface runs in both.
 */
export interface LocalDb {
  select<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  /** Runs every statement in one transaction: all of them apply, or none. */
  batch(statements: Statement[]): Promise<void>;
}

// Each entry is one schema version; append, never edit a released entry.
const MIGRATIONS: string[][] = [
  [
    `create table products (
      id text primary key, name text not null, category text not null,
      price_cents integer not null, track_stock integer not null, active integer not null,
      stock_qty integer)`,
    `create table users (
      id text primary key, username text not null unique, name text not null,
      role text not null, password_hash text not null)`,
    `create table orders (
      id text primary key, cashier_id text not null,
      ticket_seq integer not null unique, ticket_number text not null,
      created_at text not null, tax_rate_bps integer not null, tax_included integer not null,
      subtotal_cents integer not null, tax_cents integer not null, total_cents integer not null,
      status text not null default 'completed' check (status in ('completed', 'voided')),
      sync_status text not null check (sync_status in ('submitting', 'pending', 'synced', 'failed')),
      sync_error text, oversold integer not null default 0)`,
    `create table order_lines (
      id text primary key, order_id text not null references orders (id),
      product_id text not null, name text not null, unit_price_cents integer not null,
      quantity integer not null, line_total_cents integer not null)`,
    `create index order_lines_order_idx on order_lines (order_id)`,
    `create table payments (
      id text primary key, order_id text not null references orders (id),
      method text not null, amount_cents integer not null, tendered_cents integer)`,
    `create index payments_order_idx on payments (order_id)`,
  ],
  [`alter table products add column sold_out integer not null default 0`],
];

export async function getKv(db: LocalDb, key: string): Promise<string | null> {
  const rows = await db.select<{ value: string }>('select value from kv where key = ?', [key]);
  return rows[0]?.value ?? null;
}

export function setKv(key: string, value: string): Statement {
  return {
    sql: 'insert into kv (key, value) values (?, ?) on conflict (key) do update set value = excluded.value',
    params: [key, value],
  };
}

export async function migrateLocal(db: LocalDb): Promise<void> {
  await db.batch([{ sql: 'create table if not exists kv (key text primary key, value text not null)' }]);
  const current = Number((await getKv(db, 'schema_version')) ?? 0);
  for (let version = current; version < MIGRATIONS.length; version++) {
    await db.batch([
      ...MIGRATIONS[version]!.map((sql) => ({ sql })),
      setKv('schema_version', String(version + 1)),
    ]);
  }
}
