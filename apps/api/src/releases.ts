import { RELEASE_URL_PREFIX, ReleaseOfferSchema, ReleasePromoteSchema } from '@mpf/shared';
import { Hono } from 'hono';
import { tokenMatchesHash } from './auth.ts';
import type { Sql } from './db.ts';
import { body, fail } from './http.ts';

/**
 * Called by the release workflows (scripts/offer-release.mjs), not by people
 * or registers: a third front door with its own credential. Only the SHA-256
 * of that token is configured on the server, like terminal tokens. These
 * routes touch no store data.
 */
export function createReleaseRoutes(deps: { sql: Sql; releaseTokenSha256?: string }) {
  const { sql, releaseTokenSha256 } = deps;
  const r = new Hono();

  r.use(async (c, next) => {
    const token = /^Bearer (.+)$/.exec(c.req.header('Authorization') ?? '')?.[1];
    if (!releaseTokenSha256 || !token || !tokenMatchesHash(token, releaseTokenSha256)) {
      fail(401, 'release_token_invalid');
    }
    await next();
  });

  /** Offers a version to one ring. Registers there get it on their next check. */
  r.post('/', async (c) => {
    const offer = await body(c, ReleaseOfferSchema);
    // The prefix alone is not enough: "…/download/../../other/repo" passes
    // it, and URL clients resolve the dots. Only a URL that is already in
    // normal form, under this version's tag, is accepted.
    const normalised = URL.canParse(offer.url) && new URL(offer.url).href === offer.url;
    if (!normalised || !offer.url.startsWith(`${RELEASE_URL_PREFIX}v${offer.version}/`)) {
      fail(400, 'release_url_invalid');
    }
    const row = {
      ring: offer.ring,
      version: offer.version,
      url: offer.url,
      signature: offer.signature,
      notes: offer.notes,
      pubDate: offer.pubDate,
    };
    await sql`
      insert into register_releases ${sql(row)}
      on conflict (ring) do update set
        version = excluded.version, url = excluded.url, signature = excluded.signature,
        notes = excluded.notes, pub_date = excluded.pub_date, updated_at = now()`;
    return c.json({ status: 'offered', ring: offer.ring, version: offer.version });
  });

  /** Gives stable registers exactly what the pilot ring has been running. */
  r.post('/promote', async (c) => {
    const { version } = await body(c, ReleasePromoteSchema);
    const promoted = await sql.begin(async (tx) => {
      const [pilot] = await tx<{ version: string }[]>`
        select version from register_releases where ring = 'pilot' for update`;
      if (pilot?.version !== version) return { ok: false as const, pilot: pilot?.version ?? null };
      await tx`
        insert into register_releases (ring, version, url, signature, notes, pub_date)
        select 'stable', version, url, signature, notes, pub_date
        from register_releases where ring = 'pilot'
        on conflict (ring) do update set
          version = excluded.version, url = excluded.url, signature = excluded.signature,
          notes = excluded.notes, pub_date = excluded.pub_date, updated_at = now()`;
      return { ok: true as const };
    });
    if (!promoted.ok) fail(409, 'pilot_not_on_version', { pilot: promoted.pilot });
    return c.json({ status: 'promoted', version });
  });

  return r;
}
