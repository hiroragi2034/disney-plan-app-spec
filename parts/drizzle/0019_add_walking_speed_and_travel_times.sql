ALTER TABLE conditions ADD COLUMN walking_speed TEXT NOT NULL DEFAULT 'slightly_slow';
--> statement-breakpoint
UPDATE conditions SET walking_speed = 'slow' WHERE common_priority LIKE '%疲れやすい%';
--> statement-breakpoint
ALTER TABLE plan_sets ADD COLUMN walking_speed TEXT;
--> statement-breakpoint
ALTER TABLE plan_items ADD COLUMN travel_min INTEGER;
--> statement-breakpoint
CREATE TABLE area_travel_times (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  park TEXT NOT NULL,
  area_a TEXT NOT NULL,
  area_b TEXT NOT NULL,
  area_a_key TEXT NOT NULL,
  area_b_key TEXT NOT NULL,
  minutes INTEGER NOT NULL,
  source_title TEXT,
  source_url TEXT,
  fetched_at TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX area_travel_times_park_pair ON area_travel_times (park, area_a_key, area_b_key);
