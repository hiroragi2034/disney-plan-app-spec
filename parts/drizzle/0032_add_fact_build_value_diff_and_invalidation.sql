ALTER TABLE `fact_builds` ADD COLUMN `value_changes_json` text;
--> statement-breakpoint
ALTER TABLE `fact_builds` ADD COLUMN `value_diff_knockdowns_json` text;
--> statement-breakpoint
ALTER TABLE `fact_builds` ADD COLUMN `baseline_build_id` integer;
--> statement-breakpoint
ALTER TABLE `fact_builds` ADD COLUMN `invalidated_at` integer;
--> statement-breakpoint
ALTER TABLE `fact_builds` ADD COLUMN `invalidated_reason` text;
