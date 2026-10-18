# Deploying

What runs where:

```
cashier PCs (Windows) ──┐
                        ├── HTTPS ──> one server: API + admin panel ──> Postgres
admins (any browser) ───┘
```

- **One server process** serves both the API and the admin panel (`/panel/`).
- **Registers** are installed on each cashier PC and talk to that server.
- **Postgres** is the database you already have; only the server talks to it.

The server runs on **Dokploy**, built from the `Dockerfile` at the root of this
repository. `caja.example.com` stands for the domain you will give it.

## 1. The code on GitHub

The code lives at <https://github.com/amlcx/mpf-pos> (public). To work on it:

```sh
git clone git@github.com:amlcx/mpf-pos.git
```

Changes reach `main` through pull requests.

## 2. Deploy the server on Dokploy

Menu names below may differ slightly between Dokploy versions.

### Create the application

1. In Dokploy, open (or create) a project and add a service of type
   **Application**.
2. **Provider**: choose GitHub and pick `amlcx/mpf-pos` and the `main`
   branch. If your GitHub account is not connected yet, connect it under
   Dokploy's Git settings first (it installs a GitHub App). Since the
   repository is public, the plain "Git" provider with
   `https://github.com/amlcx/mpf-pos.git` also works, with no credentials.
3. **Build type**: Dockerfile. Dockerfile path `Dockerfile`, build context `.`
   (the repository root).

No Compose file is needed: the server is a single container and the database
already exists.

Building from `main` is how the server starts. Once the first release exists
(section 6), switch the application's provider to **Docker**, image
`ghcr.io/amlcx/mpf-pos-api:stable` (see `CI-SETUP.md`), so that a deploy runs
exactly the released version and `/health` reports it.

### Environment

In the application's **Environment** tab:

```sh
DATABASE_URL=postgres://USER:PASSWORD@HOST:5432/DATABASE
SESSION_SECRET=<output of: openssl rand -hex 32>
RELEASE_DEPLOY_TOKEN_SHA256=<SHA-256 of the release token, see section 6>
```

- The database must be Postgres 13 or newer, and `USER` must be allowed to
  create tables in it. The server creates and updates its own tables on start.
- If the database is also a Dokploy service, use its **internal** connection
  URL, so traffic stays inside Docker's network.
- If the database requires TLS, add `?sslmode=require` to the URL.
- `SESSION_SECRET` signs logins. Changing it later logs everyone out.
- The container listens on port `8787` (set `PORT` only to change that).
- `RELEASE_DEPLOY_TOKEN_SHA256` lets the release workflows tell the server
  which register version to offer. Without it, nobody can publish a release;
  everything else works.
- `APP_VERSION` is set inside images built by a release; do not set it here.

### Domain and HTTPS

Point a DNS `A` record for `caja.example.com` at the Dokploy server. Then, in
the application's **Domains** tab, add:

- Host: `caja.example.com`
- Container port: `8787`
- HTTPS on, certificate from Let's Encrypt

Passwords and tokens travel to this server, so use it only over HTTPS. Do not
also publish port 8787 directly; the domain is the only way in.

### Deploy and check

Press **Deploy**. The first build takes a few minutes. In the logs you should
see `Applied migrations: 001_init.sql` and `mpf api listening`. Then, from
your own computer:

- `https://caja.example.com/health` answers `{"ok":true,"version":"…"}`: the release
  the image was built from, or `dev` for a plain build
- `https://caja.example.com/panel/` shows the login

Keep it at **one replica**. The login lockout is kept in memory, so several
copies would each count failed attempts separately.

### Create the first administrator

Open a terminal in the running container (Dokploy has a terminal button for
the application's container) and run:

```sh
node src/scripts/create-admin.ts <username> "<Full Name>"
```

It asks for a password (at least 8 characters) without showing it. This
account can manage every store; everything else is created from the panel.

From SSH on the Dokploy host the same thing is
`docker exec -it <container> node src/scripts/create-admin.ts <username> "<Full Name>"`.

Never run the seed script on the real database: it creates demo data with
publicly known passwords and tokens.

If you ever lose every admin password, run the same command with
`--reset-password` after the username.

## 3. Set up the business in the panel

Log in at `https://caja.example.com/panel/` with the administrator you
created.

1. **Tienda y cajas**: create the store (code, name, tax). Then add one
   register per cashier PC. Each one shows a token **once**: copy it, you need
   it in step 5.
2. **Usuarios**: create the cashiers (assigned to their store) and any other
   admins.
3. **Productos e inventario**: create the products and set their stock.

## 4. Build the register installer

The installer has to be built **on Windows**. Any Windows 10 or 11 PC works,
including one of the cashier PCs; it is only needed when you release a new
version.

One-time setup on that PC:

1. [Microsoft C++ Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/),
   selecting "Desktop development with C++".
2. [Rust](https://rustup.rs) (accept the defaults).
3. [Node 24](https://nodejs.org), then `npm install -g pnpm@11`.
4. [Git](https://git-scm.com/download/win).

Then, in a terminal:

```sh
git clone https://github.com/amlcx/mpf-pos.git
cd mpf-pos
pnpm install --frozen-lockfile
pnpm --filter @mpf/desktop tauri build --config "{\"bundle\":{\"createUpdaterArtifacts\":false}}"
```

Releases are normally built by GitHub Actions (section 6), which also signs
the update. A build by hand like this one skips the updater signature (it
would need the private key, which stays in GitHub secrets); it installs fine,
and registers running it still update themselves to later releases.

The first build takes several minutes. The installer appears in
`target\release\bundle\nsis\` as `Mi Postre Favorito_<version>_x64-setup.exe`.

This build has only been run on Linux so far (where it produces an `.rpm` in
`target/release/bundle/rpm/`). The steps above are Tauri's standard Windows
ones, but the first Windows build may surface something to fix.

### Can it be built from Linux instead?

Not reliably. Tauri can cross-compile a Windows installer from Linux, but
calls it experimental and a last resort. It needs extra tools (`cargo-xwin`,
NSIS, `lld`, `llvm-rc`), downloads Microsoft's SDK under their licence, and
this project also compiles SQLite from C for the target. None of that has been
tried here, and openSUSE does not ship NSIS in its default repositories.
Building on a Windows PC is the dependable route. The details are in
[Tauri's Windows installer guide](https://tauri.app/distribute/windows-installer/)
under "Experimental: Build Windows apps on Linux and macOS".

## 5. Install on each cashier PC

1. Copy the `...-setup.exe` to the PC and run it. Windows will warn that the
   publisher is unknown, because the installer is not code-signed: choose
   **More info → Run anyway**.
2. Open **Mi Postre Favorito**. On the setup screen enter:
   - **Dirección del servidor**: `https://caja.example.com`
   - **Token de la caja**: the token of this PC's register from step 3
   - **Impresora** and **Ancho del papel**: see the note below
3. Log in with a cashier account and make a test sale. Check it appears in the
   panel under **Ventas**, then void it there.

Each register must have its **own** token. Two PCs sharing one would issue the
same ticket numbers.

### Printer settings

The stores use the Xprinter XP-58IIT: 58 mm paper, no auto-cutter, cash
drawer plugged into the printer. For that model:

- **Impresora**: on Windows, the printer's name exactly as it appears under
  **Impresoras y escáneres** (install the printer's driver first, or add it
  with Windows' own "Generic / Text Only" driver). On Linux, the printer's
  device, for example `/dev/usb/lp0`. Empty means no printer: sales work and
  the ticket can be seen on screen under **Pedidos**.
- **Ancho del papel**: 58 mm.
- **La impresora corta el papel sola**: off. The ticket is then fed far
  enough to tear by hand.
- **Abrir el cajón al cobrar en efectivo**: on. The drawer opens when a sale
  with a cash payment is printed, not on copies or reprints.

The register sends raw ESC/POS data, on Windows through the print spooler.
The Windows path has been compiled but **not yet tried on a real printer**:
make a cash test sale on the first PC and check the ticket prints, tears
cleanly below the last line, and the drawer opens.

## 6. Updating

Everything ships as a **release**: a git tag `vX.Y.Z` builds the server image
and the register installer from the same commit. The one-time GitHub and
Dokploy setup (secrets, signing key, image) is in `CI-SETUP.md`.

### Release rings

Each register is in a ring, chosen in the panel under **Tienda y cajas**
(column "Actualizaciones"):

- **Piloto**: gets each new version first. Pick one register in one store.
- **Estable** (the default): gets it once it has been promoted.

The server keeps one offered release per ring. A register asks
`/updates/...` with its own version and is answered with the ring's release
only when that is newer; the installer itself is downloaded from the GitHub
Release, and the register checks its signature before installing. The panel
shows the version each register last reported.

### Releasing a version

1. Merge into `main` what the release should contain (CI must pass).
2. `git tag vX.Y.Z && git push origin vX.Y.Z`. The **release** workflow runs
   the checks again, pushes `ghcr.io/amlcx/mpf-pos-api:X.Y.Z` (for amd64 and
   arm64; the server is arm64) and creates the
   GitHub Release with the signed installer and `latest.json`. Nothing is
   deployed yet.
3. GitHub → Actions → **deploy** → Run workflow → `X.Y.Z`. It moves the image
   tag `stable` to this version, asks Dokploy to redeploy, waits until
   `/health` reports `X.Y.Z`, then offers the release to the **pilot** ring.
   The server always goes first: it must accept what every installed register
   sends.
4. After a day of normal sales on the pilot register: Actions → **promote** →
   `X.Y.Z`. It refuses unless the pilot ring is on exactly that version.

Database changes are applied automatically when the new container starts.
Registers keep selling during the switch and sync when it is back.

### Rolling back

Registers never install an older version, so a bad register release is fixed
forward: revert on `main`, tag the next patch version (`vX.Y.Z+1`) and release
it as above. If the pilot found the problem, never promote the bad version.

The server alone can go back by running **deploy** with the previous version
(its image is still in GHCR), but only if the database migrations in between
work with the older code. Migrations only ever add, so check that the older
server does not break on the new columns or tables before doing this.

### The release token

The workflows authenticate to `/releases` with `RELEASE_DEPLOY_TOKEN` (a
GitHub secret); the server keeps only its SHA-256:

```sh
openssl rand -hex 32                          # the token: GitHub secret
printf %s '<the token>' | sha256sum           # the hash: RELEASE_DEPLOY_TOKEN_SHA256
```

To replace it, change both and redeploy.

### How a register updates itself

- It asks its server when it opens and every hour after. Offline it simply
  asks again later; selling is never affected.
- A newer version for its ring is downloaded in the background, then the
  header shows **Actualización lista** with an **Instalar ahora** button.
- It installs only when no sale is open: the button waits while a cart has
  items, the payment dialog is open or a sale is being saved. If the update
  is ready before anyone has logged in (typically right after opening the
  app), it installs straight away.
- Installing shows a small progress window, then the app opens again. Orders,
  settings and the token are kept.
- The installer comes from the GitHub Release; the register refuses it unless
  it is signed with the updater key whose public half is built into the app.
  The terminal token is only ever sent to our server.
- Updates need the server address to be `https://`.

Registers installed before self-updating existed (0.1.0) cannot update
themselves: install the first self-updating release on each PC by hand,
from the GitHub Release, over the existing installation.

## 7. Backups

Everything that matters is in Postgres. Back it up daily, off the server (if
the database is a Dokploy service, its scheduled backups do this):

```sh
pg_dump "$DATABASE_URL" --format=custom --file=mpf-$(date +%F).dump
```

Restore with `pg_restore --clean --dbname="$DATABASE_URL" <file>`. Try a
restore once before you depend on it.

Each register also keeps its own orders in
`%APPDATA%\com.mpf.register\register.sqlite`. That file only matters while the
header shows orders "por sincronizar": if a PC has to be replaced, let it sync
first, or copy that file to the new PC before opening the app.

## Before opening day

- [ ] `https://caja.example.com/health` works from outside; port 8787 is not
      published directly.
- [ ] The first admin has a strong password, and nobody ran the seed script.
- [ ] Every cashier PC has its own register and token.
- [ ] A test sale made with the network cable unplugged shows "por
      sincronizar", and reaches the panel after plugging it back in.
- [ ] A database backup has been taken and restored once.
- [ ] Printing has been tried on the real printers.
