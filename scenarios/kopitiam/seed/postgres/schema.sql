DROP TABLE IF EXISTS knowledge_chunks CASCADE;
DROP TABLE IF EXISTS launch_budget CASCADE;
DROP TABLE IF EXISTS delivery_commission_tiers CASCADE;
DROP TABLE IF EXISTS food_safety_incident CASCADE;
DROP TABLE IF EXISTS floor_morning_counts CASCADE;
DROP TABLE IF EXISTS regulars_pricing CASCADE;

CREATE TABLE regulars_pricing (
  id serial PRIMARY KEY,
  effective_on date NOT NULL UNIQUE,
  old_kopi_price_sgd numeric(6, 2) NOT NULL,
  new_kopi_price_sgd numeric(6, 2) NOT NULL,
  cost_per_cup_sgd numeric(6, 2) NOT NULL,
  regulars_most_mornings integer NOT NULL,
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

CREATE TABLE food_safety_incident (
  id serial PRIMARY KEY,
  incident_on date NOT NULL UNIQUE,
  fridge_off_hours numeric(4, 1) NOT NULL,
  disposal_logged_at time NOT NULL,
  delivery_eta time NOT NULL,
  officer_eta time NOT NULL,
  goodwill_cap_sgd numeric(10, 2) NOT NULL,
  socket_cover_sgd numeric(10, 2) NOT NULL,
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
