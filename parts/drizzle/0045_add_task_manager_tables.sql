CREATE TABLE `task_mgr_params` (
	`kind` integer PRIMARY KEY NOT NULL,
	`start_timeout_sec` integer NOT NULL,
	`total_timeout_sec` integer NOT NULL,
	`max_attempts` integer NOT NULL
);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (1, 120, 300, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (2, 120, 300, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (3, 120, 300, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (4, 120, 300, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (5, 180, 900, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (6, 180, 900, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (7, 120, 300, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (8, 120, 300, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (9, 180, 900, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (10, 180, 900, 3);
--> statement-breakpoint
CREATE TABLE `task_mgr_tests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`total` integer DEFAULT 100 NOT NULL,
	`started_at` integer NOT NULL,
	`closed_at` integer,
	`close_reason` text
);
--> statement-breakpoint
CREATE TABLE `task_mgr_runs` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`test_id` integer NOT NULL,
	`seq` integer NOT NULL,
	`kind` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`final_reason` text,
	`created_at` integer NOT NULL,
	`closed_at` integer
);
--> statement-breakpoint
CREATE TABLE `task_mgr_attempts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`run_id` integer NOT NULL,
	`attempt_no` integer NOT NULL,
	`status` text DEFAULT 'awaiting_start' NOT NULL,
	`spawned_at` integer NOT NULL,
	`start_deadline_at` integer NOT NULL,
	`total_deadline_at` integer NOT NULL,
	`first_call_at` integer,
	`finished_at` integer,
	`close_reason` text
);
--> statement-breakpoint
CREATE TABLE `task_mgr_calls` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`attempt_id` integer NOT NULL,
	`phase` text NOT NULL,
	`called_at` integer NOT NULL,
	`note` text,
	`text_length` integer,
	`saved_text` text
);
