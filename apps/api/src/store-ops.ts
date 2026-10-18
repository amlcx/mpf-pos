import type { Product, ReportOrder, StockChange, StockConflict, StoreCashSession } from '@mpf/shared';
import type { Sql } from './db.ts';

/**
 * Operations on one store's data. Callers decide which store the request may
 * act on (the terminal's own, or one the admin has access to) and pass it in;
 * nothing here reads a store id from anywhere else.
 */

const productColumns = (sql: Sql, storeId: string) => sql`
  p.id, p.name, p.category, p.price_cents, p.track_stock, p.active,
  case when p.track_stock then coalesce(
    (select quantity from stock s where s.product_id = p.id and s.store_id = ${storeId}), 0)
  end as stock_qty,
  not p.track_stock and exists(
    select 1 from sold_out so where so.product_id = p.id and so.store_id = ${storeId}) as sold_out`;

export function listProducts(sql: Sql, storeId: string): Promise<Product[]> {
  return sql<Product[]>`
    select ${productColumns(sql, storeId)} from products p order by p.category, p.name`;
}

export async function getProduct(sql: Sql, storeId: string, id: string): Promise<Product | null> {
  const [product] = await sql<Product[]>`
    select ${productColumns(sql, storeId)} from products p where p.id = ${id}`;
  return product ?? null;
}

/**
 * Sets or moves a store's quantity of a product and writes the ledger row.
 * Returns false, changing nothing, if the result would be negative.
 */
export async function changeStock(
  sql: Sql,
  input: { storeId: string; productId: string; userId: string; change: StockChange },
): Promise<boolean> {
  const { storeId, productId, userId, change } = input;
  return sql.begin(async (tx) => {
    await tx`insert into stock ${tx({ storeId, productId, quantity: 0 })} on conflict do nothing`;
    const [row] = await tx<{ quantity: number }[]>`
      select quantity from stock where store_id = ${storeId} and product_id = ${productId} for update`;
    const delta = 'delta' in change ? change.delta : change.quantity - row!.quantity;
    if (delta === 0) return true;
    if (row!.quantity + delta < 0 && 'delta' in change) return false;
    await tx`
      update stock set quantity = quantity + ${delta}
      where store_id = ${storeId} and product_id = ${productId}`;
    await tx`insert into stock_movements ${tx({ storeId, productId, delta, reason: 'adjustment', userId })}`;
    return true;
  });
}

/**
 * Marks a made-on-demand product as sold out in a store, or available again.
 * Tracked products are refused: their quantity already says when they run out.
 */
export async function setSoldOut(
  sql: Sql,
  input: { storeId: string; productId: string; userId: string; soldOut: boolean },
): Promise<'ok' | 'not_found' | 'tracked'> {
  const { storeId, productId, userId, soldOut } = input;
  const [product] = await sql<{ trackStock: boolean }[]>`
    select track_stock from products where id = ${productId}`;
  if (!product) return 'not_found';
  if (product.trackStock) return 'tracked';
  if (soldOut) {
    await sql`
      insert into sold_out ${sql({ storeId, productId, markedBy: userId })} on conflict do nothing`;
  } else {
    await sql`delete from sold_out where store_id = ${storeId} and product_id = ${productId}`;
  }
  return 'ok';
}

/** Orders with from <= createdAt < to, newest first, with lines and payments. */
export async function listOrders(sql: Sql, storeId: string, from: string, to: string): Promise<ReportOrder[]> {
  const inRange = sql`o.store_id = ${storeId} and o.created_at >= ${from} and o.created_at < ${to}`;
  const orders = await sql<Omit<ReportOrder, 'lines' | 'payments'>[]>`
    select o.id, o.cashier_id, o.ticket_seq, o.ticket_number, o.created_at, o.tax_rate_bps,
      o.tax_included, o.discount_kind, o.discount_cents, o.subtotal_cents, o.tax_cents, o.total_cents, o.status, u.name as cashier_name,
      vu.name as voided_by_name, o.void_reason
    from orders o join users u on u.id = o.cashier_id left join users vu on vu.id = o.voided_by
    where ${inRange} order by o.created_at desc`;
  const lines = await sql<(ReportOrder['lines'][number] & { orderId: string })[]>`
    select l.id, l.order_id, l.product_id, l.name, l.unit_price_cents, l.quantity, l.line_total_cents
    from order_lines l join orders o on o.id = l.order_id where ${inRange} order by l.id`;
  const payments = await sql<(ReportOrder['payments'][number] & { orderId: string })[]>`
    select p.id, p.order_id, p.method, p.amount_cents, p.tendered_cents
    from payments p join orders o on o.id = p.order_id where ${inRange} order by p.id`;
  const group = <T extends { orderId: string }>(rows: T[]) => {
    const byOrder = new Map<string, Omit<T, 'orderId'>[]>();
    for (const { orderId, ...rest } of rows) {
      const list = byOrder.get(orderId);
      if (list) list.push(rest);
      else byOrder.set(orderId, [rest]);
    }
    return byOrder;
  };
  const linesByOrder = group(lines);
  const paymentsByOrder = group(payments);
  return orders.map((o) => ({
    ...o,
    lines: linesByOrder.get(o.id) ?? [],
    payments: paymentsByOrder.get(o.id) ?? [],
  }));
}

/** Unresolved offline oversells, oldest first. */
export function listConflicts(sql: Sql, storeId: string): Promise<StockConflict[]> {
  return sql<StockConflict[]>`
    select sc.id, sc.order_id, o.ticket_number, sc.product_id, p.name as product_name,
      sc.shortfall, sc.created_at
    from stock_conflicts sc
    join orders o on o.id = sc.order_id
    join products p on p.id = sc.product_id
    where sc.store_id = ${storeId} and sc.resolved_at is null
    order by sc.created_at`;
}

/** Accepts an oversell as-is. To undo the sale instead, void the order. */
export async function resolveConflict(
  sql: Sql,
  input: { storeId: string; id: string; userId: string; resolution: string },
): Promise<boolean> {
  const rows = await sql`
    update stock_conflicts set resolved_at = now(), resolved_by = ${input.userId},
      resolution = ${input.resolution}
    where id = ${input.id} and store_id = ${input.storeId} and resolved_at is null
    returning id`;
  return rows.length > 0;
}

/** A store's drawers whose business day is within from..to (inclusive), newest first. */
export async function listCashSessions(sql: Sql, storeId: string, from: string, to: string): Promise<StoreCashSession[]> {
  const sessions = await sql<Omit<StoreCashSession, 'movements'>[]>`
    select s.id, t.code as terminal_code, t.name as terminal_name, s.business_date::text as business_date,
      opener.name as opened_by_name, s.opened_at, s.opening_cents,
      closer.name as closed_by_name, s.closed_at, s.counted_cents, s.expected_cents, s.close_note as note
    from cash_sessions s
    join terminals t on t.id = s.terminal_id
    join users opener on opener.id = s.opened_by
    left join users closer on closer.id = s.closed_by
    where s.store_id = ${storeId} and s.business_date between ${from}::date and ${to}::date
    order by s.business_date desc, s.opened_at desc
    limit 500`;
  if (sessions.length === 0) return [];
  const movements = await sql<(StoreCashSession['movements'][number] & { sessionId: string })[]>`
    select m.id, m.session_id, m.kind, m.amount_cents, m.reason, m.user_id, u.name as user_name, m.created_at
    from cash_movements m join users u on u.id = m.user_id
    where m.session_id in ${sql(sessions.map((s) => s.id))}
    order by m.created_at, m.id`;
  return sessions.map((s) => ({
    ...s,
    movements: movements.filter((m) => m.sessionId === s.id).map(({ sessionId: _, ...m }) => m),
  }));
}
