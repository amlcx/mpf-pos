import {
  type CartItem,
  type DiscountKind,
  type InsufficientStockItem,
  type PaymentInput,
  buildOrder,
  orderProblems,
} from '@mpf/shared';
import { type LocalOrder, getOrder, insertOrder, listProducts, loadContext } from './repo.ts';
import { type SyncDeps, pull, pushOrder } from './sync.ts';

export type CheckoutResult =
  /** synced = false: sold offline, will be sent to the server later. */
  | { ok: true; order: LocalOrder; synced: boolean }
  | { ok: false; reason: 'insufficient_stock'; items: InsufficientStockItem[] }
  | { ok: false; reason: 'invalid'; problems: string[] };

export interface CheckoutInput {
  cart: CartItem[];
  payments: PaymentInput[];
  cashierId: string;
  discountKind?: DiscountKind | null;
  /** Skip the server round trip when we already know we are offline. */
  online: boolean;
  now?: Date;
}

// One sale at a time: ticket numbers are read, then written.
let queue: Promise<unknown> = Promise.resolve();

export function checkout(deps: SyncDeps, input: CheckoutInput): Promise<CheckoutResult> {
  const run = queue.then(() => checkoutNow(deps, input));
  queue = run.catch(() => {});
  return run;
}

async function checkoutNow(deps: SyncDeps, input: CheckoutInput): Promise<CheckoutResult> {
  const { db } = deps;
  const context = await loadContext(db);
  if (!context) return { ok: false, reason: 'invalid', problems: ['terminal is not set up'] };

  // Never sell what this terminal already knows is gone, online or not.
  const wanted = new Map<string, number>();
  for (const item of input.cart) {
    wanted.set(item.productId, (wanted.get(item.productId) ?? 0) + item.quantity);
  }
  const products = new Map((await listProducts(db)).map((p) => [p.id, p]));
  const short: InsufficientStockItem[] = [];
  for (const [productId, requested] of wanted) {
    const available = products.get(productId)?.available;
    if (available != null && available < requested) {
      short.push({ productId, requested, available: Math.max(available, 0) });
    }
  }
  if (short.length > 0) return { ok: false, reason: 'insufficient_stock', items: short };

  const order = buildOrder({
    cart: input.cart,
    payments: input.payments,
    cashierId: input.cashierId,
    discountKind: input.discountKind,
    terminalCode: context.terminal.code,
    ticketSeq: context.nextTicketSeq,
    taxRateBps: context.store.taxRateBps,
    taxIncluded: context.store.taxIncluded,
    now: input.now,
  });
  const problems = orderProblems(order);
  if (problems.length > 0) return { ok: false, reason: 'invalid', problems };

  // Write locally before talking to the server, so a crash mid-request can
  // never lose a sale the server accepted or reuse its ticket number.
  await db.batch(insertOrder(order, input.online ? 'submitting' : 'pending'));

  if (input.online) {
    const outcome = await pushOrder(deps, {
      ...order,
      status: 'completed',
      cashierName: null,
      syncStatus: 'submitting',
      syncError: null,
      oversold: false,
    });
    if (outcome.kind === 'rejected') {
      await pull(deps).catch(() => false); // our stock numbers were stale
      return { ok: false, reason: 'insufficient_stock', items: outcome.items };
    }
    if (outcome.kind === 'unreachable') {
      // The sale goes ahead; from here on the server has to accept it.
      await db.batch([
        { sql: "update orders set sync_status = 'pending' where id = ? and sync_status = 'submitting'", params: [order.id] },
      ]);
    }
  }
  const saved = (await getOrder(db, order.id))!;
  return { ok: true, order: saved, synced: saved.syncStatus === 'synced' };
}
