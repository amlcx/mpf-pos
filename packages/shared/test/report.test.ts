import { describe, expect, it } from 'vitest';
import {
  type ReportOrder,
  addDays,
  buildOrder,
  ordersCsv,
  presets,
  rangeBounds,
  summarize,
  uuidv7,
  validRange,
} from '../src/index.ts';

const flan = uuidv7();
const cafe = uuidv7();
let seq = 0;

function order(
  items: [id: string, name: string, price: number, quantity: number][],
  cashCents: number,
  status: ReportOrder['status'] = 'completed',
): ReportOrder {
  const cart = items.map(([productId, name, unitPriceCents, quantity]) => ({ productId, name, unitPriceCents, quantity }));
  const total = cart.reduce((sum, i) => sum + i.unitPriceCents * i.quantity, 0);
  const payments = [
    ...(cashCents > 0 ? [{ method: 'cash' as const, amountCents: cashCents, tenderedCents: cashCents + 500_000 }] : []),
    ...(total > cashCents ? [{ method: 'digital' as const, amountCents: total - cashCents }] : []),
  ];
  return {
    ...buildOrder({
      cart, payments, cashierId: uuidv7(), terminalCode: 'A', ticketSeq: ++seq,
      taxRateBps: 800, taxIncluded: true, now: new Date(2026, 9, 7, 9, 5),
    }),
    status,
    cashierName: 'Ana; "la jefa"',
  };
}

const orders = [
  order([[flan, 'Flan', 1_200_000, 2], [cafe, 'Café', 900_000, 1]], 1_000_000),
  order([[cafe, 'Café', 900_000, 3]], 0),
  order([[flan, 'Flan', 1_200_000, 5]], 6_000_000, 'voided'),
];

describe('reports', () => {
  it('summarises completed orders and keeps voided ones apart', () => {
    expect(summarize(orders)).toMatchObject({
      orderCount: 2,
      salesCents: 6_000_000,
      averageCents: 3_000_000,
      cashCents: 1_000_000, // what was owed in cash, not what was handed over
      digitalCents: 5_000_000,
      itemCount: 6,
      voidedCount: 1,
      voidedCents: 6_000_000,
      topProducts: [
        { name: 'Café', quantity: 4, totalCents: 3_600_000 },
        { name: 'Flan', quantity: 2, totalCents: 2_400_000 },
      ],
    });
    expect(summarize([])).toMatchObject({ orderCount: 0, averageCents: 0, topProducts: [] });
  });

  it('exports a spreadsheet-friendly CSV', () => {
    const csv = ordersCsv(orders);
    expect(csv.startsWith('﻿Tiquete;Fecha;Hora;Cajero;Estado;')).toBe(true);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      'A-0001;2026-10-07;09:05;"Ana; ""la jefa""";Completado;30555,56;2444,44;33000;10000;23000;2 x Flan, 1 x Café;;',
    );
    expect(lines[3]).toContain(';Anulado;');
    expect(ordersCsv([{ ...orders[0]!, cashierName: '=HYPERLINK("x")' }])).toContain(`;"'=HYPERLINK(""x"")";`);
  });

  it('turns local days into instants', () => {
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(presets('2026-10-07')).toEqual({
      today: { from: '2026-10-07', to: '2026-10-07' },
      yesterday: { from: '2026-10-06', to: '2026-10-06' },
      week: { from: '2026-10-01', to: '2026-10-07' },
      month: { from: '2026-10-01', to: '2026-10-07' },
    });
    const { from, to } = rangeBounds({ from: '2026-10-07', to: '2026-10-07' });
    expect(new Date(from)).toEqual(new Date(2026, 9, 7));
    expect(new Date(to)).toEqual(new Date(2026, 9, 8));
    expect(validRange({ from: '2026-10-08', to: '2026-10-07' })).toBe(false);
    expect(validRange({ from: '', to: '2026-10-07' })).toBe(false);
  });
});
