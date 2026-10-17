-- Registers update themselves. Each terminal belongs to a release ring: a
-- new version is offered to 'pilot' first and, after a day of normal sales,
-- promoted to 'stable'. app_version is what the register last said it runs.
alter table terminals
  add column app_version  text,
  add column release_ring text not null default 'stable' check (release_ring in ('pilot', 'stable'));

-- The release each ring should install. url points at the installer on the
-- GitHub Release; signature is its minisign signature, which the register
-- checks against the public key built into it.
create table register_releases (
  ring       text primary key check (ring in ('pilot', 'stable')),
  version    text not null,
  url        text not null,
  signature  text not null,
  notes      text not null default '',
  pub_date   timestamptz,
  updated_at timestamptz not null default now()
);
