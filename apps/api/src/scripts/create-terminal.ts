// Enrols a PC: pnpm --filter @mpf/api terminal:create <store-code> <terminal-code> [name]
import { loadConfig } from '../config.ts';
import { connect } from '../db.ts';
import { createTerminal } from '../fixtures.ts';

const [storeCode, code, name] = process.argv.slice(2);
if (!storeCode || !code) {
  console.error('usage: terminal:create <store-code> <terminal-code> [name]');
  process.exit(1);
}
const sql = connect(loadConfig().DATABASE_URL);
const [store] = await sql<{ id: string }[]>`select id from stores where code = ${storeCode}`;
if (!store) {
  console.error(`No store with code "${storeCode}".`);
  process.exitCode = 1;
} else {
  const { token } = await createTerminal(sql, { storeId: store.id, code, name: name ?? `Register ${code}` });
  console.log(`Terminal ${code} created. Enter this token in the app (it is not shown again):\n${token}`);
}
await sql.end();
