import type { ManagedUser, StoreInfo } from '@mpf/shared';
import { api, errorText, hasSession, setSession } from './api.ts';

/** Who is logged in and which store the screens are looking at. */
export const panel = $state({
  ready: false,
  user: null as ManagedUser | null,
  stores: [] as StoreInfo[],
  storeId: null as string | null,
  error: '',
});

export const currentStore = () => panel.stores.find((s) => s.id === panel.storeId) ?? null;
/** Admins without a store of their own manage the whole business. */
export const isOrgAdmin = () => panel.user !== null && panel.user.storeId === null;

export function signOut(message = '') {
  setSession(null);
  panel.user = null;
  panel.stores = [];
  panel.storeId = null;
  panel.error = message;
}

export async function reloadStores(select?: string): Promise<void> {
  panel.stores = (await api.stores()).stores;
  const wanted = select ?? panel.storeId;
  panel.storeId = panel.stores.some((s) => s.id === wanted) ? wanted! : (panel.stores[0]?.id ?? null);
}

async function enter(user: ManagedUser) {
  panel.user = user;
  await reloadStores();
}

export async function boot(): Promise<void> {
  setSession(sessionStorage.getItem('mpf-panel-session'), () => signOut('Tu sesión venció. Ingresa de nuevo.'));
  if (hasSession()) {
    try {
      await enter((await api.me()).user);
    } catch {
      setSession(null);
    }
  }
  panel.ready = true;
}

/** Returns an error message, or null when logged in. */
export async function signIn(username: string, password: string): Promise<string | null> {
  try {
    const { token, user } = await api.login(username, password);
    setSession(token);
    panel.error = '';
    await enter(user);
    return null;
  } catch (err) {
    return errorText(err);
  }
}
