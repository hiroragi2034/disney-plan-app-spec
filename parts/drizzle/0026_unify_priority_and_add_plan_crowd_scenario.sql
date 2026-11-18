ALTER TABLE `conditions` ADD COLUMN `priority` text;
--> statement-breakpoint
UPDATE `conditions` SET `priority` = NULLIF(trim(
CASE WHEN `priority_a` IS NOT NULL AND trim(`priority_a`) <> '' THEN '' || trim(`priority_a`) || char(10) ELSE '' END ||
CASE WHEN `priority_b` IS NOT NULL AND trim(`priority_b`) <> '' THEN '' || trim(`priority_b`) || char(10) ELSE '' END ||
CASE WHEN `priority_c` IS NOT NULL AND trim(`priority_c`) <> '' THEN '' || trim(`priority_c`) || char(10) ELSE '' END ||
CASE WHEN `common_priority` IS NOT NULL AND trim(`common_priority`) <> '' THEN '' || trim(`common_priority`) || char(10) ELSE '' END
), '');
--> statement-breakpoint
ALTER TABLE `conditions` DROP COLUMN `priority_a`;
--> statement-breakpoint
ALTER TABLE `conditions` DROP COLUMN `priority_b`;
--> statement-breakpoint
ALTER TABLE `conditions` DROP COLUMN `priority_c`;
--> statement-breakpoint
ALTER TABLE `conditions` DROP COLUMN `common_priority`;
--> statement-breakpoint
ALTER TABLE `plans` ADD COLUMN `crowd_scenario` text;
--> statement-breakpoint
ALTER TABLE `plans` ADD COLUMN `crowd_scenario_level` integer;
