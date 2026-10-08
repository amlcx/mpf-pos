import { DatabaseSync } from 'node:sqlite';
import type { LocalDb } from '../src/lib/local-db.ts';

/** In-memory LocalDb with the same contract as the Tauri one. */
export function createNodeDb(): LocalDb {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  return {
    async select<T>(sql: string, params: (string | number | null)[] = []) {
      return db.prepare(sql).all(...params).map((row) => ({ ...row })) as T[];
    },
    async batch(statements) {
      db.exec('BEGIN');
      try {
        for (const s of statements) db.prepare(s.sql).run(...(s.params ?? []));
        db.exec('COMMIT');
      } catch (err) {
        db.exec('ROLLBACK');
        throw err;
      }
    },
  };
}
