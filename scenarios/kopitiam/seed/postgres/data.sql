INSERT INTO kiosk_trial_stats (trial_date, first_time_users, froze_at_kopi_o_kosong, missed_language_toggle_pct, notes, updated_on) VALUES
  ('2026-11-10', 28, 19, 72.00, '68% of first-time users froze on Step 2 at Kopi O Kosong; 72% missed the corner language toggle', '2026-11-10');

INSERT INTO floor_morning_counts (captured_on, seats, booth_seats, laptop_campers, solo_diner_pct, lost_turnover_sgd, notes, updated_on) VALUES
  ('2026-11-11', 28, 16, 4, 60.00, 420.00, 'Four 4-seater booths held for 2 hours on a single $2.20 Kopi O; 60% of morning customers dine solo', '2026-11-11');

INSERT INTO sfa_egg_batches (batch_code, holding_temp_c, extra_cost_per_day_sgd, notes, updated_on) VALUES
  ('Batch #402 (Fresh Grade AA)', 63.0, 0.00, 'Linked to unconfirmed hospital salmonella case from 10 Nov trial; lab results take 48h; SFA inspects tomorrow at 9:00am', '2026-11-11'),
  ('Batch #405 (Pasteurized Liquid / Shell Backup)', 63.0, 180.00, 'Pasteurized backup batch on standby; holding above 65C curdles yolks into hard-boiled eggs', '2026-11-11');

INSERT INTO delivery_commission_tiers (channel, commission_pct, net_margin_per_set_sgd, notes, updated_on) VALUES
  ('GrabFood / Foodpanda Single Set ($10)', 32.00, -0.40, '32% platform commission ($3.20) plus packaging leaves -$0.40 net loss per single set; drives 50% of morning volume ($2,400/morning)', '2026-11-11'),
  ('GrabFood Corporate Platter Bundle (5+ sets)', 32.00, 1.85, 'Categorised as catering SKU; exempt from single-item price-parity search suppression', '2026-11-11'),
  ('Direct Web QR Self-Pickup Link', 0.00, 3.10, '0% commission for express counter self-pickup; no rider dispatch integration', '2026-11-11');

INSERT INTO launch_budget (item, planned_sgd, spent_sgd, notes, updated_on) VALUES
  ('Storefront bunting and bilingual table tent cards', 450.00, 450.00, 'Installed at Raffles Place #B1-14', '2026-11-11'),
  ('Sous-vide water bath & digital temperature probes', 600.00, 600.00, 'Calibrated for 63C continuous holding ahead of SFA inspection', '2026-11-11'),
  ('Pasteurized backup egg batch & launch promo reserve', 750.00, 0.00, '$750 unspent launch budget available for tomorrow ($180/day pasteurized backup batch and CBD office QR self-pickup flyers)', '2026-11-11');
