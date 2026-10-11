import type { ReportOrder } from './schemas.ts';
import { type Cell, dateSerial, xlsx } from './xlsx.ts';

/** Whole local days, both inclusive, as yyyy-mm-dd (what a date input holds). */
export interface DateRange {
  from: string;
  to: string;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localDate(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + days);
  return localDate(d);
}

export function presets(today: string = localDate()): Record<'today' | 'yesterday' | 'week' | 'month', DateRange> {
  return {
    today: { from: today, to: today },
    yesterday: { from: addDays(today, -1), to: addDays(today, -1) },
    week: { from: addDays(today, -6), to: today },
    month: { from: `${today.slice(0, 8)}01`, to: today },
  };
}

export const validRange = (r: DateRange) =>
  /^\d{4}-\d{2}-\d{2}$/.test(r.from) && /^\d{4}-\d{2}-\d{2}$/.test(r.to) && r.from <= r.to;

/** The instants a range covers: local midnight of `from` up to local midnight after `to`. */
export function rangeBounds(range: DateRange): { from: string; to: string } {
  return {
    from: new Date(`${range.from}T00:00:00`).toISOString(),
    to: new Date(`${addDays(range.to, 1)}T00:00:00`).toISOString(),
  };
}

export interface Summary {
  /** Completed orders only; voided ones are counted apart and add no money. */
  orderCount: number;
  salesCents: number;
  taxCents: number;
  averageCents: number;
  cashCents: number;
  digitalCents: number;
  itemCount: number;
  voidedCount: number;
  voidedCents: number;
  topProducts: { name: string; quantity: number; totalCents: number }[];
}

export function summarize(orders: ReportOrder[], top = 5): Summary {
  const summary: Summary = {
    orderCount: 0, salesCents: 0, taxCents: 0, averageCents: 0, cashCents: 0, digitalCents: 0,
    itemCount: 0, voidedCount: 0, voidedCents: 0, topProducts: [],
  };
  const products = new Map<string, Summary['topProducts'][number]>();
  for (const order of orders) {
    if (order.status === 'voided') {
      summary.voidedCount += 1;
      summary.voidedCents += order.totalCents;
      continue;
    }
    summary.orderCount += 1;
    summary.salesCents += order.totalCents;
    summary.taxCents += order.taxCents;
    for (const p of order.payments) {
      if (p.method === 'cash') summary.cashCents += p.amountCents;
      else summary.digitalCents += p.amountCents;
    }
    for (const line of order.lines) {
      summary.itemCount += line.quantity;
      const entry = products.get(line.productId) ?? { name: line.name, quantity: 0, totalCents: 0 };
      entry.quantity += line.quantity;
      entry.totalCents += line.lineTotalCents;
      products.set(line.productId, entry);
    }
  }
  if (summary.orderCount > 0) summary.averageCents = Math.round(summary.salesCents / summary.orderCount);
  summary.topProducts = [...products.values()]
    .sort((a, b) => b.quantity - a.quantity || b.totalCents - a.totalCents)
    .slice(0, top);
  return summary;
}

// ---------------------------------------------------------------- exports

const HEADERS = [
  'Tiquete', 'Fecha', 'Hora', 'Cajero', 'Estado', 'Subtotal', 'Impuesto', 'Total',
  'Efectivo', 'Digital', 'Productos', 'Anulado por', 'Motivo',
];

/** One order as a line of an export; the columns of HEADERS, not yet formatted. */
function exportRow(o: ReportOrder) {
  const at = new Date(o.createdAt);
  const paid = (method: 'cash' | 'digital') =>
    o.payments.filter((p) => p.method === method).reduce((sum, p) => sum + p.amountCents, 0);
  return {
    ticketNumber: o.ticketNumber,
    day: localDate(at),
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
    cashierName: o.cashierName ?? '',
    status: o.status === 'voided' ? 'Anulado' : 'Completado',
    subtotalCents: o.subtotalCents,
    taxCents: o.taxCents,
    totalCents: o.totalCents,
    cashCents: paid('cash'),
    digitalCents: paid('digital'),
    products: o.lines.map((l) => `${l.quantity} x ${l.name}`).join(', '),
    voidedByName: o.voidedByName ?? '',
    voidReason: o.voidReason ?? '',
  };
}

// CSV for spreadsheets set to Spanish: ";" between columns, "," for decimals,
// and a BOM so Excel reads the accents. Amounts carry no thousands separator.
function amount(cents: number): string {
  const frac = cents % 100;
  return `${Math.floor(cents / 100)}${frac ? `,${pad(frac)}` : ''}`;
}

function text(value: string): string {
  // A leading = + - @ would be run as a formula by spreadsheets.
  const safe = /^[=+\-@]/.test(value) ? `'${value}` : value;
  return /[";\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
}

export function ordersCsv(orders: ReportOrder[]): string {
  const rows = orders.map((o) => {
    const r = exportRow(o);
    return [
      text(r.ticketNumber), r.day, r.time, text(r.cashierName), r.status,
      amount(r.subtotalCents), amount(r.taxCents), amount(r.totalCents),
      amount(r.cashCents), amount(r.digitalCents),
      text(r.products), text(r.voidedByName), text(r.voidReason),
    ].join(';');
  });
  return `﻿${[HEADERS.join(';'), ...rows].join('\r\n')}\r\n`;
}

export interface ExportInfo {
  businessName: string;
  storeName: string;
  range: DateRange;
  exportedAt?: Date;
}

/**
 * The same orders as an Excel file: who and what the export covers, the
 * figures of `summarize`, then every order in a table that can be filtered.
 */
export function ordersXlsx(orders: ReportOrder[], info: ExportInfo): Uint8Array {
  const summary = summarize(orders);
  const rows = orders.map(exportRow);
  const exportedAt = info.exportedAt ?? new Date();
  const day = (iso: string) => iso.split('-').reverse().join('/');
  // A spreadsheet holds amounts in whole currency units, not minor ones.
  const money = (cents: number, style: 'money' | 'moneyBold' = 'money'): Cell => ({ value: cents / 100, style });
  const { from, to } = info.range;

  const sheet: Cell[][] = [
    [{ value: info.businessName, style: 'title' }],
    [{ value: `Ventas · ${info.storeName}`, style: 'bold' }],
    ['Fechas', from === to ? day(from) : `${day(from)} a ${day(to)}`],
    ['Exportado', `${day(localDate(exportedAt))} ${pad(exportedAt.getHours())}:${pad(exportedAt.getMinutes())}`],
    [],
    [{ value: 'Ventas', style: 'bold' }, money(summary.salesCents, 'moneyBold')],
    ['Pedidos', summary.orderCount],
    ['Efectivo', money(summary.cashCents)],
    ['Digital', money(summary.digitalCents)],
    ['Impuesto', money(summary.taxCents)],
    ['Pedidos anulados', summary.voidedCount],
    ['Valor anulado', money(summary.voidedCents)],
    ['Los pedidos anulados aparecen en la tabla, pero no suman en las ventas.'],
    [],
  ];
  const headerRow = sheet.length;
  sheet.push(HEADERS);
  for (const r of rows) {
    sheet.push([
      r.ticketNumber, { value: dateSerial(r.day), style: 'date' }, r.time, r.cashierName, r.status,
      money(r.subtotalCents), money(r.taxCents), money(r.totalCents), money(r.cashCents), money(r.digitalCents),
      r.products, r.voidedByName, r.voidReason,
    ]);
  }
  const allCents = rows.flatMap((r) => [r.subtotalCents, r.taxCents, r.totalCents, r.cashCents, r.digitalCents]);
  return xlsx({
    name: 'Pedidos',
    rows: sheet,
    widths: [18, 14, 8, 22, 13, 13, 13, 13, 13, 13, 50, 20, 32],
    // A table needs at least one line under its headings.
    table: rows.length > 0 ? { name: 'TablaPedidos', headerRow } : undefined,
    moneyDecimals: allCents.some((cents) => cents % 100 !== 0),
  });
}
