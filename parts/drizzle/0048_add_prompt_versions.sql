CREATE TABLE `prompt_versions` (
	`ver` integer PRIMARY KEY NOT NULL,
	`body_json` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`record_ref` text,
	`state` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `prompt_update_state` (
	`id` integer PRIMARY KEY NOT NULL,
	`last_check_at` integer,
	`last_result` text,
	`last_error_class` text,
	`last_seen_ver` integer
);
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `prompts_ver` integer;
