import { BUSINESS_NAME } from '@mpf/brand';
import {
  type CartItem,
  type DateRange,
  type PaymentInput,
  type ProductInput,
  type ReportOrder,
  type StockConflict,
  ordersCsv,
  rangeBounds,
} from '@mpf/shared';
import { ApiClient, ApiError, NetworkError } from './api.ts';
import { type Session, login } from './auth.ts';
import { type CheckoutResult, checkout } from './checkout.ts';
import { migrateLocal } from './local-db.ts';
import {
  type Context,
  type LocalProduct,
  type TerminalConfig,
  applyPull,
  countBySyncStatus,
  listOrdersBetween,
  listProducts,
  loadConfig,
  loadContext,
  saveConfig,
} from './repo.ts';
import { retryFailed, syncOnce } from './sync.ts';
import { printRaw, saveExport, tauriDb as db } from './tauri.ts';
import { escpos, ticketRows, ticketText } from './ticket.ts';

const SYNC_INTERVAL_MS = 5000;

/** Everything the screens render. Screens call the functions below to change it. */
export const app = $state({
  ready: false,
  bootError: '',
  config: null as TerminalConfig | null,
  context: null as Context | null,
  session: null as Session | null,
  online: false,
  syncError: '',
  products: [] as LocalProduct[],
  counts: { submitting: 0, pending: 0, synced: 0, failed: 0 },
});

let api: ApiClient | null = null;
const deps = () => {
  if (!api) throw new Error('terminal is not set up');
  return { db, api };
};

export function errorText(err: unknown): string {
  if (err instanceof NetworkError) return 'No hay conexión con el servidor.';
  if (err instanceof ApiError) {
    const known: Record<string, string> = {
      terminal_token_invalid: 'El servidor no reconoce el token de esta caja.',
      session_required: 'Ingresa de nuevo con conexión para hacer esto.',
      session_invalid: 'Tu sesión venció. Ingresa de nuevo.',
      admin_required: 'Solo un administrador puede hacer esto.',
      product_tracks_stock: 'Este producto controla existencias; no se marca a mano.',
    };
    return known[err.message] ?? `Error del servidor: ${err.message}`;
  }
  return String(err);
}

async function attempt(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (err) {
    return errorText(err);
  }
}

export async function refresh(): Promise<void> {
  app.context = await loadContext(db);
  app.products = await listProducts(db);
  app.counts = await countBySyncStatus(db);
}

let syncing = false;
export async function syncNow(): Promise<void> {
  if (!api || syncing) return;
  syncing = true;
  try {
    app.online = (await syncOnce(deps())).online;
    app.syncError = '';
  } catch (err) {
    app.online = false;
    app.syncError = errorText(err);
  } finally {
    syncing = false;
    await refresh();
  }
}

export async function boot(): Promise<void> {
  try {
    await migrateLocal(db);
    app.config = await loadConfig(db);
    if (app.config) api = new ApiClient(app.config.apiUrl, app.config.terminalToken);
    await refresh();
  } catch (err) {
    app.bootError = String(err);
  }
  app.ready = true;
  void syncNow();
  setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
}

/** Saves this PC's settings. A new server or token is verified first. */
export async function saveSetup(config: TerminalConfig): Promise<string | null> {
  const sameServer =
    app.config?.apiUrl === config.apiUrl && app.config?.terminalToken === config.terminalToken;
  if (!sameServer) {
    if (app.counts.pending + app.counts.submitting + app.counts.failed > 0) {
      return 'Hay pedidos que aún no llegan al servidor. Sincronízalos antes de cambiar el servidor o el token.';
    }
    const candidate = new ApiClient(config.apiUrl, config.terminalToken);
    const error = await attempt(async () => applyPull(db, await candidate.pull()));
    if (error) return error;
    api = candidate;
    app.session = null;
    app.online = true;
  }
  await saveConfig(db, config);
  app.config = config;
  await refresh();
  return null;
}

export async function signIn(username: string, password: string): Promise<boolean> {
  app.session = await login(deps(), username, password);
  return app.session !== null;
}

export function signOut(): void {
  if (api) api.sessionToken = null;
  app.session = null;
}

// ------------------------------------------------------------------ selling

export async function sell(cart: CartItem[], payments: PaymentInput[]): Promise<CheckoutResult> {
  const result = await checkout(deps(), {
    cart,
    payments,
    cashierId: app.session!.user.id,
    online: app.online,
  });
  // If the server stopped answering mid-sale, stop waiting for it on the next one.
  if (result.ok && !result.synced) app.online = false;
  await refresh();
  return result;
}

function ticketFor(order: ReportOrder) {
  return ticketRows({
    businessName: BUSINESS_NAME,
    storeName: app.context?.store.name ?? '',
    cashierName: order.cashierName ?? '',
    order,
    columns: app.config?.paperColumns ?? 48,
  });
}

export function ticketPreview(order: ReportOrder): string {
  return ticketText(ticketFor(order), app.config?.paperColumns ?? 48);
}

/**
 * Returns an error message, or null when printed (or no printer is set).
 * `justSold` marks the ticket of a sale being paid right now, as opposed to a
 * copy: only that one opens the cash drawer, and only if cash changed hands.
 */
export async function printTicket(order: ReportOrder, justSold = false): Promise<string | null> {
  const config = app.config;
  if (!config?.printerTarget) return null;
  const openDrawer = justSold && config.cashDrawer && order.payments.some((p) => p.method === 'cash');
  const bytes = escpos(ticketFor(order), { cutter: config.cutter, openDrawer });
  return attempt(() => printRaw(config.printerTarget, bytes));
}

// ------------------------------------------------------------------ reports

/** This register's orders in a range of local days. Works offline. */
export function loadOrders(range: DateRange) {
  const { from, to } = rangeBounds(range);
  return listOrdersBetween(db, from, to);
}

/** Orders from every register of the store. Admin and online only. */
export async function loadStoreOrders(range: DateRange): Promise<ReportOrder[]> {
  const { from, to } = rangeBounds(range);
  return (await deps().api.storeOrders(from, to)).orders;
}

/** Saves the orders as CSV in the Downloads folder; returns a message to show. */
export async function exportOrders(orders: ReportOrder[], label: string, range: DateRange): Promise<string> {
  const days = range.from === range.to ? range.from : `${range.from}_${range.to}`;
  try {
    return `Guardado en ${await saveExport(`pedidos-${label}_${days}.csv`, ordersCsv(orders))}`;
  } catch (err) {
    return `No se pudo exportar: ${errorText(err)}`;
  }
}

// ------------------------------------------------------- voids and sold out
// Open to cashiers, but the server must know who is acting.

/** True when the server knows who is logged in, which an offline login cannot give. */
export const hasServerSession = () => !!app.session?.online && app.online;

export async function voidOrder(id: string, reason: string): Promise<string | null> {
  const error = await attempt(() => deps().api.voidOrder(id, reason));
  await syncNow();
  return error;
}

/** Marks a made-on-demand product as sold out in this store, or available again. */
export async function setSoldOut(id: string, soldOut: boolean): Promise<string | null> {
  if (!hasServerSession()) return 'Para marcar productos agotados se necesita conexión. Reconéctate e ingresa de nuevo.';
  const error = await attempt(() => deps().api.setSoldOut(id, soldOut));
  await syncNow();
  return error;
}

// -------------------------------------------------------------------- admin

export const canAdmin = () => app.session?.user.role === 'admin' && hasServerSession();

export async function saveProduct(
  id: string | null,
  input: ProductInput,
  stockQty: number | null,
): Promise<string | null> {
  const error = await attempt(async () => {
    const { api } = deps();
    const product = id ? await api.patchProduct(id, input) : await api.createProduct(input);
    if (stockQty !== null && input.trackStock && product.stockQty !== stockQty) {
      await api.setStock(product.id, stockQty);
    }
  });
  await syncNow();
  return error;
}

export async function loadConflicts(): Promise<StockConflict[]> {
  return (await deps().api.conflicts()).conflicts;
}

export const resolveConflict = (id: string) =>
  attempt(() => deps().api.resolveConflict(id, 'accepted'));

export async function retryFailedOrders(): Promise<void> {
  await retryFailed(db);
  await syncNow();
}
