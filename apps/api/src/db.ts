import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

/** Columns are snake_case in SQL and camelCase in TypeScript. */
export function connect(url: string, options: postgres.Options<{}> = {}): Sql {
  return postgres(url, { transform: postgres.camel, onnotice: () => {}, ...options });
}

/** Applies migrations/*.sql in name order, each at most once. */
export async function migrate(sql: Sql): Promise<string[]> {
  const dir = new URL('../migrations/', import.meta.url);
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  return sql.begin(async (tx) => {
    await tx`select pg_advisory_xact_lock(727001)`;
    await tx`create table if not exists schema_migrations (
      name text primary key, applied_at timestamptz not null default now())`;
    const rows = await tx<{ name: string }[]>`select name from schema_migrations`;
    const applied = new Set(rows.map((r) => r.name));
    const ran: string[] = [];
    for (const file of files) {
      if (applied.has(file)) continue;
      await tx.unsafe(await readFile(new URL(file, dir), 'utf8'));
      await tx`insert into schema_migrations (name) values (${file})`;
      ran.push(file);
    }
    return ran;
  });
}
