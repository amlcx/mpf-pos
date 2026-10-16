import type {
  Order,
  OrderLine,
  Payment,
  Product,
  PullResponse,
  ReportOrder,
  StoreInfo,
  TerminalInfo,
  User,
} from '@mpf/shared';
import { type LocalDb, type Statement, getKv, setKv } from './local-db.ts';

// ------------------------------------------------------------------ config

/** Settings of this PC, entered once on the setup screen. */
export interface TerminalConfig {
  apiUrl: string;
  terminalToken: string;
  /** Where raw ticket bytes go (see pos-native::print_raw). Empty: no printer. */
  printerTarget: string;
  /** Characters per ticket line: 48 for 80mm paper, 32 for 58mm. */
  paperColumns: number;
  /** The printer has an auto-cutter. */
  cutter: boolean;
  /** A cash drawer is plugged into the printer; open it on cash sales. */
  cashDrawer: boolean;
}

export async function loadConfig(db: LocalDb): Promise<TerminalConfig | null> {
  const raw = await getKv(db, 'config');
  // Configs saved before the printer options existed behave as they did then.
  return raw ? { cutter: true, cashDrawer: false, ...(JSON.parse(raw) as Partial<TerminalConfig>) } as TerminalConfig : null;
}
export const saveConfig = (db: LocalDb, config: TerminalConfig) =>
  db.batch([setKv('config', JSON.stringify(config))]);

/** What the last pull told us about where this terminal lives. */
export interface Context {
  store: StoreInfo;
  terminal: TerminalInfo;
  nextTicketSeq: number;
  lastPullAt: string;
}

export async function loadContext(db: LocalDb): Promise<Context | null> {
  const [store, terminal, seq, lastPullAt] = await Promise.all(
    ['store', 'terminal', 'next_ticket_seq', 'last_pull_at'].map((key) => getKv(db, key)),
  );
  if (!store || !terminal || !lastPullAt) return null;
  return {
    store: JSON.parse(store),
    terminal: JSON.parse(terminal),
    nextTicketSeq: Number(seq ?? 1),
    lastPullAt,
  };
}

// ---------------------------------------------------------------- products

export interface LocalProduct extends Product {
  /**
   * What this terminal may still sell: the server's last known quantity minus
   * local sales the server has not confirmed yet. null when untracked, and
   * 0 while a made-on-demand product is marked as sold out.
   */
  available: number | null;
}

export async function listProducts(db: LocalDb): Promise<LocalProduct[]> {
  const rows = await db.select<any>(
    `select p.id, p.name, p.category, p.price_cents as priceCents, p.track_stock as trackStock,
       p.active, p.stock_qty as stockQty, p.sold_out as soldOut,
       coalesce((select sum(l.quantity) from order_lines l join orders o on o.id = l.order_id
         where l.product_id = p.id and o.sync_status <> 'synced' and o.status = 'completed'), 0) as unsynced
     from products p order by p.category, p.name`,
  );
  return rows.map(({ unsynced, ...p }) => ({
    ...p,
    trackStock: !!p.trackStock,
    active: !!p.active,
    soldOut: !!p.soldOut,
    available: p.trackStock ? (p.stockQty ?? 0) - unsynced : p.soldOut ? 0 : null,
  }));
}

export async function findUser(db: LocalDb, username: string): Promise<(User & { passwordHash: string }) | null> {
  const rows = await db.select<User & { passwordHash: string }>(
    'select id, username, name, role, password_hash as passwordHash from users where username = ?',
    [username],
  );
  return rows[0] ?? null;
}

/** Replaces the local copy of server-owned data with a fresh snapshot. */
export async function applyPull(db: LocalDb, pull: PullResponse): Promise<void> {
  const statements: Statement[] = [
    { sql: 'delete from products' },
    ...pull.products.map((p) => ({
      sql: `insert into products (id, name, category, price_cents, track_stock, active, stock_qty, sold_out)
            values (?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [p.id, p.name, p.category, p.priceCents, +p.trackStock, +p.active, p.stockQty, +p.soldOut],
    })),
    { sql: 'delete from users' },
    ...pull.users.map((u) => ({
      sql: 'insert into users (id, username, name, role, password_hash) values (?, ?, ?, ?, ?)',
      params: [u.id, u.username, u.name, u.role, u.passwordHash],
    })),
    ...pull.voidedOrderIds.map((id) => ({
      sql: "update orders set status = 'voided' where id = ?",
      params: [id],
    })),
    setKv('store', JSON.stringify(pull.store)),
    setKv('terminal', JSON.stringify(pull.terminal)),
    setKv('last_pull_at', pull.serverTime),
    // Never reuse a ticket number, even if this PC's database was wiped.
    {
      sql: `insert into kv (key, value) values ('next_ticket_seq', ?)
            on conflict (key) do update set
              value = cast(max(cast(value as integer), cast(excluded.value as integer)) as text)`,
      params: [String(pull.terminal.lastTicketSeq + 1)],
    },
  ];
  await db.batch(statements);
}

// ------------------------------------------------------------------ orders

export type SyncStatus =
  /** Saved locally; a strict submission is in flight. No ticket handed out yet. */
  | 'submitting'
  /** Sold while offline; the server must accept it. */
  | 'pending'
  | 'synced'
  /** The server refused it for a reason retrying will not fix. Needs an admin. */
  | 'failed';

export interface LocalOrder extends ReportOrder {
  syncStatus: SyncStatus;
  syncError: string | null;
  /** The server found this offline sale exceeded the store's stock. */
  oversold: boolean;
}

/** Saves the order and consumes its ticket number in one transaction. */
export function insertOrder(order: Order, syncStatus: SyncStatus): Statement[] {
  return [
    {
      sql: `insert into orders (id, cashier_id, ticket_seq, ticket_number, created_at, tax_rate_bps,
              tax_included, discount_kind, discount_cents, subtotal_cents, tax_cents, total_cents, sync_status)
            values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        order.id, order.cashierId, order.ticketSeq, order.ticketNumber, order.createdAt,
        order.taxRateBps, +order.taxIncluded, order.discountKind, order.discountCents,
        order.subtotalCents, order.taxCents, order.totalCents, syncStatus,
      ],
    },
    ...order.lines.map((l) => ({
      sql: `insert into order_lines (id, order_id, product_id, name, unit_price_cents, quantity, line_total_cents)
            values (?, ?, ?, ?, ?, ?, ?)`,
      params: [l.id, order.id, l.productId, l.name, l.unitPriceCents, l.quantity, l.lineTotalCents],
    })),
    ...order.payments.map((p) => ({
      sql: 'insert into payments (id, order_id, method, amount_cents, tendered_cents) values (?, ?, ?, ?, ?)',
      params: [p.id, order.id, p.method, p.amountCents, p.tenderedCents],
    })),
    setKv('next_ticket_seq', String(order.ticketSeq + 1)),
  ];
}

/**
 * Removes an order the server rejected before any ticket was handed out, and
 * gives its ticket number back if no later order has taken the next one.
 */
export function deleteSubmittingOrder(order: Pick<Order, 'id' | 'ticketSeq'>): Statement[] {
  const guard = "order_id in (select id from orders where id = ? and sync_status = 'submitting')";
  return [
    { sql: `delete from payments where ${guard}`, params: [order.id] },
    { sql: `delete from order_lines where ${guard}`, params: [order.id] },
    { sql: "delete from orders where id = ? and sync_status = 'submitting'", params: [order.id] },
    {
      sql: `update kv set value = ? where key = 'next_ticket_seq' and value = ?
              and not exists (select 1 from orders where id = ?)`,
      params: [String(order.ticketSeq), String(order.ticketSeq + 1), order.id],
    },
  ];
}

/** Marks an order confirmed and moves its quantities out of the cached stock. */
export function markSynced(orderId: string, opts: { oversold: boolean; adjustStock: boolean }): Statement[] {
  const statements: Statement[] = [];
  if (opts.adjustStock) {
    statements.push({
      sql: `update products set stock_qty = stock_qty - (
              select sum(quantity) from order_lines where order_id = ? and product_id = products.id)
            where track_stock = 1 and id in (select product_id from order_lines where order_id = ?)
              and exists (select 1 from orders where id = ? and sync_status <> 'synced')`,
      params: [orderId, orderId, orderId],
    });
  }
  statements.push({
    sql: "update orders set sync_status = 'synced', sync_error = null, oversold = ? where id = ?",
    params: [+opts.oversold, orderId],
  });
  return statements;
}

const ORDER_SELECT = `select id, cashier_id as cashierId, ticket_seq as ticketSeq,
  ticket_number as ticketNumber, created_at as createdAt, tax_rate_bps as taxRateBps,
  tax_included as taxIncluded, discount_kind as discountKind, discount_cents as discountCents,
  subtotal_cents as subtotalCents, tax_cents as taxCents,
  total_cents as totalCents, status, sync_status as syncStatus, sync_error as syncError, oversold,
  (select name from users where users.id = orders.cashier_id) as cashierName
  from orders`;

async function hydrate(db: LocalDb, rows: any[]): Promise<LocalOrder[]> {
  if (rows.length === 0) return [];
  const marks = rows.map(() => '?').join(', ');
  const ids = rows.map((r) => r.id as string);
  const lines = await db.select<OrderLine & { orderId: string }>(
    `select id, order_id as orderId, product_id as productId, name,
       unit_price_cents as unitPriceCents, quantity, line_total_cents as lineTotalCents
     from order_lines where order_id in (${marks}) order by id`,
    ids,
  );
  const payments = await db.select<Payment & { orderId: string }>(
    `select id, order_id as orderId, method, amount_cents as amountCents, tendered_cents as tenderedCents
     from payments where order_id in (${marks}) order by id`,
    ids,
  );
  const strip = <T extends { orderId: string }>({ orderId: _, ...rest }: T) => rest;
  return rows.map((r) => ({
    ...r,
    taxIncluded: !!r.taxIncluded,
    oversold: !!r.oversold,
    lines: lines.filter((l) => l.orderId === r.id).map(strip),
    payments: payments.filter((p) => p.orderId === r.id).map(strip),
  }));
}

export async function getOrder(db: LocalDb, id: string): Promise<LocalOrder | null> {
  return (await hydrate(db, await db.select(`${ORDER_SELECT} where id = ?`, [id])))[0] ?? null;
}

/** This register's orders with from <= createdAt < to (ISO instants), newest first. */
export async function listOrdersBetween(db: LocalDb, from: string, to: string): Promise<LocalOrder[]> {
  return hydrate(
    db,
    await db.select(`${ORDER_SELECT} where created_at >= ? and created_at < ? order by ticket_seq desc`, [from, to]),
  );
}

/** Orders the server has not confirmed, oldest first. */
export async function listOutbox(db: LocalDb): Promise<LocalOrder[]> {
  return hydrate(
    db,
    await db.select(`${ORDER_SELECT} where sync_status in ('submitting', 'pending') order by ticket_seq`),
  );
}

export async function countBySyncStatus(db: LocalDb): Promise<Record<SyncStatus, number>> {
  const rows = await db.select<{ syncStatus: SyncStatus; n: number }>(
    'select sync_status as syncStatus, count(*) as n from orders group by sync_status',
  );
  const counts = { submitting: 0, pending: 0, synced: 0, failed: 0 };
  for (const row of rows) counts[row.syncStatus] = row.n;
  return counts;
}
