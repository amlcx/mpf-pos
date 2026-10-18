import type {
  StoreCashSession,
  ManagedTerminal,
  ManagedUser,
  Product,
  ProductInput,
  ProductPatch,
  ReportOrder,
  StockChange,
  StockConflict,
  StoreInfo,
  StoreInput,
  StorePatch,
  TerminalInput,
  TerminalPatch,
  UserInput,
  UserPatch,
} from '@mpf/shared';

// Built, the panel is served by the API itself; in dev it runs on its own port.
const BASE: string = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:8787' : '');
const STORAGE_KEY = 'mpf-panel-session';

export class ApiError extends Error {
  status: number;
  /** The API's machine-readable error code, or 'network'. */
  code: string;
  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

// sessionStorage: the session ends when the tab is closed.
let session = sessionStorage.getItem(STORAGE_KEY);
let onExpired = () => {};

export const hasSession = () => session !== null;
export function setSession(token: string | null, expired?: () => void) {
  session = token;
  if (expired) onExpired = expired;
  if (token) sessionStorage.setItem(STORAGE_KEY, token);
  else sessionStorage.removeItem(STORAGE_KEY);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (session) headers['X-Session'] = session;
  let res: Response;
  try {
    res = await fetch(`${BASE}/manage${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const code = json?.error ?? `http_${res.status}`;
    if (res.status === 401 && code !== 'bad_credentials') onExpired();
    throw new ApiError(res.status, code);
  }
  return json as T;
}

const MESSAGES: Record<string, string> = {
  network: 'No hay conexión con el servidor.',
  bad_credentials: 'Usuario o contraseña incorrectos.',
  too_many_attempts: 'Demasiados intentos fallidos. Espera 15 minutos e intenta de nuevo.',
  admin_required: 'Solo los administradores pueden entrar aquí.',
  session_invalid: 'Tu sesión venció. Ingresa de nuevo.',
  session_required: 'Tu sesión venció. Ingresa de nuevo.',
  store_forbidden: 'No tienes acceso a esa tienda.',
  org_admin_required: 'Solo un administrador general puede hacer esto.',
  conflict: 'Ya existe un registro con ese código o nombre de usuario.',
  invalid_request: 'Revisa los datos: hay algún campo inválido.',
  admin_password_too_short: 'La contraseña de un administrador debe tener al menos 8 caracteres.',
  admin_password_required: 'Para volver administrador a un cajero, asígnale una contraseña nueva de al menos 8 caracteres.',
  cannot_change_own_access: 'No puedes quitarte tu propio acceso.',
  stock_would_be_negative: 'No se pueden retirar más unidades de las que hay.',
  product_tracks_stock: 'Este producto controla existencias; no se marca a mano.',
  not_found: 'Ese registro ya no existe.',
};

export function errorText(err: unknown): string {
  if (err instanceof ApiError) return MESSAGES[err.code] ?? `Error del servidor (${err.code}).`;
  return String(err);
}

/** Runs an action; returns an error message to show, or null when it worked. */
export async function attempt(action: () => Promise<unknown>): Promise<string | null> {
  try {
    await action();
    return null;
  } catch (err) {
    return errorText(err);
  }
}

const store = (id: string) => `/stores/${id}`;

export const api = {
  login: (username: string, password: string) =>
    request<{ token: string; user: ManagedUser }>('POST', '/login', { username, password }),
  me: () => request<{ user: ManagedUser }>('GET', '/me'),

  stores: () => request<{ stores: StoreInfo[] }>('GET', '/stores'),
  createStore: (input: StoreInput) => request<{ store: StoreInfo }>('POST', '/stores', input),
  patchStore: (id: string, patch: StorePatch) => request<{ store: StoreInfo }>('PATCH', store(id), patch),

  terminals: (storeId: string) => request<{ terminals: ManagedTerminal[] }>('GET', `${store(storeId)}/terminals`),
  createTerminal: (storeId: string, input: TerminalInput) =>
    request<{ terminal: ManagedTerminal; token: string }>('POST', `${store(storeId)}/terminals`, input),
  patchTerminal: (storeId: string, id: string, patch: TerminalPatch) =>
    request<{ terminal: ManagedTerminal }>('PATCH', `${store(storeId)}/terminals/${id}`, patch),
  rotateToken: (storeId: string, id: string) =>
    request<{ token: string }>('POST', `${store(storeId)}/terminals/${id}/token`),

  users: () => request<{ users: ManagedUser[] }>('GET', '/users'),
  createUser: (input: UserInput) => request<{ user: ManagedUser }>('POST', '/users', input),
  patchUser: (id: string, patch: UserPatch) => request<{ user: ManagedUser }>('PATCH', `/users/${id}`, patch),

  products: (storeId: string) => request<{ products: Product[] }>('GET', `${store(storeId)}/products`),
  createProduct: (input: ProductInput) => request<{ id: string }>('POST', '/products', input),
  patchProduct: (id: string, patch: ProductPatch) => request<{ id: string }>('PATCH', `/products/${id}`, patch),
  changeStock: (storeId: string, id: string, change: StockChange) =>
    request<{ product: Product }>('PUT', `${store(storeId)}/products/${id}/stock`, change),
  setSoldOut: (storeId: string, id: string, soldOut: boolean) =>
    request<{ product: Product }>('PUT', `${store(storeId)}/products/${id}/sold-out`, { soldOut }),

  cashSessions: (storeId: string, from: string, to: string) =>
    request<{ sessions: StoreCashSession[] }>('GET', `${store(storeId)}/cash-sessions?from=${from}&to=${to}`),
  orders: (storeId: string, from: string, to: string) =>
    request<{ orders: ReportOrder[] }>(
      'GET',
      `${store(storeId)}/orders?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  voidOrder: (storeId: string, id: string, reason: string) =>
    request<{ status: string }>('POST', `${store(storeId)}/orders/${id}/void`, { reason }),
  conflicts: (storeId: string) => request<{ conflicts: StockConflict[] }>('GET', `${store(storeId)}/conflicts`),
  resolveConflict: (storeId: string, id: string) =>
    request<{ status: string }>('POST', `${store(storeId)}/conflicts/${id}/resolve`, { resolution: 'accepted' }),
};
