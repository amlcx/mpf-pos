import { getVersion } from '@tauri-apps/api/app';
import { invoke } from '@tauri-apps/api/core';
import { relaunch } from '@tauri-apps/plugin-process';
import { Update } from '@tauri-apps/plugin-updater';
import type { LocalDb } from './local-db.ts';
import type { Updater } from './updates.ts';

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

/** The version in tauri.conf.json, which the release sets from its tag. */
export const appVersion = () => getVersion();

/**
 * check_update (main.rs) asks our server with the terminal token, then
 * hands back the plugin's own Update, whose download and install we use.
 */
export const tauriUpdater: Updater = {
  async check(endpoint, terminalToken) {
    const metadata = await invoke<ConstructorParameters<typeof Update>[0] | null>('check_update', {
      endpoint,
      terminalToken,
    });
    if (!metadata) return null;
    const update = new Update(metadata);
    return {
      version: update.version,
      notes: update.body,
      download: () => update.download(),
      async install() {
        // Windows: the installer closes the app and opens it again when done.
        // Elsewhere install returns and the app restarts itself.
        await update.install();
        await relaunch();
      },
    };
  },
};
