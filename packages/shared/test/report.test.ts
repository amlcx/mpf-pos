import { describe, expect, it } from 'vitest';
import {
  type ReportOrder,
  addDays,
  buildOrder,
  businessDate,
  cashSessionProblems,
  countCents,
  expectedCashCents,
  ordersCsv,
  ordersXlsx,
  presets,
  productSales,
  productsXlsx,
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

  it('counts loyalty card discounts apart, at what was really charged', () => {
    const card: ReportOrder = {
      ...buildOrder({
        cart: [{ productId: flan, name: 'Flan', unitPriceCents: 1_200_000, quantity: 2 }],
        payments: [{ method: 'digital', amountCents: 1_200_000 }],
        cashierId: uuidv7(), terminalCode: 'A', ticketSeq: 99, taxRateBps: 800, taxIncluded: true,
        discountKind: 'loyalty_card',
      }),
      status: 'completed',
      cashierName: 'Ana',
    };
    expect(summarize([orders[1]!, card, { ...card, status: 'voided' }])).toMatchObject({
      orderCount: 2,
      salesCents: 2_700_000 + 1_200_000,
      digitalCents: 2_700_000 + 1_200_000,
      discountCount: 1,
      discountCents: 1_200_000,
      voidedCents: 1_200_000,
    });
    expect(ordersCsv([card])).toContain(';Completado;12000;11111,11;888,89;12000;0;12000;2 x Flan;;');
  });

  it('exports a spreadsheet-friendly CSV', () => {
    const csv = ordersCsv(orders);
    expect(csv.startsWith('﻿Tiquete;Fecha;Hora;Cajero;Estado;')).toBe(true);
    const lines = csv.trimEnd().split('\r\n');
    expect(lines).toHaveLength(4);
    expect(lines[1]).toBe(
      'A-0001;2026-10-07;09:05;"Ana; ""la jefa""";Completado;0;30555,56;2444,44;33000;10000;23000;2 x Flan, 1 x Café;;',
    );
    expect(lines[3]).toContain(';Anulado;');
    expect(ordersCsv([{ ...orders[0]!, cashierName: '=HYPERLINK("x")' }])).toContain(`;"'=HYPERLINK(""x"")";`);
  });

  it('exports an Excel file with a header, the summary and a table', () => {
    const voided = { ...orders[2]!, voidedByName: 'Ana <jefa>', voidReason: '=1+1 & más' };
    const file = ordersXlsx([orders[0]!, orders[1]!, voided], {
      businessName: 'Mi Postre',
      storeName: 'Centro',
      range: { from: '2026-10-07', to: '2026-10-08' },
      exportedAt: new Date(2026, 9, 9, 8, 30),
    });
    // Entries are stored uncompressed, so the parts can be read straight from the bytes.
    const raw = new TextDecoder().decode(file);
    expect(raw.startsWith('PK')).toBe(true);
    for (const text of ['Mi Postre', 'Ventas · Centro', '07/10/2026 a 08/10/2026', '09/10/2026 08:30']) {
      expect(raw, text).toContain(`<t xml:space="preserve">${text}</t>`);
    }
    // Sales leave the voided order out: 60.000, as a number in whole pesos.
    expect(raw).toContain('<c r="B6" s="5"><v>60000</v></c>');
    expect(raw).toContain('<c r="B13"><v>1</v></c>');
    expect(raw).toContain('<c r="B14" s="3"><v>60000</v></c>');
    // 16 rows above the table, its headings on row 17, then the three orders.
    expect(raw).toContain('ref="A17:N20"');
    expect(raw).toContain('<tableColumn id="14" name="Motivo"/>');
    // 2026-10-07 as a real date, and the total of the first order.
    expect(raw).toContain('<c r="B18" s="4"><v>46302</v></c>');
    expect(raw).toContain('<c r="I18" s="3"><v>33000</v></c>');
    // Text stays text: escaped, never a formula.
    expect(raw).toContain('Ana &lt;jefa&gt;');
    expect(raw).toContain('=1+1 &amp; más');
    expect(raw).not.toContain('<f>');

    const empty = new TextDecoder().decode(ordersXlsx([], { businessName: 'X', storeName: 'Y', range: { from: '2026-10-07', to: '2026-10-07' } }));
    expect(empty).not.toContain('tables/table1.xml');
  });

  it('totals each product at what was charged, loyalty card discounts included', () => {
    const card: ReportOrder = {
      ...buildOrder({
        cart: [
          { productId: flan, name: 'Flan', unitPriceCents: 1_200_000, quantity: 2 },
          { productId: cafe, name: 'Café', unitPriceCents: 900_000, quantity: 1 },
        ],
        payments: [{ method: 'cash', amountCents: 1_650_000 }],
        cashierId: uuidv7(), terminalCode: 'A', ticketSeq: 98, taxRateBps: 800, taxIncluded: true,
        discountKind: 'loyalty_card',
      }),
      status: 'completed',
      cashierName: 'Ana',
    };
    // orders[0]: 2 flans 24.000 + 1 café 9.000; orders[1]: 3 cafés 27.000;
    // card: the same as orders[0] at half price; orders[2] is voided.
    const products = productSales([...orders, card]);
    expect(products).toEqual([
      { productId: cafe, name: 'Café', quantity: 5, totalCents: 900_000 + 2_700_000 + 450_000 },
      { productId: flan, name: 'Flan', quantity: 4, totalCents: 2_400_000 + 1_200_000 },
    ]);
    expect(summarize([...orders, card]).topProducts).toEqual(products);
  });

  it('splits an order over its products to the exact cent', () => {
    // Tax added on top of a discounted 3 + 3 + 1 cents: a total that does not divide evenly.
    const odd: ReportOrder = {
      ...buildOrder({
        cart: [
          { productId: flan, name: 'Flan', unitPriceCents: 3, quantity: 1 },
          { productId: cafe, name: 'Café', unitPriceCents: 3, quantity: 1 },
          { productId: uuidv7(), name: 'Té', unitPriceCents: 1, quantity: 1 },
        ],
        payments: [{ method: 'digital', amountCents: 5 }],
        cashierId: uuidv7(), terminalCode: 'A', ticketSeq: 97, taxRateBps: 1900, taxIncluded: false,
        discountKind: 'loyalty_card',
      }),
      status: 'completed',
      cashierName: 'Ana',
    };
    const products = productSales([odd]);
    expect(products.reduce((sum, p) => sum + p.totalCents, 0)).toBe(odd.totalCents);
    // 7 - 4 discount = 3, plus 1 tax: 4 cents over 3/7, 3/7, 1/7 (1,71 · 1,71 · 0,57).
    expect(odd.totalCents).toBe(4);
    expect(products.map((p) => p.totalCents)).toEqual([2, 2, 0]);
    expect(productSales([])).toEqual([]);
  });

  it('exports sales per product to Excel, with a total that matches the sales', () => {
    const file = productsXlsx(orders, {
      businessName: 'Mi Postre',
      storeName: 'Centro',
      range: { from: '2026-10-07', to: '2026-10-07' },
      exportedAt: new Date(2026, 9, 9, 8, 30),
    });
    const raw = new TextDecoder().decode(file);
    for (const text of ['Ventas por producto · Centro', '07/10/2026', 'Producto', 'Unidades', 'Café', 'Flan', 'Total']) {
      expect(raw, text).toContain(`<t xml:space="preserve">${text}</t>`);
    }
    // 11 rows above the table, headings on row 12, two products; the total is below it.
    expect(raw).toContain('ref="A12:C14"');
    expect(raw).toContain('<c r="B13"><v>4</v></c>');
    expect(raw).toContain('<c r="C13" s="3"><v>36000</v></c>');
    expect(raw).toContain('<c r="C16" s="5"><v>60000</v></c>');
    expect(raw).not.toContain('<f>');

    const empty = new TextDecoder().decode(productsXlsx([], { businessName: 'X', storeName: 'Y', range: { from: '2026-10-07', to: '2026-10-07' } }));
    expect(empty).not.toContain('tables/table1.xml');
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

describe('cash drawer', () => {
  it('adds up a count of bills and coins', () => {
    expect(countCents({ '10000000': 1, '2000000': 2, '50000': 3, '5000': 1 })).toBe(10_000_000 + 4_000_000 + 150_000 + 5_000);
    expect(countCents({})).toBe(0);
  });

  it('starts the business day at 5:00, not at midnight', () => {
    expect(businessDate(new Date(2026, 9, 7, 23, 59))).toBe('2026-10-07');
    expect(businessDate(new Date(2026, 9, 8, 0, 30))).toBe('2026-10-07');
    expect(businessDate(new Date(2026, 9, 8, 4, 59))).toBe('2026-10-07');
    expect(businessDate(new Date(2026, 9, 8, 5, 0))).toBe('2026-10-08');
  });

  it('expects the opening, plus cash sales that stand, plus cash in, minus cash out', () => {
    const sold = order([[flan, 'Flan', 1_200_000, 2]], 1_000_000); // 10.000 cash, 14.000 digital
    const voided = order([[flan, 'Flan', 1_200_000, 1]], 1_200_000, 'voided');
    const movements = [
      { kind: 'in' as const, amountCents: 500_000 },
      { kind: 'out' as const, amountCents: 2_000_000 },
    ];
    expect(expectedCashCents(5_000_000, [sold, voided], movements)).toBe(5_000_000 + 1_000_000 + 500_000 - 2_000_000);
  });

  it('refuses drawers whose totals do not match their counts', () => {
    const base = {
      id: uuidv7(),
      businessDate: '2026-10-07',
      openedBy: uuidv7(),
      openedAt: '2026-10-07T13:00:00.000Z',
      openingCount: { '5000000': 1 },
      openingCents: 5_000_000,
      movements: [],
      closing: null,
    };
    expect(cashSessionProblems(base)).toEqual([]);
    expect(cashSessionProblems({ ...base, openingCents: 4_000_000 })).toEqual(['opening total does not match its count']);
    const closing = {
      closedBy: base.openedBy,
      closedAt: '2026-10-08T01:00:00.000Z',
      count: { '5000000': 1 },
      countedCents: 5_000_000,
      expectedCents: 5_000_000,
      note: '',
    };
    expect(cashSessionProblems({ ...base, closing })).toEqual([]);
    expect(cashSessionProblems({ ...base, closing: { ...closing, expectedCents: 5_200_000 } })).toEqual([
      'a closing that does not match needs a note',
    ]);
    expect(cashSessionProblems({ ...base, closing: { ...closing, expectedCents: 5_200_000, note: 'Faltan 2.000' } })).toEqual([]);
    expect(cashSessionProblems({ ...base, closing: { ...closing, countedCents: 1, note: 'x' } })).toEqual([
      'closing total does not match its count',
    ]);
  });
});
