import { invoke } from '@tauri-apps/api/core';
import type { LocalDb } from './local-db.ts';

/** The only file that talks to the Rust side (src-tauri/src/main.rs). */

export const tauriDb: LocalDb = {
  select: (sql, params = []) => invoke('db_select', { sql, params }),
  batch: (statements) => invoke('db_batch', { statements }),
};

/** Writes a file into the user's Downloads folder and returns its full path. */
export const saveExport = (filename: string, contents: string) =>
  invoke<string>('save_export', { filename, contents });

export const printRaw = (target: string, bytes: Uint8Array) =>
  invoke<void>('print_raw', { target, bytes: Array.from(bytes) });
