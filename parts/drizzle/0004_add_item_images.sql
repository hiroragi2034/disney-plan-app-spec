ALTER TABLE `plan_sets` ADD COLUMN `images_status` text DEFAULT 'idle' NOT NULL;
--> statement-breakpoint
ALTER TABLE `plan_items` ADD COLUMN `image_blob_key` text;
