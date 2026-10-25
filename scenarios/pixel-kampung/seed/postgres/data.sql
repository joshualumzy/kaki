INSERT INTO playtest_quit_stats (level, players_started, players_quit, quit_rate, notes) VALUES
  (1, 40, 1, 2.50, 'Tutorial level'),
  (2, 39, 2, 5.13, NULL),
  (3, 37, 3, 8.11, 'First combo tutorial'),
  (4, 34, 5, 14.71, 'Night market introduces the timer'),
  (5, 29, 19, 65.52, 'Boss order; most quits happen on the third queue'),
  (6, 10, 2, 20.00, NULL),
  (7, 8, 1, 12.50, NULL),
  (8, 7, 2, 28.57, 'Night market frame rate complaints here'),
  (9, 5, 1, 20.00, NULL),
  (10, 4, 0, 0.00, 'Finale');

INSERT INTO wishlist_counts (captured_on, wishlists) VALUES
  ('2026-10-19', 1840),
  ('2026-11-02', 2650),
  ('2026-11-09', 3120);

INSERT INTO launch_budget (item, planned_sgd, spent_sgd, notes) VALUES
  ('Indie Arcade SG booth rental', 1200.00, 1200.00, 'Paid with the exhibitor deposit'),
  ('Roll-up banner', 120.00, 120.00, 'Collected from the printer'),
  ('Stickers', 130.00, 130.00, '200 die-cut stickers'),
  ('Launch trailer', 300.00, 0.00, 'Starfruit wants it by 18 November'),
  ('Contingency', 50.00, 0.00, NULL);
