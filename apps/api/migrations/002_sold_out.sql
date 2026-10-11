-- Products prepared on demand (track_stock = false) have no quantity to run
-- out of. Staff mark them sold out by hand when the ingredients are gone; a
-- row here means "not available at this store right now".
create table sold_out (
  store_id   uuid not null references stores,
  product_id uuid not null references products,
  marked_by  uuid not null references users,
  marked_at  timestamptz not null default now(),
  primary key (store_id, product_id)
);
