CREATE TABLE `task_mgr_runs_new` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`test_id` integer,
	`seq` integer DEFAULT 0 NOT NULL,
	`kind` integer NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`final_reason` text,
	`created_at` integer NOT NULL,
	`closed_at` integer,
	`target_json` text
);
--> statement-breakpoint
INSERT INTO `task_mgr_runs_new` (`id`, `test_id`, `seq`, `kind`, `status`, `final_reason`, `created_at`, `closed_at`) SELECT `id`, `test_id`, `seq`, `kind`, `status`, `final_reason`, `created_at`, `closed_at` FROM `task_mgr_runs`;
--> statement-breakpoint
DROP TABLE `task_mgr_runs`;
--> statement-breakpoint
ALTER TABLE `task_mgr_runs_new` RENAME TO `task_mgr_runs`;
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (11, 180, 2400, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (12, 180, 1800, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (13, 120, 600, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (14, 180, 900, 3);
