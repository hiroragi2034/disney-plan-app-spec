CREATE TABLE `announcement` (
	`id` integer PRIMARY KEY NOT NULL,
	`ver` real NOT NULL,
	`title` text DEFAULT '' NOT NULL,
	`body` text DEFAULT '' NOT NULL,
	`fetched_at` integer NOT NULL
);
