CREATE TABLE `facilities` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`park` text NOT NULL,
	`name_key` text NOT NULL,
	`name` text NOT NULL,
	`area` text,
	`official_url` text,
	`duration_min` integer,
	`lat` real,
	`lng` real,
	`image_blob_key` text,
	`image_source` text,
	`coords_fetched_at` integer,
	`static_fetched_at` integer,
	`image_fetched_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `facilities_park_name_key` ON `facilities` (`park`,`name_key`);
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `progress_updated_at` integer;
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `generation_metrics_json` text;
--> statement-breakpoint
ALTER TABLE `wait_time_sources` ADD COLUMN `fetch_method` text;
--> statement-breakpoint
UPDATE `plan_sets` SET `progress_updated_at` = `created_at` WHERE `status` = 'generating';
