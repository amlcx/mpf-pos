import type {
  LoginResponse,
  Order,
  Product,
  ProductInput,
  ProductPatch,
  PullResponse,
  ReportOrder,
  StockConflict,
  StockPolicy,
  SubmitOrderResponse,
} from '@mpf/shared';

/** The server could not be reached, or did not answer in time. */
export class NetworkError extends Error {}

/** The server answered with an error status. */
export class ApiError extends Error {
  status: number;
  body: any;
  constructor(status: number, body: any) {
    super(body?.error ?? `HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
  /** Worth retrying later without changing the request. */
  get transient(): boolean {
    return this.status >= 500 || this.status === 401 || this.status === 403;
  }
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 8000;

export class ApiClient {
  /** Set after an online login; required by admin calls. */
  sessionToken: string | null = null;
  #baseUrl: string;
  #terminalToken: string;
  #fetch: FetchLike;

  constructor(baseUrl: string, terminalToken: string, fetchImpl: FetchLike = (u, i) => fetch(u, i)) {
    this.#baseUrl = baseUrl.replace(/\/+$/, '');
    this.#terminalToken = terminalToken;
    this.#fetch = fetchImpl;
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { Authorization: `Bearer ${this.#terminalToken}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.sessionToken) headers['X-Session'] = this.sessionToken;
    let res: Response;
    try {
      res = await this.#fetch(this.#baseUrl + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      throw new NetworkError(String(err));
    }
    const json = await res.json().catch(() => null);
    if (!res.ok) throw new ApiError(res.status, json);
    return json as T;
  }

  pull = () => this.request<PullResponse>('GET', '/sync/pull');
  login = (username: string, password: string) =>
    this.request<LoginResponse>('POST', '/auth/login', { username, password });
  submitOrder = (order: Order, stockPolicy: StockPolicy) =>
    this.request<SubmitOrderResponse>('POST', '/orders', { order, stockPolicy });
  voidOrder = (id: string, reason: string) =>
    this.request<{ status: string }>('POST', `/orders/${id}/void`, { reason });
  createProduct = (input: ProductInput) => this.request<Product>('POST', '/admin/products', input);
  patchProduct = (id: string, patch: ProductPatch) =>
    this.request<Product>('PATCH', `/admin/products/${id}`, patch);
  setStock = (id: string, quantity: number) =>
    this.request<Product>('PUT', `/admin/products/${id}/stock`, { quantity });
  storeOrders = (from: string, to: string) =>
    this.request<{ orders: ReportOrder[] }>(
      'GET',
      `/admin/orders?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    );
  conflicts = () => this.request<{ conflicts: StockConflict[] }>('GET', '/admin/conflicts');
  resolveConflict = (id: string, resolution: string) =>
    this.request<{ status: string }>('POST', `/admin/conflicts/${id}/resolve`, { resolution });
}
