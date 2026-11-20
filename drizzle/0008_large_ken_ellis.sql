CREATE TABLE `project_stats` (
	`project_id` text PRIMARY KEY NOT NULL,
	`schema_version` integer NOT NULL,
	`stats_json` text,
	`computed_at` integer,
	`attempted_at` integer NOT NULL,
	`error_kind` text,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
