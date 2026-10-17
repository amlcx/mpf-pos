import * as v from 'valibot';
import { VERSION_PATTERN } from './version.ts';

export const PAYMENT_METHODS = ['cash', 'digital'] as const;
export const ROLES = ['admin', 'cashier'] as const;
export const STOCK_POLICIES = ['strict', 'accept'] as const;
export const DISCOUNT_KINDS = ['loyalty_card'] as const;
/** A new version reaches 'pilot' registers first, then 'stable' ones. */
export const RELEASE_RINGS = ['pilot', 'stable'] as const;

const Id = v.pipe(v.string(), v.uuid());
const Cents = v.pipe(v.number(), v.safeInteger(), v.minValue(0));
const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(1));
const Timestamp = v.pipe(v.string(), v.isoTimestamp());
const Name = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120));

// ---------------------------------------------------------------- catalog

export const ProductSchema = v.object({
  id: Id,
  name: Name,
  category: v.pipe(v.string(), v.trim(), v.maxLength(60)),
  priceCents: Cents,
  trackStock: v.boolean(),
  active: v.boolean(),
  /** Quantity on hand in the requesting terminal's store; null when untracked. */
  stockQty: v.nullable(v.pipe(v.number(), v.safeInteger())),
  /**
   * Marked by hand as unavailable in the requesting terminal's store. Only
   * untracked (made on demand) products can be; always false for tracked ones.
   */
  soldOut: v.boolean(),
});
export type Product = v.InferOutput<typeof ProductSchema>;

export const ProductInputSchema = v.object({
  name: Name,
  category: v.optional(v.pipe(v.string(), v.trim(), v.maxLength(60)), ''),
  priceCents: Cents,
  trackStock: v.optional(v.boolean(), true),
  active: v.optional(v.boolean(), true),
});
export type ProductInput = v.InferOutput<typeof ProductInputSchema>;

export const ProductPatchSchema = v.partial(
  v.object({
    name: Name,
    category: v.pipe(v.string(), v.trim(), v.maxLength(60)),
    priceCents: Cents,
    trackStock: v.boolean(),
    active: v.boolean(),
  }),
);
export type ProductPatch = v.InferOutput<typeof ProductPatchSchema>;

export const StockSetSchema = v.object({
  quantity: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
});

export const SoldOutSchema = v.object({ soldOut: v.boolean() });

// ----------------------------------------------------------------- orders

export const OrderLineSchema = v.object({
  id: Id,
  productId: Id,
  /** Product name at the time of sale. */
  name: Name,
  /** Unit price at the time of sale. */
  unitPriceCents: Cents,
  quantity: Count,
  lineTotalCents: Cents,
});
export type OrderLine = v.InferOutput<typeof OrderLineSchema>;

export const PaymentSchema = v.object({
  id: Id,
  method: v.picklist(PAYMENT_METHODS),
  /** Portion of the order total covered by this payment. */
  amountCents: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  /** Cash only: what the customer handed over. Change = tendered - amount. */
  tenderedCents: v.nullable(Cents),
});
export type Payment = v.InferOutput<typeof PaymentSchema>;
export type PaymentMethod = Payment['method'];

export const OrderSchema = v.object({
  /** Generated on the terminal (UUIDv7); the idempotency key for submission. */
  id: Id,
  cashierId: Id,
  ticketSeq: Count,
  ticketNumber: v.pipe(v.string(), v.minLength(1), v.maxLength(20)),
  /** Terminal clock at the time of sale. */
  createdAt: Timestamp,
  taxRateBps: v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(10_000)),
  taxIncluded: v.boolean(),
  /** Why this order was discounted, if it was. Registers older than discounts send neither field. */
  discountKind: v.optional(v.nullable(v.picklist(DISCOUNT_KINDS)), null),
  /** What came off the sum of the lines, before tax was worked out. */
  discountCents: v.optional(Cents, 0),
  subtotalCents: Cents,
  taxCents: Cents,
  totalCents: Cents,
  lines: v.pipe(v.array(OrderLineSchema), v.minLength(1), v.maxLength(200)),
  payments: v.pipe(v.array(PaymentSchema), v.maxLength(20)),
});
export type Order = v.InferOutput<typeof OrderSchema>;
export type DiscountKind = NonNullable<Order['discountKind']>;

export const SubmitOrderRequestSchema = v.object({
  order: OrderSchema,
  /**
   * strict: reject the order if any tracked product lacks stock (online sale).
   * accept: the sale already happened offline; record it and flag oversells.
   */
  stockPolicy: v.picklist(STOCK_POLICIES),
});
export type SubmitOrderRequest = v.InferOutput<typeof SubmitOrderRequestSchema>;
export type StockPolicy = SubmitOrderRequest['stockPolicy'];

export interface Oversell {
  productId: string;
  shortfall: number;
}
export interface SubmitOrderResponse {
  /** duplicate: this order id was already recorded; nothing changed. */
  status: 'accepted' | 'duplicate';
  oversold: Oversell[];
}
export interface InsufficientStockItem {
  productId: string;
  requested: number;
  available: number;
}
export interface InsufficientStockError {
  error: 'insufficient_stock';
  items: InsufficientStockItem[];
}

/** An order as reports see it: what was sold, plus what became of it. */
export interface ReportOrder extends Order {
  status: 'completed' | 'voided';
  cashierName: string | null;
  /** Who voided it and why. Only orders read from the server carry these. */
  voidedByName?: string | null;
  voidReason?: string | null;
}

/** Half-open interval of instants: from <= createdAt < to. */
export const ReportRangeSchema = v.object({ from: Timestamp, to: Timestamp });

export const VoidOrderSchema = v.object({
  reason: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(300)),
});

// ------------------------------------------------------------------- auth

export const LoginRequestSchema = v.object({
  username: v.pipe(v.string(), v.trim(), v.minLength(1)),
  password: v.pipe(v.string(), v.minLength(1)),
});

export interface User {
  id: string;
  username: string;
  name: string;
  role: (typeof ROLES)[number];
}
export type Role = User['role'];

export interface LoginResponse {
  token: string;
  user: User;
}

// ------------------------------------------------------------- management
// Shapes used by the web admin panel (/manage routes).

const Code = v.pipe(v.string(), v.trim(), v.toUpperCase(), v.regex(/^[A-Z0-9-]+$/));
const TaxRate = v.pipe(v.number(), v.safeInteger(), v.minValue(0), v.maxValue(10_000));
const CurrencySymbol = v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(4));
const Username = v.pipe(v.string(), v.trim(), v.toLowerCase(), v.regex(/^[a-z0-9._-]{2,40}$/));
const Password = v.pipe(v.string(), v.minLength(4), v.maxLength(200));
/** Admins can log in from the internet, so their passwords must be longer. */
export const ADMIN_PASSWORD_MIN = 8;

export const StoreInputSchema = v.object({
  code: v.pipe(Code, v.maxLength(12)),
  name: Name,
  currencySymbol: v.optional(CurrencySymbol, '$'),
  taxRateBps: v.optional(TaxRate, 0),
  taxIncluded: v.optional(v.boolean(), true),
});
export type StoreInput = v.InferInput<typeof StoreInputSchema>;
export const StorePatchSchema = v.partial(
  v.object({ name: Name, currencySymbol: CurrencySymbol, taxRateBps: TaxRate, taxIncluded: v.boolean() }),
);
export type StorePatch = v.InferOutput<typeof StorePatchSchema>;

export const TerminalInputSchema = v.object({
  /** Becomes the ticket number prefix, so keep it short. */
  code: v.pipe(Code, v.maxLength(4)),
  name: Name,
});
export type TerminalInput = v.InferOutput<typeof TerminalInputSchema>;
export const TerminalPatchSchema = v.partial(
  v.object({ name: Name, active: v.boolean(), releaseRing: v.picklist(RELEASE_RINGS) }),
);
export type TerminalPatch = v.InferOutput<typeof TerminalPatchSchema>;
export type ReleaseRing = (typeof RELEASE_RINGS)[number];
export interface ManagedTerminal {
  id: string;
  storeId: string;
  code: string;
  name: string;
  active: boolean;
  lastSeenAt: string | null;
  /** What the register last said it runs (X-App-Version); null until it does. */
  appVersion: string | null;
  releaseRing: ReleaseRing;
}

export const UserInputSchema = v.object({
  username: Username,
  name: Name,
  role: v.picklist(ROLES),
  /** null: may work at every store. */
  storeId: v.nullable(Id),
  password: Password,
});
export type UserInput = v.InferOutput<typeof UserInputSchema>;
export const UserPatchSchema = v.partial(
  v.object({
    name: Name,
    role: v.picklist(ROLES),
    storeId: v.nullable(Id),
    active: v.boolean(),
    password: Password,
  }),
);
export type UserPatch = v.InferOutput<typeof UserPatchSchema>;
export interface ManagedUser extends User {
  storeId: string | null;
  active: boolean;
}

/** Either the counted quantity, or how many units arrived (+) or left (-). */
export const StockChangeSchema = v.union([
  v.object({ quantity: v.pipe(v.number(), v.safeInteger(), v.minValue(0)) }),
  v.object({ delta: v.pipe(v.number(), v.safeInteger(), v.notValue(0)) }),
]);
export type StockChange = v.InferOutput<typeof StockChangeSchema>;

// ------------------------------------------------------------------- sync

export interface StoreInfo {
  id: string;
  code: string;
  name: string;
  currencySymbol: string;
  taxRateBps: number;
  taxIncluded: boolean;
}
export interface TerminalInfo {
  id: string;
  /** Ticket number prefix, unique within the store. */
  code: string;
  name: string;
  /** Highest ticket sequence the server has from this terminal (0 if none). */
  lastTicketSeq: number;
}

/** Full snapshot of everything a terminal needs to sell while offline. */
export interface PullResponse {
  serverTime: string;
  store: StoreInfo;
  terminal: TerminalInfo;
  products: Product[];
  /** Includes password hashes so cashiers can log in while offline. */
  users: (User & { passwordHash: string })[];
  /** Orders from this terminal that were voided on the server. */
  voidedOrderIds: string[];
}

export interface StockConflict {
  id: string;
  orderId: string;
  ticketNumber: string;
  productId: string;
  productName: string;
  shortfall: number;
  createdAt: string;
}

// --------------------------------------------------------------- releases
// Sent by scripts/offer-release.mjs from the release workflows; the shapes
// must stay in step with that script.

export const VersionSchema = v.pipe(v.string(), v.regex(VERSION_PATTERN));

/** Registers install only what this repository published as a release. */
export const RELEASE_URL_PREFIX = 'https://github.com/amlcx/mpf-pos/releases/download/';

export const ReleaseOfferSchema = v.object({
  version: VersionSchema,
  ring: v.picklist(RELEASE_RINGS),
  notes: v.optional(v.pipe(v.string(), v.maxLength(10_000)), ''),
  pubDate: v.optional(v.nullable(Timestamp), null),
  /** The installer on the GitHub Release for this version's tag. */
  url: v.pipe(v.string(), v.maxLength(500), v.startsWith(RELEASE_URL_PREFIX)),
  /** minisign signature of that file, checked by the register before installing. */
  signature: v.pipe(v.string(), v.minLength(1), v.maxLength(2000)),
});
export type ReleaseOffer = v.InferOutput<typeof ReleaseOfferSchema>;

/** Only one move exists: what the pilot ring runs becomes stable. */
export const ReleasePromoteSchema = v.object({
  version: VersionSchema,
  from: v.literal('pilot'),
  to: v.literal('stable'),
});

/** Answer to a register's update check, in the format Tauri's updater reads. */
export interface UpdateManifest {
  version: string;
  notes: string;
  pub_date?: string;
  url: string;
  signature: string;
}
