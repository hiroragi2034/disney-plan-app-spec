ALTER TABLE `facilities` ADD COLUMN `reservation_type` text;
--> statement-breakpoint
ALTER TABLE `facilities` ADD COLUMN `mobile_order` text;
--> statement-breakpoint
UPDATE `facilities` SET `reservation_type` = 'required' WHERE `id` = 35 AND `name` LIKE '%ケープコッド%' AND `reservation_type` IS NULL;
