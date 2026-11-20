DROP TABLE `acquisition_plan_rows`;
--> statement-breakpoint
DROP TABLE `acquisition_plan_states`;
--> statement-breakpoint
DROP TABLE `acquisition_plan_revisions`;
--> statement-breakpoint
CREATE TABLE `acquisition_plans` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`sitemap_url` text NOT NULL,
	`sitemap_urls_json` text NOT NULL,
	`sitemap_total_count` integer NOT NULL,
	`plan_created_at` integer NOT NULL,
	`sitemap_fetched_at` integer,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `acquisition_plan_nodes` (
	`node_key` text PRIMARY KEY NOT NULL,
	`scope` text NOT NULL,
	`kinds_json` text NOT NULL,
	`url_template` text NOT NULL,
	`url_match` text NOT NULL,
	`state_fragment_land` text,
	`state_fragment_sea` text,
	`operations` text NOT NULL,
	`anchor` text NOT NULL,
	`note` text,
	`branch_parks_json` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `acquisition_restaurant_leaves` (
	`url` text PRIMARY KEY NOT NULL,
	`park` text NOT NULL,
	`source` text NOT NULL,
	`first_seen_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
