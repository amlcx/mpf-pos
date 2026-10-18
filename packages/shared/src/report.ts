import type { CashMovement, ReportOrder } from './schemas.ts';
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
  /** Completed orders sold with a discount, and how much the discounts took off. */
  discountCount: number;
  discountCents: number;
  topProducts: ProductSales[];
}

/** One product over a set of orders: units sold and what was charged for them. */
export interface ProductSales {
  productId: string;
  name: string;
  quantity: number;
  /** Its share of what customers paid: after any discount, with tax as charged. */
  totalCents: number;
}

/**
 * What each line of an order brought in: the order's total split in
 * proportion to its lines' full prices. A discount takes the same share off
 * every line (a loyalty card halves them all), so this is the line at what
 * was charged. Rounding is settled by largest remainder, so the shares
 * always add up to exactly the order's total.
 */
function chargedLineCents(order: ReportOrder): number[] {
  const full = order.lines.map((l) => BigInt(l.lineTotalCents));
  const sum = full.reduce((a, b) => a + b, 0n);
  if (sum === 0n) return full.map(() => 0);
  const total = BigInt(order.totalCents);
  const shares = full.map((line) => (total * line) / sum);
  const remainders = full.map((line, i) => ({ i, rest: (total * line) % sum }));
  let left = Number(total - shares.reduce((a, b) => a + b, 0n));
  remainders.sort((a, b) => (b.rest > a.rest ? 1 : b.rest < a.rest ? -1 : a.i - b.i));
  for (const { i } of remainders) {
    if (left-- <= 0) break;
    shares[i]! += 1n;
  }
  return shares.map(Number);
}

/**
 * Units and money per product over completed orders, most sold first. The
 * money adds up to the sales of `summarize`: discounted orders count at what
 * was charged, voided ones not at all.
 */
export function productSales(orders: ReportOrder[]): ProductSales[] {
  const products = new Map<string, ProductSales>();
  for (const order of orders) {
    if (order.status === 'voided') continue;
    const charged = chargedLineCents(order);
    order.lines.forEach((line, i) => {
      const entry = products.get(line.productId) ?? { productId: line.productId, name: line.name, quantity: 0, totalCents: 0 };
      entry.quantity += line.quantity;
      entry.totalCents += charged[i]!;
      products.set(line.productId, entry);
    });
  }
  return [...products.values()].sort(
    (a, b) => b.quantity - a.quantity || b.totalCents - a.totalCents || a.name.localeCompare(b.name, 'es'),
  );
}

export function summarize(orders: ReportOrder[], top = 5): Summary {
  const summary: Summary = {
    orderCount: 0, salesCents: 0, taxCents: 0, averageCents: 0, cashCents: 0, digitalCents: 0,
    itemCount: 0, voidedCount: 0, voidedCents: 0, discountCount: 0, discountCents: 0, topProducts: [],
  };
  for (const order of orders) {
    if (order.status === 'voided') {
      summary.voidedCount += 1;
      summary.voidedCents += order.totalCents;
      continue;
    }
    summary.orderCount += 1;
    summary.salesCents += order.totalCents;
    summary.taxCents += order.taxCents;
    if (order.discountKind) {
      summary.discountCount += 1;
      summary.discountCents += order.discountCents;
    }
    for (const p of order.payments) {
      if (p.method === 'cash') summary.cashCents += p.amountCents;
      else summary.digitalCents += p.amountCents;
    }
    for (const line of order.lines) summary.itemCount += line.quantity;
  }
  if (summary.orderCount > 0) summary.averageCents = Math.round(summary.salesCents / summary.orderCount);
  summary.topProducts = productSales(orders).slice(0, top);
  return summary;
}

// ---------------------------------------------------------------- exports

const HEADERS = [
  'Tiquete', 'Fecha', 'Hora', 'Cajero', 'Estado', 'Descuento', 'Subtotal', 'Impuesto', 'Total',
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
    discountCents: o.discountCents,
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
      amount(r.discountCents), amount(r.subtotalCents), amount(r.taxCents), amount(r.totalCents),
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

// A spreadsheet holds amounts in whole currency units, not minor ones.
const money = (cents: number, style: 'money' | 'moneyBold' = 'money'): Cell => ({ value: cents / 100, style });

/** The rows every export starts with: business, what it is, which days, when it was made. */
function exportHeading(title: string, info: ExportInfo): Cell[][] {
  const exportedAt = info.exportedAt ?? new Date();
  const day = (iso: string) => iso.split('-').reverse().join('/');
  const { from, to } = info.range;
  return [
    [{ value: info.businessName, style: 'title' }],
    [{ value: title, style: 'bold' }],
    ['Fechas', from === to ? day(from) : `${day(from)} a ${day(to)}`],
    ['Exportado', `${day(localDate(exportedAt))} ${pad(exportedAt.getHours())}:${pad(exportedAt.getMinutes())}`],
    [],
  ];
}

/**
 * The same orders as an Excel file: who and what the export covers, the
 * figures of `summarize`, then every order in a table that can be filtered.
 */
export function ordersXlsx(orders: ReportOrder[], info: ExportInfo): Uint8Array {
  const summary = summarize(orders);
  const rows = orders.map(exportRow);
  const sheet: Cell[][] = [
    ...exportHeading(`Ventas · ${info.storeName}`, info),
    [{ value: 'Ventas', style: 'bold' }, money(summary.salesCents, 'moneyBold')],
    ['Pedidos', summary.orderCount],
    ['Efectivo', money(summary.cashCents)],
    ['Digital', money(summary.digitalCents)],
    ['Impuesto', money(summary.taxCents)],
    ['Pedidos con tarjeta', summary.discountCount],
    ['Descuento tarjetas', money(summary.discountCents)],
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
      money(r.discountCents), money(r.subtotalCents), money(r.taxCents), money(r.totalCents),
      money(r.cashCents), money(r.digitalCents),
      r.products, r.voidedByName, r.voidReason,
    ]);
  }
  const allCents = rows.flatMap((r) => [r.discountCents, r.subtotalCents, r.taxCents, r.totalCents, r.cashCents, r.digitalCents]);
  return xlsx({
    name: 'Pedidos',
    rows: sheet,
    widths: [20, 14, 8, 22, 13, 13, 13, 13, 13, 13, 13, 50, 20, 32],
    // A table needs at least one line under its headings.
    table: rows.length > 0 ? { name: 'TablaPedidos', headerRow } : undefined,
    moneyDecimals: allCents.some((cents) => cents % 100 !== 0),
  });
}

/**
 * Sales per product as an Excel file: the same heading as `ordersXlsx`, then
 * one row per product (units, money) in a table that can be filtered, and a
 * total that matches the sales figure.
 */
export function productsXlsx(orders: ReportOrder[], info: ExportInfo): Uint8Array {
  const products = productSales(orders);
  const summary = summarize(orders);
  const sheet: Cell[][] = [
    ...exportHeading(`Ventas por producto · ${info.storeName}`, info),
    [{ value: 'Ventas', style: 'bold' }, money(summary.salesCents, 'moneyBold')],
    ['Productos vendidos', summary.itemCount],
    ['Pedidos con tarjeta', summary.discountCount],
    ['Descuento tarjetas', money(summary.discountCents)],
    ['Las ventas de cada producto son lo cobrado: con el descuento de tarjeta e impuesto incluido. Los pedidos anulados no cuentan.'],
    [],
  ];
  const headerRow = sheet.length;
  sheet.push(['Producto', 'Unidades', 'Ventas']);
  for (const p of products) sheet.push([p.name, p.quantity, money(p.totalCents)]);
  if (products.length > 0) {
    // Below the table, not in it, so filtering the table leaves it alone.
    sheet.push([], [{ value: 'Total', style: 'bold' }, { value: summary.itemCount, style: 'bold' }, money(summary.salesCents, 'moneyBold')]);
  }
  return xlsx({
    name: 'Productos',
    rows: sheet,
    widths: [36, 12, 16],
    table: products.length > 0 ? { name: 'TablaProductos', headerRow, lastRow: headerRow + products.length } : undefined,
    moneyDecimals: products.some((p) => p.totalCents % 100 !== 0),
  });
}

/**
 * The cash a drawer should hold: what it was opened with, plus the cash owed
 * on its completed sales (the same "Efectivo" as `summarize`, so voided sales
 * add nothing), plus cash put in, minus cash taken out.
 */
export function expectedCashCents(
  openingCents: number,
  orders: ReportOrder[],
  movements: Pick<CashMovement, 'kind' | 'amountCents'>[],
): number {
  const moved = movements.reduce((sum, m) => sum + (m.kind === 'in' ? m.amountCents : -m.amountCents), 0);
  return openingCents + summarize(orders).cashCents + moved;
}
