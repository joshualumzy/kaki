INSERT INTO playtest_quit_stats (level, players_started, players_quit, quit_rate, notes, updated_on) VALUES
  (1, 40, 1, 2.50, 'Tutorial level', '2026-11-10'),
  (2, 39, 2, 5.13, NULL, '2026-11-10'),
  (3, 37, 3, 8.11, 'First combo tutorial', '2026-11-10'),
  (4, 34, 5, 14.71, 'Night market introduces the timer', '2026-11-10'),
  (5, 29, 19, 65.52, 'Boss order; most quits happen on the third queue', '2026-11-10'),
  (6, 10, 2, 20.00, NULL, '2026-11-10'),
  (7, 8, 1, 12.50, NULL, '2026-11-10'),
  (8, 7, 2, 28.57, 'Night market frame rate complaints here', '2026-11-10'),
  (9, 5, 1, 20.00, NULL, '2026-11-10'),
  (10, 4, 0, 0.00, 'Finale', '2026-11-10');

INSERT INTO wishlist_counts (captured_on, wishlists) VALUES
  ('2026-10-19', 1840),
  ('2026-11-02', 2650),
  ('2026-11-09', 3120);

INSERT INTO launch_budget (item, planned_sgd, spent_sgd, notes, updated_on) VALUES
  ('Indie Arcade SG booth rental', 1200.00, 1200.00, 'Paid with the exhibitor deposit', '2026-11-11'),
  ('Roll-up banner', 120.00, 120.00, 'Collected from the printer', '2026-11-11'),
  ('Stickers', 130.00, 130.00, '200 die-cut stickers', '2026-11-11'),
  ('Launch trailer', 300.00, 0.00, 'Starfruit wants it by 18 November', '2026-11-11'),
  ('Contingency', 50.00, 0.00, NULL, '2026-11-11');
