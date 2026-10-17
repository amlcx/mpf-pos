# CI setup on GitHub (one time)

These files go at the root of `amlcx/mpf-pos`:

```
.github/workflows/ci.yml       checks on every PR and push to main
.github/workflows/release.yml  tag vX.Y.Z -> API image on GHCR + signed installer on a GitHub Release
.github/workflows/deploy.yml   manual: deploy the server, then offer the release to the pilot ring
.github/workflows/promote.yml  manual: move the release from pilot to stable
scripts/set-version.mjs        writes the tag's version everywhere it is needed
scripts/offer-release.mjs      calls the API's /releases routes
```

## Things to check in the repo before the first run

- `ci.yml`: Postgres user, password and database match `.env.example`.
- `release.yml`: `file: Dockerfile` points at the Dockerfile Dokploy uses, and
  it accepts `ARG APP_VERSION` (exposed to the API as an env var for `/health`).
- `apps/desktop/package.json` has a `"tauri": "tauri"` script.
- The root `package.json` has `"packageManager": "pnpm@11.x.x"`.

## Updater signing key

Generate it once, on your laptop, and keep an offline copy of the key file and
its password outside GitHub. Losing it means one more USB round.

```sh
cd apps/desktop && pnpm tauri signer generate -w ~/.tauri/mpf-pos.key
```

The public key goes in `apps/desktop/src-tauri/tauri.conf.json`
(`plugins.updater.pubkey`); `bundle.createUpdaterArtifacts` must be `true`.

## GitHub settings (Settings -> Secrets and variables -> Actions)

| Kind | Name | Value |
|---|---|---|
| Secret | `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/mpf-pos.key` |
| Secret | `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Its password |
| Secret | `DOKPLOY_DEPLOY_WEBHOOK` | The API app's deploy webhook URL in Dokploy |
| Secret | `RELEASE_DEPLOY_TOKEN` | A long random string (e.g. `openssl rand -hex 32`) |
| Variable | `API_BASE_URL` | Public URL of the API, e.g. `https://pos.example.co` |

## Server environment (Dokploy)

| Name | Value |
|---|---|
| `RELEASE_DEPLOY_TOKEN_SHA256` | SHA-256 of `RELEASE_DEPLOY_TOKEN` (only the hash, like terminal tokens) |
| `GITHUB_RELEASES_TOKEN` | Fine-grained token, repository `amlcx/mpf-pos` only, Contents: read |

Dokploy also needs to pull `ghcr.io/amlcx/mpf-pos-api:stable`: add GHCR as a
registry with a token that has `read:packages`.

## A release, end to end

1. `git tag v1.4.0 && git push origin v1.4.0` -> `release` runs.
2. Actions -> deploy -> Run workflow -> `1.4.0`. Server updates, pilot registers are offered 1.4.0.
3. After a day of normal sales: Actions -> promote -> Run workflow -> `1.4.0`.

Rollback: revert, tag `v1.4.1`, repeat. The server alone can be rolled back by
running `deploy` with the previous version (its image tag still exists), but
only if the database migrations in between are backward compatible.
