DROP TABLE entries;
--> statement-breakpoint
CREATE TABLE conditions (
  id INTEGER PRIMARY KEY,
  park TEXT NOT NULL DEFAULT 'land',
  visit_date TEXT,
  entry_time TEXT,
  exit_time TEXT,
  budget_jpy INTEGER,
  adults INTEGER NOT NULL DEFAULT 2,
  children INTEGER NOT NULL DEFAULT 0,
  children_ages TEXT,
  stay_hotel TEXT,
  priority_a TEXT,
  priority_b TEXT,
  priority_c TEXT,
  common_priority TEXT,
  updated_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  role TEXT NOT NULL,
  text TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE plan_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  park TEXT NOT NULL,
  visit_date TEXT,
  status TEXT NOT NULL DEFAULT 'generating',
  error TEXT,
  conditions_snapshot TEXT,
  sources_json TEXT,
  notes TEXT,
  park_hours TEXT,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
--> statement-breakpoint
CREATE TABLE plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_set_id INTEGER NOT NULL REFERENCES plan_sets(id),
  slot TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT,
  estimated_cost_jpy INTEGER,
  created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE plan_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_id INTEGER NOT NULL REFERENCES plans(id),
  sort_order INTEGER NOT NULL DEFAULT 0,
  time_label TEXT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'other',
  area TEXT,
  note TEXT,
  pass_type TEXT,
  lat REAL,
  lng REAL
);
