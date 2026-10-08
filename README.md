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

See [docs/DEPLOY.md](docs/DEPLOY.md): server setup, first administrator,
building the Windows installer, updates and backups.

## Tests

```sh
pnpm typecheck && pnpm test
```
