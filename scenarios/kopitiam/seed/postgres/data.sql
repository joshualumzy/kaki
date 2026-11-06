INSERT INTO playtest_quit_stats (level, players_started, players_quit, quit_rate, notes, updated_on) VALUES
  (1, 40, 1, 2.50, 'Step 1: Choose Set Meal or Ala Carte', '2026-11-10'),
  (2, 28, 19, 67.86, 'Step 2: Drink customization (Kopi O Kosong Peng vs Teh C Siew Dai)', '2026-11-10'),
  (3, 20, 1, 5.00, 'Step 3: PayNow QR payment', '2026-11-10');

INSERT INTO wishlist_counts (captured_on, wishlists) VALUES
  ('2026-10-19', 1420),
  ('2026-11-02', 2380),
  ('2026-11-09', 3120);

INSERT INTO launch_budget (item, planned_sgd, spent_sgd, notes, updated_on) VALUES
  ('Storefront bunting and queue signage', 450.00, 450.00, 'Installed at Raffles Place #B1-14', '2026-11-11'),
  ('300 Kaya Toast plushie keychains', 600.00, 600.00, 'Delivered to Raffles Place storeroom', '2026-11-11'),
  ('TikTok Livestream (@MakanWithZack)', 600.00, 0.00, 'Quoted $600 standard or $450 buddy rate + 20 plushies', '2026-11-11'),
  ('Launch contingency & backup stock', 150.00, 0.00, 'Remaining unspent budget is $750 total', '2026-11-11');
