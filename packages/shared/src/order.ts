import { computeTotals, discountCentsFor } from './money.ts';
import type { DiscountKind, Order, OrderLine, Payment, PaymentMethod } from './schemas.ts';
import { uuidv7 } from './uuid.ts';

export function ticketNumber(terminalCode: string, seq: number): string {
  return `${terminalCode}-${String(seq).padStart(4, '0')}`;
}

export interface CartItem {
  productId: string;
  name: string;
  unitPriceCents: number;
  quantity: number;
}
export interface PaymentInput {
  method: PaymentMethod;
  amountCents: number;
  /** Cash only; defaults to amountCents (exact change). */
  tenderedCents?: number;
}

export function buildOrder(input: {
  cart: CartItem[];
  payments: PaymentInput[];
  cashierId: string;
  terminalCode: string;
  ticketSeq: number;
  taxRateBps: number;
  taxIncluded: boolean;
  discountKind?: DiscountKind | null;
  /** The drawer open on this register, which the sale's cash goes into. */
  cashSessionId?: string | null;
  now?: Date;
}): Order {
  const now = input.now ?? new Date();
  const lines: OrderLine[] = input.cart.map((item) => ({
    id: uuidv7(now.getTime()),
    productId: item.productId,
    name: item.name,
    unitPriceCents: item.unitPriceCents,
    quantity: item.quantity,
    lineTotalCents: item.unitPriceCents * item.quantity,
  }));
  const payments: Payment[] = input.payments.map((p) => ({
    id: uuidv7(now.getTime()),
    method: p.method,
    amountCents: p.amountCents,
    tenderedCents: p.method === 'cash' ? (p.tenderedCents ?? p.amountCents) : null,
  }));
  const lineTotals = lines.map((l) => l.lineTotalCents);
  const discountKind = input.discountKind ?? null;
  return {
    id: uuidv7(now.getTime()),
    cashierId: input.cashierId,
    ticketSeq: input.ticketSeq,
    ticketNumber: ticketNumber(input.terminalCode, input.ticketSeq),
    createdAt: now.toISOString(),
    taxRateBps: input.taxRateBps,
    taxIncluded: input.taxIncluded,
    discountKind,
    cashSessionId: input.cashSessionId ?? null,
    ...computeTotals(
      lineTotals,
      input.taxRateBps,
      input.taxIncluded,
      discountCentsFor(discountKind, lineTotals),
    ),
    lines,
    payments,
  };
}

/**
 * Arithmetic invariants of an order. Returns human-readable problems; an
 * empty array means the order is internally consistent. Shape is validated
 * separately by OrderSchema.
 */
export function orderProblems(order: Order): string[] {
  const problems: string[] = [];
  for (const line of order.lines) {
    if (line.lineTotalCents !== line.unitPriceCents * line.quantity) {
      problems.push(`line "${line.name}": total is not unit price x quantity`);
    }
  }
  // A discount is never a free amount: its kind fixes how much it is.
  const lineTotals = order.lines.map((l) => l.lineTotalCents);
  if (order.discountCents !== discountCentsFor(order.discountKind, lineTotals)) {
    problems.push('discount does not match its kind');
  }
  const totals = computeTotals(lineTotals, order.taxRateBps, order.taxIncluded, order.discountCents);
  if (
    totals.subtotalCents !== order.subtotalCents ||
    totals.taxCents !== order.taxCents ||
    totals.totalCents !== order.totalCents
  ) {
    problems.push('order totals do not match its lines');
  }
  const paid = order.payments.reduce((sum, p) => sum + p.amountCents, 0);
  if (paid !== order.totalCents) {
    problems.push(`payments add up to ${paid} but the total is ${order.totalCents}`);
  }
  for (const p of order.payments) {
    if (p.method === 'cash') {
      if (p.tenderedCents === null || p.tenderedCents < p.amountCents) {
        problems.push('cash tendered is less than the cash amount');
      }
    } else if (p.tenderedCents !== null) {
      problems.push('only cash payments can have a tendered amount');
    }
  }
  return problems;
}

/** Change to hand back across all cash payments. */
export function changeDueCents(order: Pick<Order, 'payments'>): number {
  return order.payments.reduce(
    (sum, p) => sum + (p.tenderedCents === null ? 0 : p.tenderedCents - p.amountCents),
    0,
  );
}
