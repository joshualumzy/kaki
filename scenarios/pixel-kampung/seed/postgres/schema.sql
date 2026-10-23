DROP TABLE IF EXISTS knowledge_chunks CASCADE;
DROP TABLE IF EXISTS launch_budget CASCADE;
DROP TABLE IF EXISTS wishlist_counts CASCADE;
DROP TABLE IF EXISTS playtest_quit_stats CASCADE;

CREATE TABLE playtest_quit_stats (
  id serial PRIMARY KEY,
  level integer NOT NULL UNIQUE,
  players_started integer NOT NULL,
  players_quit integer NOT NULL,
  quit_rate numeric(5, 2) NOT NULL,
  notes text,
  updated_on date NOT NULL
);

CREATE TABLE wishlist_counts (
  id serial PRIMARY KEY,
  captured_on date NOT NULL UNIQUE,
  wishlists integer NOT NULL
);

CREATE TABLE launch_budget (
  id serial PRIMARY KEY,
  item text NOT NULL UNIQUE,
  planned_sgd numeric(10, 2) NOT NULL,
  spent_sgd numeric(10, 2) NOT NULL,
  notes text,
  updated_on date NOT NULL
);

CREATE TABLE knowledge_chunks (
  id bigserial PRIMARY KEY,
  source text NOT NULL,
  ref text NOT NULL,
  text text NOT NULL,
  published_at timestamptz NOT NULL,
  embedding vector(1024),
  UNIQUE (source, ref)
);
