ALTER TABLE `plan_sets` ADD COLUMN `progress_a` text DEFAULT 'waiting' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `progress_b` text DEFAULT 'waiting' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plan_sets` ADD COLUMN `progress_c` text DEFAULT 'waiting' NOT NULL;
--> statement-breakpoint
UPDATE `plan_sets` SET `progress_a` = 'done', `progress_b` = 'done', `progress_c` = 'done' WHERE `status` = 'done';
--> statement-breakpoint
UPDATE `plan_sets` SET `progress_a` = 'failed', `progress_b` = 'failed', `progress_c` = 'failed' WHERE `status` = 'failed';
--> statement-breakpoint
UPDATE `plan_sets`
SET `title` = (
  SELECT '(' || ranked.rn || ') ' FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `title` ORDER BY `id`) AS rn FROM `plan_sets`
  ) AS ranked WHERE ranked.`id` = `plan_sets`.`id`
) || `title`
WHERE (
  SELECT ranked2.rn FROM (
    SELECT `id`, ROW_NUMBER() OVER (PARTITION BY `title` ORDER BY `id`) AS rn FROM `plan_sets`
  ) AS ranked2 WHERE ranked2.`id` = `plan_sets`.`id`
) > 1;
