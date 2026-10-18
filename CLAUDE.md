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
pnpm, Bits UI for interactive components (dialogs, toggles, pagination…).
Do not introduce an ORM, a second validation library or another UI library.

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
- An order may carry one discount, identified by `discountKind`. Its amount
  is never free: `discountCentsFor` derives it from the kind (`loyalty_card`
  is half the sum of the lines) and the API rejects any other figure. Lines
  keep their full prices; the discount comes off before tax is worked out.
  Reports count discounted orders at what was charged and total the
  discounts apart.

### Orders
- The register generates the order id (UUIDv7). That id is the idempotency
  key: `POST /orders` with an id the server already has changes nothing and
  answers `duplicate`. Retrying a submission must always be safe.
- Orders are never deleted or edited in place on the server. A mistake is
  corrected by voiding, which records who, when and why. Cashiers may void
  from a register; the reason is mandatory.
- A wrong payment method is fixed the same way: "Anular y cambiar método de
  pago" voids the sale, then charges the same items again as a new sale with
  a new ticket. `cartFromOrder` keeps the voided sale's names and prices, so
  catalog edits made since then do not change what the customer pays.
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
- Products made on demand (`track_stock = false`) have no quantity. Staff mark
  them sold out by hand, per store (`sold_out` table, who and when). A `strict`
  order containing one is rejected like any other shortage (409, available 0);
  an `accept` order never is. The flag is ignored for tracked products.

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
- Voids, sold-out marks and admin routes need an `X-Session` token from an
  online login. Every request re-reads the user: active, allowed at the
  terminal's store and, for admin routes, still an admin.
- Offline login checks the password against the hash cached by the last pull.
  It allows selling only: no voids, sold-out marks or admin actions.

### Releases
- A tag `vX.Y.Z` builds one release: the API image and the register
  installer. Rollout is server first, then the `pilot` ring, then `stable`
  (`docs/DEPLOY.md`, section 6). Each terminal is in one ring
  (`terminals.release_ring`), set from the panel.
- `/releases` (`apps/api/src/releases.ts`) is a third front door, used only by
  the release workflows through `scripts/offer-release.mjs`. Its token is
  checked against `RELEASE_DEPLOY_TOKEN_SHA256` in constant time; only the
  hash is configured. It touches no store data. A test runs the real script
  against the API, so the two cannot drift apart.
- An offered installer URL must already be in normal form and sit under
  `RELEASE_URL_PREFIX` and that version's tag. Promoting copies `pilot` to
  `stable` and is refused unless `pilot` is on exactly that version.
- `/updates/...` offers a register its ring's release only when it is a higher
  X.Y.Z than what it runs: registers never downgrade, so a bad release is
  fixed by releasing the next patch version.
- Registers send `X-App-Version`; the terminal middleware stores it only when
  it changed.
- Install updates only outside a checkout. On Windows installing closes the
  app, so `Updates.install` (`apps/desktop/src/lib/updates.ts`) refuses while
  a sale is open (cart or payment, `app.saleOpen`) or being saved
  (`checkoutInProgress`). Before anyone logs in it installs at once. Checking
  and downloading never throw and never hold anything a sale needs.
- The terminal token goes only to our server. Installers come from GitHub and
  are checked against the updater public key in `tauri.conf.json`; the
  private key lives only in GitHub secrets and offline.

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
- No `window.prompt/alert/confirm`: they are unreliable in webviews. Ask
  with a Bits UI `AlertDialog` instead.
- Bits UI is headless: style its parts with classes from `theme.css`, which
  also styles its states (`data-state="on"`, `data-selected`) like `.active`.
  The register is moving to it screen by screen; follow `Orders.svelte`.
- Rust stays thin. Logic that can be TypeScript is TypeScript; anything in
  Rust that is not a Tauri command goes in `pos-native` with a test.
  `check_update` is the one command that is not a plain wrapper: the update
  endpoint is the server chosen in Setup, and the updater plugin's JS
  `check()` cannot take an endpoint, only Rust can. It also clears the
  request headers on the update it finds, so the download from GitHub never
  carries the terminal token. Download and install stay the plugin's.
- Reports: `summarize`, `ordersCsv` and `ordersXlsx` in
  `packages/shared/src/report.ts` are the only place sales figures are
  computed, for the register, the panel and the exports alike (CSV from the
  register, Excel from the panel; `xlsx.ts` is our own minimal writer, so no
  spreadsheet library). Voided orders never count as sales. "Cash" in a report is the cash
  owed (`amountCents`), not the cash handed over. A day means a local
  calendar day on the register.
- The business name is `BUSINESS_NAME` in `packages/brand`, set in Titan One
  (class `brand-name`). The company style guide's fonts: Nunito for text,
  Titan One for the name and headings, Patrick Hand only for small friendly
  touches (class `hand`: empty states, hints). Fonts are bundled, not
  fetched: the register must look the same offline.
- Tickets are plain text laid out to a column count (48 for 80 mm, 32 for
  58 mm) and sent as raw ESC/POS. No images, no driver-dependent layout.
- Everything a cashier or customer reads is Spanish (Colombia): screens,
  messages from `state.svelte.ts`, printed tickets. Text is written inline.
  Code, comments, identifiers, API error codes and docs stay English.
- Amounts are shown and typed the Colombian way (`$12.000`, decimals after a
  comma and hidden when zero). Only `formatCents` / `parseCents` know this.
- Both apps share `packages/brand/theme.css`. Colours come from the tokens at
  its top, which follow the style guide's palette; no hard-coded colours in
  screens. Text stays at 4.5:1 contrast or better. The guide's pink and red
  are too light for that, so they are fills and borders only: on pink use
  `--on-brand` (never white), pink text is `--brand-strong`, red text `--bad`.

## Not built yet

- Accented characters on tickets. Windows printing (`pos-native/src/spooler.rs`,
  raw spooler job to the printer named in Setup) is written but has not been
  tried on the stores' Xprinter XP-58IIT yet.
- Editing an existing order (today: void and re-enter; for the payment
  method alone, "Anular y cambiar método de pago" does both in one step).
- Export of sales to the ERP.
- Stock movement history and transfers between stores in the panel.
- Live push of stock changes (registers poll every 5 s).
- Single-instance guard, Windows code signing of the installer (updates are
  signed with the updater key; the installer itself is not).
