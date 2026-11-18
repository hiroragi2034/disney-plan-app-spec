CREATE TABLE `restaurant_facts` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`park` text NOT NULL,
	`name` text NOT NULL,
	`name_key` text NOT NULL,
	`service_type` text,
	`reservation_type` text NOT NULL,
	`reservation_evidence_kind` text NOT NULL,
	`reservation_evidence` text NOT NULL,
	`reservation_absence_markers_json` text,
	`reservation_unknown_reason` text,
	`mobile_order` text NOT NULL,
	`mobile_evidence_kind` text NOT NULL,
	`mobile_evidence` text NOT NULL,
	`mobile_absence_markers_json` text,
	`mobile_unknown_reason` text,
	`snapshot_id` integer NOT NULL REFERENCES `source_snapshots`(`id`),
	`created_at` integer NOT NULL
);
