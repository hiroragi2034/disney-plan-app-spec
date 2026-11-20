INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (15, 120, 600, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (16, 180, 900, 3);
--> statement-breakpoint
INSERT INTO `task_mgr_params` (`kind`, `start_timeout_sec`, `total_timeout_sec`, `max_attempts`) VALUES (17, 180, 900, 3);
--> statement-breakpoint
CREATE TABLE `mgr_dialog_notices` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`text` text NOT NULL,
	`created_at` integer NOT NULL,
	`shown_at` integer
);
