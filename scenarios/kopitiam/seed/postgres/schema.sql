DROP TABLE IF EXISTS knowledge_chunks CASCADE;
DROP TABLE IF EXISTS launch_budget CASCADE;
DROP TABLE IF EXISTS delivery_commission_tiers CASCADE;
DROP TABLE IF EXISTS sfa_egg_batches CASCADE;
DROP TABLE IF EXISTS floor_morning_counts CASCADE;
DROP TABLE IF EXISTS kiosk_trial_stats CASCADE;

CREATE TABLE kiosk_trial_stats (
  id serial PRIMARY KEY,
  trial_date date NOT NULL UNIQUE,
  first_time_users integer NOT NULL,
  froze_at_kopi_o_kosong integer NOT NULL,
  missed_language_toggle_pct numeric(5, 2) NOT NULL,
  notes text,
  updated_on date NOT NULL
);

CREATE TABLE floor_morning_counts (
  id serial PRIMARY KEY,
  captured_on date NOT NULL UNIQUE,
  seats integer NOT NULL,
  booth_seats integer NOT NULL,
  laptop_campers integer NOT NULL,
  solo_diner_pct numeric(5, 2) NOT NULL,
  lost_turnover_sgd numeric(10, 2) NOT NULL,
  notes text,
  updated_on date NOT NULL
);

CREATE TABLE sfa_egg_batches (
  id serial PRIMARY KEY,
  batch_code text NOT NULL UNIQUE,
  holding_temp_c numeric(4, 1) NOT NULL,
  extra_cost_per_day_sgd numeric(10, 2) NOT NULL,
  notes text,
  updated_on date NOT NULL
);

CREATE TABLE delivery_commission_tiers (
  id serial PRIMARY KEY,
  channel text NOT NULL UNIQUE,
  commission_pct numeric(5, 2) NOT NULL,
  net_margin_per_set_sgd numeric(10, 2) NOT NULL,
  notes text,
  updated_on date NOT NULL
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
