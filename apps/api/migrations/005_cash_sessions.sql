-- The cash drawer of each register, one per business day. The register
-- generates the ids and sends the whole drawer each time (PUT), so these
-- rows are written by apps/api/src/cash.ts only.
create table cash_sessions (
  id              uuid primary key,
  store_id        uuid not null references stores,
  terminal_id     uuid not null references terminals,
  business_date   date not null,
  opened_by       uuid not null references users,
  opened_at       timestamptz not null,           -- register clock
  opening_counts  jsonb not null,                 -- {"10000000": 2, ...}: pieces per denomination (cents)
  opening_cents   integer not null check (opening_cents >= 0),
  closed_by       uuid references users,
  closed_at       timestamptz,
  closing_counts  jsonb,
  counted_cents   integer check (counted_cents >= 0),
  -- What the register worked out the drawer should hold, at closing. A
  -- snapshot, like an order's prices: later voids do not rewrite it.
  expected_cents  integer,
  close_note      text not null default '',
  received_at     timestamptz not null default now(),
  check ((closed_at is null) = (closed_by is null)
     and (closed_at is null) = (closing_counts is null)
     and (closed_at is null) = (counted_cents is null)
     and (closed_at is null) = (expected_cents is null))
);
create index cash_sessions_store_date_idx on cash_sessions (store_id, business_date);

create table cash_movements (
  id           uuid primary key,
  session_id   uuid not null references cash_sessions,
  kind         text not null check (kind in ('in', 'out')),
  amount_cents integer not null check (amount_cents > 0),
  reason       text not null,
  user_id      uuid not null references users,
  created_at   timestamptz not null           -- register clock
);
create index cash_movements_session_idx on cash_movements (session_id);

-- The drawer a sale's cash went into. No foreign key on purpose: an online
-- sale is sent at once, and may reach the server before its drawer does.
alter table orders add column cash_session_id uuid;
create index orders_cash_session_idx on orders (cash_session_id);
