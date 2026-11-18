CREATE TABLE `source_snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`kind` text NOT NULL,
	`park` text NOT NULL,
	`target_date` text,
	`url` text NOT NULL,
	`title` text,
	`raw_text` text NOT NULL,
	`batch_id` text NOT NULL,
	`fetched_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `fact_builds` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`park` text NOT NULL,
	`visit_date` text,
	`snapshot_ids_json` text NOT NULL,
	`universe_snapshot_id` integer NOT NULL REFERENCES `source_snapshots`(`id`),
	`universe_count` integer NOT NULL,
	`eligible_count` integer DEFAULT 0 NOT NULL,
	`not_eligible_count` integer DEFAULT 0 NOT NULL,
	`unknown_count` integer DEFAULT 0 NOT NULL,
	`unknown_json` text,
	`missing_json` text,
	`complete` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `normalized_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`build_id` integer NOT NULL REFERENCES `fact_builds`(`id`),
	`park` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`status` text NOT NULL,
	`price_jpy` integer,
	`effective_from` text,
	`effective_to` text,
	`unknown_reason` text,
	`evidence_kind` text DEFAULT 'excerpt' NOT NULL,
	`snapshot_id` integer NOT NULL REFERENCES `source_snapshots`(`id`),
	`evidence` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `fact_build_id` integer;
