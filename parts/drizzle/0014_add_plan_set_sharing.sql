ALTER TABLE `plan_sets` ADD COLUMN `share_status` text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `share_url` text;
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `share_error` text;
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `share_requested_at` integer;
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `share_updated_at` integer;
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `share_photos_included` integer;
