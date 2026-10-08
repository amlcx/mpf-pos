import { type User, verifyPassword } from '@mpf/shared';
import { ApiError, NetworkError } from './api.ts';
import { findUser } from './repo.ts';
import type { SyncDeps } from './sync.ts';

export interface Session {
  user: User;
  /** False after an offline login: selling works, admin actions do not. */
  online: boolean;
}

/**
 * Logs in against the server when it answers, otherwise against the user
 * list cached by the last pull. Returns null for wrong credentials.
 */
export async function login({ db, api }: SyncDeps, username: string, password: string): Promise<Session | null> {
  try {
    const { token, user } = await api.login(username, password);
    api.sessionToken = token;
    return { user, online: true };
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) return null;
    if (!(err instanceof NetworkError) && !(err instanceof ApiError && err.status >= 500)) throw err;
  }
  api.sessionToken = null;
  const cached = await findUser(db, username);
  if (!cached || !(await verifyPassword(password, cached.passwordHash))) return null;
  const { passwordHash: _, ...user } = cached;
  return { user, online: false };
}
