import { buildOrder, uuidv7 } from '@mpf/shared';
import { describe, expect, it } from 'vitest';
import { escpos, ticketRows, ticketText } from '../src/lib/ticket.ts';

const order = buildOrder({
  cart: [
    { productId: uuidv7(), name: 'Pie de limón', unitPriceCents: 1500, quantity: 2 },
    { productId: uuidv7(), name: 'A dessert with a very long name that will not fit', unitPriceCents: 1200, quantity: 1 },
  ],
  payments: [
    { method: 'cash', amountCents: 2000, tenderedCents: 5000 },
    { method: 'digital', amountCents: 2200 },
  ],
  cashierId: uuidv7(),
  terminalCode: 'A',
  ticketSeq: 42,
  taxRateBps: 1300,
  taxIncluded: true,
  now: new Date(2026, 9, 7, 12, 30),
});

describe('ticket', () => {
  for (const columns of [48, 32]) {
    it(`fits ${columns} columns`, () => {
      const rows = ticketRows({ businessName: 'Mi Postre Favorito', storeName: 'Main Store', cashierName: 'Ana', order, columns });
      for (const row of rows) expect(row.text.length).toBeLessThanOrEqual(row.big ? columns / 2 : columns);
      const text = ticketText(rows, columns);
      expect(text).toContain('A-0042');
      expect(text).toContain('2026-10-07 12:30');
      expect(text).toMatch(/TOTAL +42$/m);
      expect(text).toMatch(/Efectivo +50$/m);
      expect(text).toMatch(/Digital +22$/m);
      expect(text).toMatch(/Cambio +30$/m);
    });
  }

  const rows = ticketRows({ businessName: 'Mi Postre Favorito', storeName: 'Main Store', cashierName: 'Ana', order, columns: 48 });

  it('encodes ESC/POS as plain ASCII ending in a cut', () => {
    const bytes = escpos(rows, { cutter: true, openDrawer: false });
    expect([...bytes.slice(0, 2)]).toEqual([0x1b, 0x40]);
    expect([...bytes.slice(-4)]).toEqual([0x1d, 0x56, 0x42, 0x03]);
    expect(bytes.every((b) => b < 0x80)).toBe(true);
    expect(new TextDecoder().decode(bytes)).toContain('Pie de limon');
  });

  it('feeds instead of cutting on a printer without a cutter', () => {
    const bytes = [...escpos(rows, { cutter: false, openDrawer: false })];
    expect(bytes.slice(-4)).toEqual([0x0a, 0x0a, 0x0a, 0x0a]);
    // GS V (cut) appears nowhere.
    expect(bytes.some((b, i) => b === 0x1d && bytes[i + 1] === 0x56)).toBe(false);
  });

  it('pulses the cash drawer only when asked', () => {
    const pulse = [0x1b, 0x70, 0x00, 0x19, 0xfa];
    expect([...escpos(rows, { cutter: false, openDrawer: true }).slice(2, 7)]).toEqual(pulse);
    const closed = [...escpos(rows, { cutter: false, openDrawer: false })];
    expect(closed.some((b, i) => b === 0x1b && closed[i + 1] === 0x70)).toBe(false);
  });
});
