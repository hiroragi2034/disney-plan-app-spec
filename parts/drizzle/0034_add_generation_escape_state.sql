ALTER TABLE plan_sets ADD COLUMN generation_started_at integer;
--> statement-breakpoint
ALTER TABLE plan_sets ADD COLUMN pending_ops_json text;
