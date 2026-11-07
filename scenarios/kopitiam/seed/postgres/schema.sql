DROP TABLE IF EXISTS knowledge_chunks CASCADE;
DROP TABLE IF EXISTS launch_budget CASCADE;
DROP TABLE IF EXISTS butter_costing CASCADE;
DROP TABLE IF EXISTS payment_walkouts CASCADE;
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

CREATE TABLE payment_walkouts (
  id serial PRIMARY KEY,
  captured_on date NOT NULL UNIQUE,
  regulars_walked_out integer NOT NULL,
  tiktok_views integer NOT NULL,
  carry_small_notes_pct numeric(5, 2) NOT NULL,
  notes text,
  updated_on date NOT NULL
);

CREATE TABLE butter_costing (
  id serial PRIMARY KEY,
  portion_grams integer NOT NULL UNIQUE,
  extra_cost_per_set_sgd numeric(10, 2) NOT NULL,
  monthly_margin_impact_sgd numeric(10, 2) NOT NULL,
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
