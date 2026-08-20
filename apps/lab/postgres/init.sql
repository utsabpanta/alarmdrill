create table if not exists products (
  id          text primary key,
  name        text        not null,
  price_cents integer     not null
);

create table if not exists orders (
  id         uuid primary key default gen_random_uuid(),
  status     text        not null,
  created_at timestamptz not null default now()
);

insert into products (id, name, price_cents) values
  ('p1', 'Aeropress',       3499),
  ('p2', 'Burr Grinder',    9900),
  ('p3', 'Gooseneck Kettle',6250),
  ('p4', 'Scale',           4100)
on conflict (id) do nothing;
