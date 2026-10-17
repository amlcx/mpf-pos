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

Get the hash with `printf %s 'the-token' | sha256sum` and copy only the hex part.

The repository is public, so registers download installers straight from
the GitHub Release. The server needs no GitHub token.

## Making the API image pullable (once)

New container packages on GHCR start private, even in a public repository.
After the first `release` run:

1. GitHub profile -> Packages -> `mpf-pos-api` -> Package settings.
2. Danger Zone -> Change visibility -> Public.
3. In Dokploy, set the app's image to `ghcr.io/amlcx/mpf-pos-api:stable`
   with no registry. Nothing secret goes in the image; secrets stay in
   Dokploy's environment variables.

## Public repository safeguards

- Scan the whole git history for secrets (`gitleaks detect`). Rotate any real
  production token or password that was ever committed.
- Settings -> Actions -> General: require approval for workflows from all
  outside collaborators.
- Never use `pull_request_target`, and never give `ci.yml` secrets.
- Settings -> Rules: a tag ruleset for `v*` so only you can create release
  tags, and a branch ruleset for `main` (pull requests, `ci / checks` passing).
- Never attach a self-hosted runner to this repository.
- Production must never accept the seed tokens (`mpf_dev_terminal_a`/`_b`)
  or the demo users from `pnpm db:seed`.

## A release, end to end

1. `git tag v1.4.0 && git push origin v1.4.0` -> `release` runs.
2. Actions -> deploy -> Run workflow -> `1.4.0`. Server updates, pilot registers are offered 1.4.0.
3. After a day of normal sales: Actions -> promote -> Run workflow -> `1.4.0`.

Rollback: revert, tag `v1.4.1`, repeat. The server alone can be rolled back by
running `deploy` with the previous version (its image tag still exists), but
only if the database migrations in between are backward compatible.
