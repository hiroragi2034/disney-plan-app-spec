ALTER TABLE `plan_sets` ADD `last_verified_at` integer;
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD `reverifications_json` text;
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD `eve_dialog_shown_at` integer;
--> statement-breakpoint
CREATE TABLE `verification_requests` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`plan_set_id` integer NOT NULL REFERENCES `plan_sets`(`id`),
	`status` text DEFAULT 'pending' NOT NULL,
	`trigger` text DEFAULT 'dialog' NOT NULL,
	`created_at` integer NOT NULL,
	`completed_at` integer
);
--> statement-breakpoint
UPDATE `plan_sets` SET `last_verified_at` = CAST(strftime('%s', replace(json_extract(`verification_json`, '$.checkedAt'), '/', '-')) AS INTEGER) * 1000 WHERE `verification_json` IS NOT NULL AND json_extract(`verification_json`, '$.checkedAt') IS NOT NULL AND strftime('%s', replace(json_extract(`verification_json`, '$.checkedAt'), '/', '-')) IS NOT NULL;
