# MPF Register

Billing system for a dessert store chain: a desktop register app for cashiers,
backed by one central Postgres. Registers keep working when the connection
drops and reconcile afterwards.

## Layout

| Path | What | Stack |
|---|---|---|
| `packages/shared` | Schemas, money, order and report arithmetic, password hashing. Used everywhere. | TypeScript, Valibot |
| `packages/brand` | Business name, logo, and the one stylesheet both apps use. | CSS |
| `apps/api` | The only thing that talks to Postgres. | Hono, postgres.js, plain SQL migrations |
| `apps/desktop` | The register. `src/lib` is the logic, `src/screens` the UI. | Svelte 5, Vite, Tauri 2 |
| `apps/desktop/src-tauri` | Thin Tauri shell: a few commands, no logic. | Rust |
| `apps/admin` | Web panel for remote administration, served by the API at `/panel/`. Online only. | Svelte 5, Vite |
| `crates/pos-native` | Local SQLite file and raw printer output. No Tauri dependency. | Rust, rusqlite |

Stack choices are settled: Svelte (not React), Valibot (not Zod), Postgres,
pnpm. Do not introduce an ORM, a second validation library or a UI framework.

## Commands

```sh
pnpm db:up          # dev Postgres in podman/docker, port 5433, container mpf-pos-db
pnpm db:seed        # migrate + demo store, 2 terminals, admin/admin123, cashier/1234
pnpm dev:api        # API on :8787 (needs apps/api/.env, see .env.example)
pnpm dev:desktop    # the register, in a Tauri window
pnpm dev:admin      # the admin panel on :5174, talking to the API on :8787
pnpm build:admin    # builds the panel; the API then serves it at /panel/
pnpm typecheck      # tsc + svelte-check
pnpm test           # all TS tests + pos-native; needs the dev Postgres running
```

Deployment is described in `docs/DEPLOY.md`; keep it true when a change alters
how the system is installed, configured or updated.

Node runs the API's TypeScript directly (type stripping), so there is no build
step for it. That is why enums, namespaces and constructor parameter
properties are banned (`erasableSyntaxOnly`) and relative imports end in `.ts`.

## Invariants

Break one of these and money or stock goes wrong. Each has a test; keep it so.

### Money
- Every amount is an integer in minor units, named `*Cents`. No floats, ever.
  Convert only at the edges with `parseCents` / `formatCents`.
- `computeTotals` and `orderProblems` in `packages/shared` are the only
  definition of an order's arithmetic. The register uses them to build an
  order and the API uses them to reject one that disagrees. Never re-derive
  totals anywhere else.
- Payments are `cash` or `digital`, any mix, and must add up to exactly the
  order total. Change is `tenderedCents - amountCents` on cash payments; it is
  never stored as its own payment.
- An order snapshots product name, unit price and tax rate at the time of
  sale. Later catalog edits never change past orders.

### Orders
- The register generates the order id (UUIDv7). That id is the idempotency
  key: `POST /orders` with an id the server already has changes nothing and
  answers `duplicate`. Retrying a submission must always be safe.
- Orders are never deleted or edited in place on the server. A mistake is
  corrected by voiding (admin only), which records who, when and why.
- Ticket numbers are `<terminal code>-<sequence>`, unique per terminal, never
  reused. The sequence lives on the register; each pull raises it to at least
  the server's last known value so a wiped PC cannot repeat a number.

### Stock
- Stock is per store; the catalog is shared by all stores.
- `stock.quantity` changes only inside a transaction that also writes a
  `stock_movements` row (`sale`, `void`, `adjustment`). Quantity must always
  equal opening stock plus the sum of its movements.
- Two stock policies, chosen by the register per submission:
  - `strict` (online sale): one conditional `UPDATE … WHERE quantity >= n`
    per product, in product-id order. Not enough stock rejects the whole
    order with 409 and leaves no trace. This is what stops two registers
    selling the same dessert.
  - `accept` (already sold offline): never rejected for stock. Quantity may
    go negative, and every unit sold beyond zero gets a `stock_conflicts` row
    for an admin to accept or void.
- Never use `accept` for a sale whose ticket has not been handed out yet, and
  never use `strict` for one that has.
- A void puts back exactly what that order's movements took, once.

### Offline and sync
- The register writes to its local SQLite first and treats the server as
  something that may not answer. Screens read local data only.
- Every multi-row local write goes through one `LocalDb.batch` call, which is
  one transaction. An order, its lines, its payments and the ticket counter
  are saved together or not at all.
- A sale is written locally before the request leaves, so a crash or lost
  response cannot lose it or reuse its ticket number.
- Local order states (`sync_status`):
  - `submitting`: strict request in flight, no ticket yet. If the server says
    no stock, the order is deleted and its number released.
  - `pending`: sold offline, ticket handed out. Pushed with `accept` until
    the server takes it.
  - `synced`: confirmed by the server.
  - `failed`: the server refused it for a reason retrying will not fix.
    Never dropped silently; an admin sees it and can retry.
- Network errors, 5xx and 401/403 are "try again later", never `failed`.
- Server-owned data (products, stock, users, store settings) only flows down:
  each pull replaces the local copy wholesale. The register never edits it
  locally; admin changes go to the API and come back through the next pull.
- Stock shown on a register = last pulled quantity minus its own orders the
  server has not confirmed. Do not store that number; derive it
  (`listProducts`).
- Sync rounds push the outbox in ticket order, then pull.

### Stores, terminals, people
- The API has two front doors, and each decides the store differently:
  - Register routes: a terminal token identifies one PC and, through it, one
    store. Queries are scoped by `c.var.terminal.storeId`.
  - Panel routes (`/manage`, `apps/api/src/manage.ts`): a person logs in, no
    terminal. The store comes from the URL and must pass `storeParam`, which
    checks the admin may act on it. An admin with `users.store_id` set is
    limited to that store; one without ("org admin") can act on all stores,
    create stores and manage every user.
  Never take a store id from a request body, and never query a store's data
  without going through one of these two. The shared queries live in
  `store-ops.ts` and receive the already-authorised store id.
- The panel login faces the internet: admin passwords are at least 8
  characters, a cashier promoted to admin must get a new password, and
  repeated failures lock the username for 15 minutes. Nobody can remove their
  own admin access.
- Only the hash of a terminal token is stored. Tokens are shown once.
- Admin routes and voids need an `X-Session` token from an online login, and
  re-check the user's role in the database on every request.
- Offline login checks the password against the hash cached by the last pull.
  It allows selling, not admin actions.

## Conventions

- Validation schemas live in `packages/shared/src/schemas.ts` and are the API
  contract. Change a request shape there, not in a route.
- SQL is snake_case, TypeScript camelCase; postgres.js converts
  (`postgres.camel`). In the register's SQLite, alias columns in the query.
- Server migrations are numbered files in `apps/api/migrations`, applied once
  each. Add a new file; never edit one that has run anywhere. Must run on
  Postgres 13+ (no `uuidv7()`). Local SQLite migrations are the `MIGRATIONS`
  array in `apps/desktop/src/lib/local-db.ts`, also append-only.
- `apps/desktop/src/lib` must not import Tauri or Svelte, except `tauri.ts`
  (the only bridge to Rust) and `state.svelte.ts` (the only shared UI state).
  That is what lets `test/e2e.test.ts` run real register logic against the
  real API with a cuttable fake network. New sync or checkout behaviour gets
  a case there.
- Svelte 5 runes only (`$state`, `$derived`, `$props`); no stores, no
  `export let`. Screens call functions from `state.svelte.ts`; they do not
  touch the database or the API client themselves.
- No `window.prompt/alert/confirm`: they are unreliable in webviews.
- Rust stays thin. Logic that can be TypeScript is TypeScript; anything in
  Rust that is not a Tauri command goes in `pos-native` with a test.
- Reports: `summarize` and `ordersCsv` in `packages/shared/src/report.ts`
  are the only place sales figures are computed, for the register, the panel
  and the CSV alike. Voided orders never count as sales. "Cash" in a report is the cash
  owed (`amountCents`), not the cash handed over. A day means a local
  calendar day on the register.
- The business name is `BUSINESS_NAME` in `packages/brand`, set in Titan One
  (class `brand-name`). The font is bundled, not fetched: the register must
  look the same offline.
- Tickets are plain text laid out to a column count (48 for 80 mm, 32 for
  58 mm) and sent as raw ESC/POS. No images, no driver-dependent layout.
- Everything a cashier or customer reads is Spanish (Colombia): screens,
  messages from `state.svelte.ts`, printed tickets. Text is written inline.
  Code, comments, identifiers, API error codes and docs stay English.
- Amounts are shown and typed the Colombian way (`$12.000`, decimals after a
  comma and hidden when zero). Only `formatCents` / `parseCents` know this.
- Both apps share `packages/brand/theme.css`. Colours come from the tokens at
  its top; no
  hard-coded colours in screens. The brand pink `#ee6fa0` is too light for
  white text: pair it with `--on-brand`, and use `--brand-strong` for pink
  text on light surfaces.

## Not built yet

- Accented characters on tickets. Windows printing (`pos-native/src/spooler.rs`,
  raw spooler job to the printer named in Setup) is written but has not been
  tried on the stores' Xprinter XP-58IIT yet.
- Editing an existing order (today: void and re-enter).
- Export of sales to the ERP.
- Stock movement history and transfers between stores in the panel.
- Live push of stock changes (registers poll every 5 s).
- Single-instance guard, installer signing, auto-update.
