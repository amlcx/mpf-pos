import { type ProductInput, type Role, hashPassword } from '@mpf/shared';
import { hashToken, newTerminalToken } from './auth.ts';
import type { Sql } from './db.ts';

/** Row-creation helpers shared by the scripts and the tests. */

export async function createStore(
  sql: Sql,
  input: { code: string; name: string; currencySymbol?: string; taxRateBps?: number; taxIncluded?: boolean },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into stores ${sql(input)} returning id`;
  return row!.id;
}

/** Returns the plain token; only its hash is stored, so it cannot be shown again. */
export async function createTerminal(
  sql: Sql,
  input: { storeId: string; code: string; name: string; token?: string },
): Promise<{ id: string; token: string }> {
  const token = input.token ?? newTerminalToken();
  const [row] = await sql<{ id: string }[]>`
    insert into terminals ${sql({
      storeId: input.storeId,
      code: input.code,
      name: input.name,
      tokenHash: hashToken(token),
    })} returning id`;
  return { id: row!.id, token };
}

export async function createUser(
  sql: Sql,
  input: { username: string; name: string; role: Role; password: string; storeId?: string | null },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`
    insert into users ${sql({
      username: input.username,
      name: input.name,
      role: input.role,
      storeId: input.storeId ?? null,
      passwordHash: await hashPassword(input.password),
    })} returning id`;
  return row!.id;
}

export async function createProduct(
  sql: Sql,
  input: Pick<ProductInput, 'name' | 'priceCents'> & Partial<ProductInput>,
  stock?: { storeId: string; quantity: number },
): Promise<string> {
  const [row] = await sql<{ id: string }[]>`insert into products ${sql(input)} returning id`;
  if (stock) {
    await sql`insert into stock ${sql({ ...stock, productId: row!.id })}`;
  }
  return row!.id;
}
