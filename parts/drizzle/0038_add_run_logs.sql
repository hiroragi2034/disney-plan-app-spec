CREATE TABLE `run_logs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_set_id` integer NOT NULL,
	`kind` text NOT NULL,
	`slot` text,
	`status` text DEFAULT 'open' NOT NULL,
	`outcome` text,
	`started_at` integer NOT NULL,
	`closed_at` integer,
	`close_reason` text,
	`last_completed_phase` text,
	`current_phase` text
);
--> statement-breakpoint
CREATE TABLE `run_log_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`at` integer NOT NULL,
	`event_type` text NOT NULL,
	`phase` text,
	`label` text NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE INDEX `run_logs_plan_set_idx` ON `run_logs` (`plan_set_id`);
--> statement-breakpoint
CREATE INDEX `run_log_events_run_idx` ON `run_log_events` (`run_id`);
