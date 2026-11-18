ALTER TABLE plan_sets ADD COLUMN set_type TEXT NOT NULL DEFAULT 'standard';
--> statement-breakpoint
ALTER TABLE plan_sets ADD COLUMN same_day_location TEXT;
--> statement-breakpoint
ALTER TABLE plan_sets ADD COLUMN same_day_start_time TEXT;
--> statement-breakpoint
ALTER TABLE plan_sets ADD COLUMN same_day_request TEXT;
--> statement-breakpoint
ALTER TABLE plan_sets ADD COLUMN same_day_adults INTEGER;
--> statement-breakpoint
ALTER TABLE plan_sets ADD COLUMN same_day_children INTEGER;
