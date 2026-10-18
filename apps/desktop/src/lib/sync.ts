import type { InsufficientStockItem } from '@mpf/shared';
import { type ApiClient, ApiError, NetworkError } from './api.ts';
import { type LocalDrawer, listDirtyDrawers, markDrawerFailed, markDrawerSynced } from './cash.ts';
import type { LocalDb } from './local-db.ts';
import { type LocalOrder, applyPull, deleteSubmittingOrder, listOutbox, markSynced } from './repo.ts';

export interface SyncDeps {
  db: LocalDb;
  api: ApiClient;
}

export type PushOutcome =
  | { kind: 'synced' }
  /** Strict submission refused for lack of stock; the local order is gone. */
  | { kind: 'rejected'; items: InsufficientStockItem[] }
  /** Permanently refused; marked 'failed' for an admin to look at. */
  | { kind: 'failed'; error: string }
  /** Could not reach the server (or it is unwell); left as it was. */
  | { kind: 'unreachable' };

/**
 * Submits one unconfirmed order. A 'submitting' order has no ticket yet, so
 * it goes in strict and may be rejected; a 'pending' one was already sold
 * offline, so the server must accept it and flag any oversell.
 */
export async function pushOrder({ db, api }: SyncDeps, order: LocalOrder): Promise<PushOutcome> {
  const policy = order.syncStatus === 'submitting' ? 'strict' : 'accept';
  try {
    const res = await api.submitOrder(order, policy);
    await db.batch(
      markSynced(order.id, { oversold: res.oversold.length > 0, adjustStock: res.status === 'accepted' }),
    );
    return { kind: 'synced' };
  } catch (err) {
    if (err instanceof NetworkError) return { kind: 'unreachable' };
    if (!(err instanceof ApiError)) throw err;
    if (err.transient) return { kind: 'unreachable' };
    if (policy === 'strict' && err.body?.error === 'insufficient_stock') {
      await db.batch(deleteSubmittingOrder(order));
      return { kind: 'rejected', items: err.body.items };
    }
    const error = JSON.stringify(err.body ?? err.message);
    await db.batch([
      { sql: "update orders set sync_status = 'failed', sync_error = ? where id = ?", params: [error, order.id] },
    ]);
    return { kind: 'failed', error };
  }
}

/** Refreshes server-owned data. Returns false when the server is unreachable. */
export async function pull({ db, api }: SyncDeps): Promise<boolean> {
  try {
    await applyPull(db, await api.pull());
    return true;
  } catch (err) {
    if (err instanceof NetworkError || (err instanceof ApiError && err.status >= 500)) return false;
    throw err;
  }
}

/** Sends a drawer, whole, as it is now. Same error rules as orders. */
export async function pushDrawer(
  { db, api }: SyncDeps,
  drawer: LocalDrawer & { version: number },
): Promise<'synced' | 'failed' | 'unreachable'> {
  const { syncError: _e, dirty: _d, version, ...session } = drawer;
  try {
    await api.saveCashSession(session);
    await db.batch([markDrawerSynced(drawer.id, version)]);
    return 'synced';
  } catch (err) {
    if (err instanceof NetworkError || (err instanceof ApiError && err.transient)) return 'unreachable';
    if (!(err instanceof ApiError)) throw err;
    await db.batch([markDrawerFailed(drawer.id, JSON.stringify(err.body ?? err.message))]);
    return 'failed';
  }
}

/**
 * One sync round: push changed drawers, then the outbox in ticket order, then
 * pull. Drawers go first so the server has them when their sales arrive, and
 * pushing before pulling means the snapshot already reflects our own sales.
 */
export async function syncOnce(deps: SyncDeps): Promise<{ online: boolean }> {
  let reachable = true;
  for (const drawer of await listDirtyDrawers(deps.db)) {
    if ((await pushDrawer(deps, drawer)) === 'unreachable') {
      reachable = false;
      break;
    }
  }
  if (reachable) {
    for (const order of await listOutbox(deps.db)) {
      const outcome = await pushOrder(deps, order);
      if (outcome.kind === 'unreachable') break;
    }
  }
  return { online: await pull(deps) };
}

/** Puts 'failed' orders and drawers back in line, e.g. after an admin fixed the cause. */
export const retryFailed = (db: LocalDb) =>
  db.batch([
    { sql: "update orders set sync_status = 'pending', sync_error = null where sync_status = 'failed'" },
    { sql: 'update cash_sessions set sync_error = null where sync_error is not null' },
  ]);
