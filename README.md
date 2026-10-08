# MPF Register

Desktop register for dessert stores, with a central Postgres and offline mode.
Project rules and invariants are in [CLAUDE.md](CLAUDE.md).

## First run

Needs Node 24+, pnpm, Rust, and podman or docker.

```sh
pnpm install
cp .env.example apps/api/.env
pnpm db:up && pnpm db:seed
pnpm dev:api            # terminal 1
pnpm dev:desktop        # terminal 2
```

In the app's setup screen use `http://localhost:8787` and the token
`mpf_dev_terminal_a` (a second register can use `mpf_dev_terminal_b`), then
log in as `admin` / `admin123` or `cashier` / `1234`.

On Linux, Tauri needs the WebKitGTK 4.1 development files. On openSUSE:

```sh
sudo zypper install webkitgtk3-devel libsoup-devel librsvg-devel
```

## Admin panel

A web app for managing stores, registers, users, products, stock and sales
from anywhere. Only admins can log in.

```sh
pnpm dev:admin          # http://localhost:5174/panel/ while developing
pnpm build:admin        # then the API serves it at http://localhost:8787/panel/
```

## Production

Point `DATABASE_URL` at the real database and set a long random
`SESSION_SECRET`; the API applies migrations on start. Run `pnpm build:admin`
before starting it so the panel is served at `/panel/`, and put the API behind
HTTPS: the panel sends passwords to it. Enrol each PC from the panel (Tienda y cajas), or with:

```sh
pnpm --filter @mpf/api terminal:create <store-code> <terminal-code>
```

## Tests

```sh
pnpm typecheck && pnpm test
```
