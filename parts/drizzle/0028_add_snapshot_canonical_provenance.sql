ALTER TABLE `source_snapshots` ADD COLUMN `fetch_method` text DEFAULT 'legacy_unknown' NOT NULL;
--> statement-breakpoint
ALTER TABLE `source_snapshots` ADD COLUMN `canonical` integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE `source_snapshots` ADD COLUMN `completeness_note` text;
