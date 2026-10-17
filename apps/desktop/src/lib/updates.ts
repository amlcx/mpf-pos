/**
 * Self-updates. The register asks its own server (the one chosen in Setup)
 * whether its release ring has a newer version, downloads it in the
 * background, and installs only when no sale is in progress: on Windows the
 * installer closes the app, and a cart or a payment must never be cut short.
 *
 * No Tauri here: the updater is passed in (tauri.ts in the app, a fake in
 * tests), so this runs under the e2e tests like the rest of src/lib.
 */

/** An update the server offered; download() must finish before install(). */
export interface FoundUpdate {
  version: string;
  notes?: string;
  download(): Promise<void>;
  /** On Windows this closes the app and runs the installer. */
  install(): Promise<void>;
}

export interface Updater {
  /** Asks `endpoint`, sending the terminal token; null when there is nothing newer. */
  check(endpoint: string, terminalToken: string): Promise<FoundUpdate | null>;
}

export type UpdateState =
  | { status: 'idle' }
  | { status: 'downloading'; version: string }
  | { status: 'ready'; version: string; notes: string }
  | { status: 'installing'; version: string };

export type InstallResult = 'installing' | 'busy' | 'nothing';

/** Tauri's updater fills in the placeholders; the route is in apps/api/src/app.ts. */
export function updateEndpoint(apiUrl: string): string {
  return `${apiUrl.replace(/\/+$/, '')}/updates/{{target}}/{{arch}}/{{current_version}}`;
}

export interface UpdateDeps {
  updater: Updater;
  /** Where to ask; null while the register is not set up. */
  server: () => { apiUrl: string; terminalToken: string } | null;
  /** True while a sale is open or being saved. Installing waits for it. */
  busy: () => boolean;
  onChange?: (state: UpdateState) => void;
}

export class Updates {
  state: UpdateState = { status: 'idle' };
  #deps: UpdateDeps;
  #found: FoundUpdate | null = null;
  #checking = false;

  constructor(deps: UpdateDeps) {
    this.#deps = deps;
  }

  #set(state: UpdateState) {
    this.state = state;
    this.#deps.onChange?.(state);
  }

  /**
   * Checks and, if there is an update, downloads it. Never throws and never
   * holds anything a sale needs: offline, or with the server unwell, it just
   * tries again next time.
   */
  async check(): Promise<void> {
    const server = this.#deps.server();
    if (!server || this.#checking || this.state.status !== 'idle') return;
    this.#checking = true;
    try {
      const found = await this.#deps.updater.check(updateEndpoint(server.apiUrl), server.terminalToken);
      if (!found) return;
      this.#set({ status: 'downloading', version: found.version });
      await found.download();
      this.#found = found;
      this.#set({ status: 'ready', version: found.version, notes: found.notes ?? '' });
    } catch (err) {
      console.warn('update check failed', err);
      this.#set({ status: 'idle' }); // a half-done download is started over next time
    } finally {
      this.#checking = false;
    }
  }

  /** Installs a downloaded update, unless a sale is in progress. */
  async install(): Promise<InstallResult> {
    const found = this.#found;
    if (this.state.status !== 'ready' || !found) return 'nothing';
    if (this.#deps.busy()) return 'busy';
    this.#set({ status: 'installing', version: found.version });
    try {
      await found.install();
      return 'installing';
    } catch (err) {
      console.warn('update install failed', err);
      this.#set({ status: 'ready', version: found.version, notes: found.notes ?? '' });
      throw err;
    }
  }
}
