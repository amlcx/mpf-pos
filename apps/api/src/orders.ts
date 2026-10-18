import type {
  InsufficientStockItem,
  Order,
  Oversell,
  StockPolicy,
  SubmitOrderResponse,
} from '@mpf/shared';
import type { TerminalCtx } from './auth.ts';
import type { Sql } from './db.ts';

class InsufficientStock extends Error {
  items: InsufficientStockItem[];
  constructor(items: InsufficientStockItem[]) {
    super('insufficient stock');
    this.items = items;
  }
}

export type SubmitResult =
  | { ok: true; response: SubmitOrderResponse }
  | { ok: false; items: InsufficientStockItem[] };

/**
 * Records an order and moves stock, atomically.
 *
 * Idempotent on order.id: resubmitting changes nothing and reports
 * 'duplicate', so terminals can retry freely after a lost response.
 */
export async function submitOrder(
  sql: Sql,
  terminal: TerminalCtx,
  order: Order,
  stockPolicy: StockPolicy,
): Promise<SubmitResult> {
  try {
    const response = await sql.begin(async (tx): Promise<SubmitOrderResponse> => {
      // Inserting first makes a concurrent duplicate wait for this transaction.
      const inserted = await tx`
        insert into orders ${tx({
          id: order.id,
          storeId: terminal.storeId,
          terminalId: terminal.id,
          cashierId: order.cashierId,
          ticketSeq: order.ticketSeq,
          ticketNumber: order.ticketNumber,
          stockPolicy,
          taxRateBps: order.taxRateBps,
          taxIncluded: order.taxIncluded,
          discountKind: order.discountKind,
          discountCents: order.discountCents,
          subtotalCents: order.subtotalCents,
          taxCents: order.taxCents,
          totalCents: order.totalCents,
          createdAt: order.createdAt,
          cashSessionId: order.cashSessionId,
        })}
        on conflict (id) do nothing
        returning id`;
      if (inserted.length === 0) return { status: 'duplicate', oversold: [] };

      await tx`insert into order_lines ${tx(order.lines.map((l) => ({ ...l, orderId: order.id })))}`;
      if (order.payments.length > 0) {
        await tx`insert into payments ${tx(order.payments.map((p) => ({ ...p, orderId: order.id })))}`;
      }

      const wanted = new Map<string, number>();
      for (const line of order.lines) {
        wanted.set(line.productId, (wanted.get(line.productId) ?? 0) + line.quantity);
      }
      // Sorted so concurrent orders lock stock rows in the same order.
      const productIds = [...wanted.keys()].sort();
      const tracked = await tx<{ id: string }[]>`
        select id from products where id in ${tx(productIds)} and track_stock`;
      const trackedIds = new Set(tracked.map((r) => r.id));

      const insufficient: InsufficientStockItem[] = [];
      const oversold: Oversell[] = [];
      // Made-on-demand products have no quantity; a sale not yet handed over
      // is refused while staff have them marked as sold out.
      if (stockPolicy === 'strict') {
        const gone = await tx<{ productId: string }[]>`
          select product_id from sold_out
          where store_id = ${terminal.storeId} and product_id in ${tx(productIds)}`;
        for (const { productId } of gone) {
          if (trackedIds.has(productId)) continue;
          insufficient.push({ productId, requested: wanted.get(productId)!, available: 0 });
        }
      }
      for (const productId of productIds) {
        if (!trackedIds.has(productId)) continue;
        const quantity = wanted.get(productId)!;
        const key = { storeId: terminal.storeId, productId };
        await tx`insert into stock ${tx({ ...key, quantity: 0 })} on conflict do nothing`;

        if (stockPolicy === 'strict') {
          const moved = await tx`
            update stock set quantity = quantity - ${quantity}
            where store_id = ${key.storeId} and product_id = ${productId} and quantity >= ${quantity}
            returning quantity`;
          if (moved.length === 0) {
            const [row] = await tx<{ quantity: number }[]>`
              select quantity from stock where store_id = ${key.storeId} and product_id = ${productId}`;
            insufficient.push({
              productId,
              requested: quantity,
              available: Math.max(row?.quantity ?? 0, 0),
            });
            continue;
          }
        } else {
          const [row] = await tx<{ quantity: number }[]>`
            update stock set quantity = quantity - ${quantity}
            where store_id = ${key.storeId} and product_id = ${productId}
            returning quantity`;
          if (row!.quantity < 0) {
            const shortfall = Math.min(quantity, -row!.quantity);
            oversold.push({ productId, shortfall });
            await tx`insert into stock_conflicts ${tx({ ...key, orderId: order.id, shortfall })}`;
          }
        }
        await tx`insert into stock_movements ${tx({
          ...key,
          delta: -quantity,
          reason: 'sale',
          orderId: order.id,
          userId: order.cashierId,
        })}`;
      }
      if (insufficient.length > 0) throw new InsufficientStock(insufficient);
      return { status: 'accepted', oversold };
    });
    return { ok: true, response };
  } catch (err) {
    if (err instanceof InsufficientStock) return { ok: false, items: err.items };
    throw err;
  }
}

export type VoidResult = 'voided' | 'already_voided' | 'not_found';

/** Voids an order and puts back exactly the stock its sale took. */
export async function voidOrder(
  sql: Sql,
  input: { orderId: string; storeId: string; userId: string; reason: string },
): Promise<VoidResult> {
  return sql.begin(async (tx): Promise<VoidResult> => {
    const voided = await tx`
      update orders set status = 'voided', voided_at = now(),
        voided_by = ${input.userId}, void_reason = ${input.reason}
      where id = ${input.orderId} and store_id = ${input.storeId} and status = 'completed'
      returning id`;
    if (voided.length === 0) {
      const existing = await tx`
        select 1 from orders where id = ${input.orderId} and store_id = ${input.storeId}`;
      return existing.length > 0 ? 'already_voided' : 'not_found';
    }
    const moves = await tx<{ productId: string; delta: number }[]>`
      select product_id, sum(delta)::int as delta from stock_movements
      where order_id = ${input.orderId} group by product_id having sum(delta) <> 0
      order by product_id`;
    for (const move of moves) {
      await tx`
        update stock set quantity = quantity - ${move.delta}
        where store_id = ${input.storeId} and product_id = ${move.productId}`;
      await tx`insert into stock_movements ${tx({
        storeId: input.storeId,
        productId: move.productId,
        delta: -move.delta,
        reason: 'void',
        orderId: input.orderId,
        userId: input.userId,
      })}`;
    }
    await tx`
      update stock_conflicts set resolved_at = now(), resolved_by = ${input.userId},
        resolution = 'order voided'
      where order_id = ${input.orderId} and resolved_at is null`;
    return 'voided';
  });
}
