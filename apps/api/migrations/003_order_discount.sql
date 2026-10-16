-- An order may carry one discount on the sum of its lines. Lines keep their
-- full prices; discount_cents is what came off before tax was worked out.
alter table orders
  add column discount_kind  text check (discount_kind in ('loyalty_card')),
  add column discount_cents integer not null default 0 check (discount_cents >= 0),
  add check (discount_kind is not null or discount_cents = 0);
