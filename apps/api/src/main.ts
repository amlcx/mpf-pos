import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { connect, migrate } from './db.ts';

const config = loadConfig();
const sql = connect(config.DATABASE_URL);
const ran = await migrate(sql);
if (ran.length > 0) console.log(`Applied migrations: ${ran.join(', ')}`);

// Serve the admin panel when it has been built (pnpm build:admin).
const panelDir = fileURLToPath(new URL('../../admin/dist', import.meta.url));
const app = createApp({
  sql,
  sessionSecret: config.SESSION_SECRET,
  version: config.APP_VERSION,
  releaseTokenSha256: config.RELEASE_DEPLOY_TOKEN_SHA256,
  panelDir: existsSync(panelDir) ? panelDir : undefined,
});
const server = serve({ fetch: app.fetch, port: config.PORT }, (info) => {
  console.log(`mpf api ${config.APP_VERSION} listening on http://localhost:${info.port}`);
});

// In a container this process is PID 1, where signals do nothing unless
// handled. Stop taking requests, let the open ones finish, then leave.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    server.close(async () => {
      await sql.end({ timeout: 5 });
      process.exit(0);
    });
  });
}
