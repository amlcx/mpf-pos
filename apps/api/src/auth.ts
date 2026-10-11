import { createHash, randomBytes } from 'node:crypto';
import type { Role } from '@mpf/shared';

/**
 * Two credentials:
 * - terminal token: identifies an enrolled PC and, through it, the store.
 *   Sent as `Authorization: Bearer`. Enough to sync and submit orders.
 * - session token: identifies the logged-in person. Sent as `X-Session`.
 *   Required to void an order or mark a product sold out, and, with the
 *   admin role, for anything under /admin.
 */
export interface TerminalCtx {
  id: string;
  storeId: string;
  code: string;
  name: string;
}
export interface SessionCtx {
  userId: string;
  role: Role;
}

export const SESSION_TTL_SECONDS = 12 * 60 * 60;

export function newTerminalToken(): string {
  return `mpf_${randomBytes(24).toString('hex')}`;
}
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
