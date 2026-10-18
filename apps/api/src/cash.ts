import type { CashSession } from '@mpf/shared';
import type { TerminalCtx } from './auth.ts';
import type { Sql } from './db.ts';

export type SaveCashResult = 'saved' | 'conflict';

/**
 * Stores a register's drawer as the register sends it: the whole drawer,
 * every time. Retrying is always safe:
 * - the opening is written once and must match afterwards,
 * - movements are added by id, never changed,
 * - the closing is written once and must match afterwards.
 * Anything that would rewrite what the server already has is a conflict.
 */
export async function saveCashSession(sql: Sql, terminal: TerminalCtx, s: CashSession): Promise<SaveCashResult> {
  return sql.begin(async (tx) => {
    await tx`
      insert into cash_sessions ${tx({
        id: s.id,
        storeId: terminal.storeId,
        terminalId: terminal.id,
        businessDate: s.businessDate,
        openedBy: s.openedBy,
        openedAt: s.openedAt,
        openingCounts: tx.json(s.openingCount),
        openingCents: s.openingCents,
      })}
      on conflict (id) do nothing`;
    // Locked, so two pushes of the same drawer cannot both write its closing.
    const [same] = await tx<{ closedAt: Date | null; sameClosing: boolean }[]>`
      select closed_at,
        closed_by is not distinct from ${s.closing?.closedBy ?? null}::uuid
          and closed_at is not distinct from ${s.closing?.closedAt ?? null}::timestamptz
          and closing_counts is not distinct from ${s.closing ? tx.json(s.closing.count) : null}::jsonb
          and counted_cents is not distinct from ${s.closing?.countedCents ?? null}::int
          and expected_cents is not distinct from ${s.closing?.expectedCents ?? null}::int
          and close_note = ${s.closing?.note ?? ''} as same_closing
      from cash_sessions
      where id = ${s.id} and terminal_id = ${terminal.id}
        and business_date = ${s.businessDate}::date
        and opened_by = ${s.openedBy} and opened_at = ${s.openedAt}::timestamptz
        and opening_counts = ${tx.json(s.openingCount)}::jsonb and opening_cents = ${s.openingCents}
      for update`;
    // Another register's drawer, or this one's opening told differently.
    if (!same) return 'conflict';

    if (s.movements.length > 0) {
      await tx`
        insert into cash_movements ${tx(s.movements.map((m) => ({ ...m, sessionId: s.id })))}
        on conflict (id) do nothing`;
    }

    if (s.closing) {
      if (same.closedAt === null) {
        const c = s.closing;
        await tx`
          update cash_sessions set
            closed_by = ${c.closedBy}, closed_at = ${c.closedAt}, closing_counts = ${tx.json(c.count)},
            counted_cents = ${c.countedCents}, expected_cents = ${c.expectedCents}, close_note = ${c.note}
          where id = ${s.id}`;
      } else if (!same.sameClosing) {
        return 'conflict';
      }
    }
    // A push without a closing after the server has one is just late: keep it closed.
    return 'saved';
  });
}
