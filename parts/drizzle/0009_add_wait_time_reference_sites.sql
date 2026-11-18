CREATE TABLE `wait_time_sources` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`park` text DEFAULT 'both' NOT NULL,
	`provides` text,
	`last_checked_at` integer,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `wait_time_source_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`instruction` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD `estimate_sources_json` text;
