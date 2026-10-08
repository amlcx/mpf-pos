import { type Order, changeDueCents, formatCents } from '@mpf/shared';

/** One printed row. `big` rows are double size, so they hold half the columns. */
export interface TicketRow {
  text: string;
  align?: 'left' | 'center';
  big?: boolean;
}

export interface TicketData {
  businessName: string;
  storeName: string;
  cashierName: string;
  order: Order & { status?: 'completed' | 'voided' };
  /** Characters per line: 48 for 80mm paper, 32 for 58mm. */
  columns: number;
}

// Printed text is for customers, so it is Spanish like the rest of the UI.
const METHOD_LABEL = { cash: 'Efectivo', digital: 'Digital' } as const;

/** "left ........ right", truncating the left side to fit. */
function pair(left: string, right: string, columns: number): string {
  const room = Math.max(columns - right.length - 1, 0);
  return left.slice(0, room).padEnd(columns - right.length) + right;
}

function localTime(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function ticketRows({ businessName, storeName, cashierName, order, columns }: TicketData): TicketRow[] {
  const rule = '-'.repeat(columns);
  const money = (cents: number) => formatCents(cents);
  const rows: TicketRow[] = [
    { text: businessName.toUpperCase(), align: 'center' },
    { text: storeName, align: 'center' },
    { text: order.ticketNumber, align: 'center', big: true },
    { text: pair(localTime(order.createdAt), cashierName, columns) },
    { text: rule },
  ];
  if (order.status === 'voided') rows.push({ text: '*** ANULADO ***', align: 'center' }, { text: rule });
  for (const line of order.lines) {
    rows.push({ text: pair(`${line.quantity} x ${line.name}`, money(line.lineTotalCents), columns) });
  }
  rows.push({ text: rule });
  if (order.taxCents > 0) {
    const rate = `${String(order.taxRateBps / 100).replace('.', ',')}%`;
    rows.push(
      { text: pair('Subtotal', money(order.subtotalCents), columns) },
      { text: pair(`Impuesto ${rate}`, money(order.taxCents), columns) },
    );
  }
  rows.push({ text: pair('TOTAL', money(order.totalCents), columns) }, { text: rule });
  for (const p of order.payments) {
    rows.push({ text: pair(METHOD_LABEL[p.method], money(p.tenderedCents ?? p.amountCents), columns) });
  }
  const change = changeDueCents(order);
  if (change > 0) rows.push({ text: pair('Cambio', money(change), columns) });
  return rows;
}

/** Plain-text rendering, for on-screen preview and tests. */
export function ticketText(rows: TicketRow[], columns: number): string {
  return rows
    .map((row) => {
      const width = row.big ? Math.floor(columns / 2) : columns;
      if (row.align !== 'center') return row.text;
      return ' '.repeat(Math.max(Math.floor((width - row.text.length) / 2), 0)) + row.text;
    })
    .join('\n');
}

// Until we pick a code page for the real printer, print plain ASCII:
// accents are dropped ("Limón" -> "Limon"), anything else becomes "?".
function ascii(text: string): number[] {
  const plain = text.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return Array.from(plain, (ch) => (ch.charCodeAt(0) < 0x80 ? ch.charCodeAt(0) : 0x3f));
}

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** ESC/POS bytes for a ticket: initialise, rows, feed, partial cut. */
export function escpos(rows: TicketRow[]): Uint8Array {
  const out: number[] = [ESC, 0x40];
  for (const row of rows) {
    out.push(ESC, 0x61, row.align === 'center' ? 1 : 0);
    out.push(GS, 0x21, row.big ? 0x11 : 0x00);
    out.push(...ascii(row.text), LF);
  }
  out.push(GS, 0x21, 0x00, ESC, 0x61, 0, LF, LF, LF, GS, 0x56, 0x42, 0x03);
  return Uint8Array.from(out);
}
