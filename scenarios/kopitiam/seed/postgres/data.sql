INSERT INTO regulars_pricing (effective_on, old_kopi_price_sgd, new_kopi_price_sgd, cost_per_cup_sgd, regulars_most_mornings, notes, updated_on) VALUES
  ('2026-11-11', 1.30, 2.40, 1.60, 40, 'Old shop kopi was $1.30; the new menu charges $2.40; about $1.60 per cup including the rent share; about 40 regulars came in most mornings at the old shop', '2026-11-10');

INSERT INTO floor_morning_counts (captured_on, seats, booth_seats, laptop_campers, solo_diner_pct, lost_turnover_sgd, notes, updated_on) VALUES
  ('2026-11-10', 28, 16, 16, 60.00, 420.00, 'Laptop users held 16 of 28 seats for about two hours on one kopi at the trial; about 60% of morning customers dine solo; the blocked seats cost about $420 in breakfast sales', '2026-11-10');

INSERT INTO food_safety_incident (incident_on, fridge_off_hours, disposal_logged_at, delivery_eta, officer_eta, goodwill_cap_sgd, socket_cover_sgd, notes, updated_on) VALUES
  ('2026-11-11', 3.0, '06:10', '10:00', '09:00', 3000.00, 15.00, 'Night cleaner unplugged the prep fridge after the trial; it was off about three hours last night. Head chef found it at 6:10, threw out everything and signed the disposal log. The customer ate Set A at the trial before the fridge failed overnight, so it is probably unrelated but looks bad. The food agency officer''s routine check, booked weeks ago, is at 9; the replacement eggs and kaya arrive at 10. The insurer allows a goodwill payment up to $3,000 without admitting fault; a lockable socket cover costs $15', '2026-11-11');

INSERT INTO delivery_commission_tiers (channel, commission_pct, net_margin_per_set_sgd, notes, updated_on) VALUES
  ('GrabFood single set ($10)', 32.00, -0.50, '32% of $10 leaves $6.80; a delivered set costs $7.30 to make and pack; loss is $0.50 per set. Across a full morning those single-set losses add up to about $120', '2026-11-10'),
  ('Office Platter (5 sets, $50)', 32.00, 5.00, 'Cost $29 because packaging is shared; $34 kept; $5 profit per platter. The large trays limit the count and we have 30', '2026-11-10'),
  ('Direct pickup with 10% off ($9)', 0.00, 2.00, 'Cost $7.00 with no delivery packaging; $2 profit per set; pickup excludes delivery packaging', '2026-11-10');

INSERT INTO launch_budget (item, planned_sgd, spent_sgd, notes, updated_on) VALUES
  ('No approved goodwill or socket-cover spend', 0.00, 0.00, 'Insurer allows up to $3,000 goodwill without admitting fault; a lockable socket cover costs $15; neither spend is approved yet', '2026-11-11');
