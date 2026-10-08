import * as v from 'valibot';
import { describe, expect, it } from 'vitest';
import {
  OrderSchema,
  buildOrder,
  changeDueCents,
  computeTotals,
  formatCents,
  hashPassword,
  orderProblems,
  parseCents,
  uuidv7,
  verifyPassword,
} from '../src/index.ts';

describe('money', () => {
  it('parses and formats', () => {
    expect(parseCents('12')).toBe(1200);
    expect(parseCents('12000')).toBe(1_200_000);
    expect(parseCents('12.000')).toBe(1_200_000);
    expect(parseCents('1.234.567,89')).toBe(123_456_789);
    expect(parseCents('12,5')).toBe(1250);
    expect(parseCents('12,05')).toBe(1205);
    expect(parseCents('12.5')).toBeNull();
    expect(parseCents('12,345')).toBeNull();
    expect(parseCents('-1')).toBeNull();
    expect(formatCents(1_200_000, '$')).toBe('$12.000');
    expect(formatCents(123_456_789)).toBe('1.234.567,89');
    expect(formatCents(1205, '$')).toBe('$12,05');
    expect(formatCents(99_900)).toBe('999');
    expect(formatCents(-5)).toBe('-0,05');
    for (const cents of [0, 5, 1205, 99_900, 1_200_000, 123_456_789]) {
      expect(parseCents(formatCents(cents))).toBe(cents);
    }
  });

  it('computes tax included and excluded', () => {
    expect(computeTotals([1000, 300], 1300, true)).toEqual({
      subtotalCents: 1150,
      taxCents: 150,
      totalCents: 1300,
    });
    expect(computeTotals([1000], 1300, false)).toEqual({
      subtotalCents: 1000,
      taxCents: 130,
      totalCents: 1130,
    });
    expect(computeTotals([999], 0, true).taxCents).toBe(0);
  });
});

describe('orders', () => {
  const base = {
    cart: [
      { productId: uuidv7(), name: 'Flan', unitPriceCents: 1500, quantity: 2 },
      { productId: uuidv7(), name: 'Brownie', unitPriceCents: 1200, quantity: 1 },
    ],
    cashierId: uuidv7(),
    terminalCode: 'A',
    ticketSeq: 42,
    taxRateBps: 1300,
    taxIncluded: true,
  };

  it('builds a consistent split-payment order', () => {
    const order = buildOrder({
      ...base,
      payments: [
        { method: 'cash', amountCents: 2000, tenderedCents: 5000 },
        { method: 'digital', amountCents: 2200 },
      ],
    });
    expect(order.ticketNumber).toBe('A-0042');
    expect(order.totalCents).toBe(4200);
    expect(orderProblems(order)).toEqual([]);
    expect(changeDueCents(order)).toBe(3000);
    expect(v.safeParse(OrderSchema, order).success).toBe(true);
  });

  it('reports payments that do not cover the total', () => {
    const order = buildOrder({ ...base, payments: [{ method: 'digital', amountCents: 4000 }] });
    expect(orderProblems(order)).toHaveLength(1);
  });

  it('reports tampered totals', () => {
    const order = buildOrder({ ...base, payments: [{ method: 'digital', amountCents: 4200 }] });
    order.lines[0]!.lineTotalCents = 1;
    expect(orderProblems(order).length).toBeGreaterThan(0);
  });
});

describe('passwords and ids', () => {
  it('verifies only the right password', async () => {
    const hash = await hashPassword('1234', 1000);
    expect(await verifyPassword('1234', hash)).toBe(true);
    expect(await verifyPassword('4321', hash)).toBe(false);
    expect(await verifyPassword('1234', 'garbage')).toBe(false);
  });

  it('generates sortable, valid v7 uuids', () => {
    const a = uuidv7(1_000);
    const b = uuidv7(2_000);
    expect(a < b).toBe(true);
    expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});
