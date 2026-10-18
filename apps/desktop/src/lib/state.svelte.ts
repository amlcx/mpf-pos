import { BUSINESS_NAME } from '@mpf/brand';
import {
  type CartItem,
  type CashCount,
  type CashMovement,
  type DateRange,
  type DiscountKind,
  type PaymentInput,
  type ProductInput,
  type ReportOrder,
  type StockConflict,
  ordersCsv,
  rangeBounds,
} from '@mpf/shared';
import { ApiClient, ApiError, NetworkError } from './api.ts';
import { type Session, login } from './auth.ts';
import { type CloseResult, type DrawerStatus, closeDrawer, drawerStatus, moveCash, openDrawer } from './cash.ts';
import { type CheckoutResult, cartFromOrder, checkout, checkoutInProgress } from './checkout.ts';
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
import { appVersion, printRaw, saveExport, tauriDb as db, tauriUpdater } from './tauri.ts';
import { escpos, ticketRows, ticketText } from './ticket.ts';
import { type UpdateState, Updates } from './updates.ts';

const SYNC_INTERVAL_MS = 5000;
const UPDATE_INTERVAL_MS = 60 * 60 * 1000;

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
  /** A cart has items or the payment dialog is open (set by the sale screen). */
  saleOpen: false,
  update: { status: 'idle' } as UpdateState,
  /** A voided sale to charge again, waiting for the sale screen to pick it up. */
  resale: null as Resale | null,
  /**
   * Sales totals on screen, or masked. The screen faces the shop window, so
   * they start hidden and hide again whenever someone signs out.
   */
  showAmounts: false,
  /** This register's drawer: open for today, left open from an earlier day, or closed. */
  drawer: { state: 'closed' } as DrawerStatus,
  /** Names of the people this register knows, by id (for who opened or moved cash). */
  people: {} as Record<string, string>,
});

export interface Resale {
  /** Ticket of the voided sale, to tell the cashier what this cart is. */
  ticketNumber: string;
  cart: CartItem[];
  discountKind: DiscountKind | null;
}

let api: ApiClient | null = null;
/** This build's version, sent to the server on every request. */
let version: string | null = null;
const client = (config: TerminalConfig) => new ApiClient(config.apiUrl, config.terminalToken, undefined, version);
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
  app.drawer = await drawerStatus(db);
  const people = await db.select<{ id: string; name: string }>('select id, name from users');
  app.people = Object.fromEntries(people.map((p) => [p.id, p.name]));
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
    version = await appVersion().catch(() => null);
    app.config = await loadConfig(db);
    if (app.config) api = client(app.config);
    await refresh();
  } catch (err) {
    app.bootError = String(err);
  }
  app.ready = true;
  void syncNow();
  setInterval(() => void syncNow(), SYNC_INTERVAL_MS);
  void updates.check();
  setInterval(() => void updates.check(), UPDATE_INTERVAL_MS);
}

/** Saves this PC's settings. A new server or token is verified first. */
export async function saveSetup(config: TerminalConfig): Promise<string | null> {
  const sameServer =
    app.config?.apiUrl === config.apiUrl && app.config?.terminalToken === config.terminalToken;
  if (!sameServer) {
    if (app.counts.pending + app.counts.submitting + app.counts.failed > 0) {
      return 'Hay pedidos que aún no llegan al servidor. Sincronízalos antes de cambiar el servidor o el token.';
    }
    const candidate = client(config);
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
  app.showAmounts = false;
}

// ------------------------------------------------------------------ selling

export async function sell(
  cart: CartItem[],
  payments: PaymentInput[],
  discountKind: DiscountKind | null = null,
): Promise<CheckoutResult> {
  const result = await checkout(deps(), {
    cart,
    payments,
    discountKind,
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

/**
 * Voids a sale and puts the same items, at the same prices, back in the cart
 * so it can be charged again, typically with another payment method. The
 * charge is a new sale with a new ticket; the void keeps its own reason.
 */
export async function voidAndResell(order: ReportOrder, reason: string): Promise<string | null> {
  const error = await voidOrder(order.id, reason);
  if (error) return error;
  app.resale = { ticketNumber: order.ticketNumber, cart: cartFromOrder(order), discountKind: order.discountKind ?? null };
  return null;
}

/** Hands the waiting resale to the sale screen, once. */
export function takeResale(): Resale | null {
  const resale = app.resale;
  app.resale = null;
  return resale;
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

// ------------------------------------------------------------------ updates

const updates = new Updates({
  updater: tauriUpdater,
  server: () => app.config,
  busy: () => app.saleOpen || checkoutInProgress(),
  onChange(state) {
    app.update = state;
    // Downloaded before anyone logged in, typically right after opening the
    // app: nobody can be selling, so install straight away.
    if (state.status === 'ready' && !app.session) void installUpdate();
  },
});

export function setSaleOpen(open: boolean): void {
  app.saleOpen = open;
}

/** Installs a downloaded update; returns a message when it cannot. The app restarts. */
export async function installUpdate(): Promise<string | null> {
  try {
    const result = await updates.install();
    return result === 'busy' ? 'Termina la venta en curso antes de actualizar.' : null;
  } catch (err) {
    return `No se pudo instalar la actualización: ${errorText(err)}`;
  }
}

// -------------------------------------------------------------- cash drawer
// Opening, moving and closing work offline, like selling: the drawer is saved
// here and sent with the next sync.

const me = () => app.session!.user.id;

export async function openCashDrawer(count: CashCount): Promise<string | null> {
  const result = await openDrawer(db, { count, userId: me() });
  await refresh();
  void syncNow();
  return result.ok ? null : 'Ya hay una caja abierta.';
}

export async function moveDrawerCash(kind: CashMovement['kind'], amountCents: number, reason: string): Promise<string | null> {
  const result = await moveCash(db, { kind, amountCents, reason, userId: me() });
  await refresh();
  void syncNow();
  if (result.ok) return null;
  return result.reason === 'invalid' ? 'Escribe un valor mayor que cero y el motivo.' : 'La caja no está abierta.';
}

/** The first call with a count that does not match only reports the difference. */
export async function closeCashDrawer(count: CashCount, note = ''): Promise<CloseResult> {
  const result = await closeDrawer(db, { count, userId: me(), note });
  await refresh();
  if (result.ok) void syncNow();
  return result;
}
