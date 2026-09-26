CREATE TABLE `embassy` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`document_slug` text NOT NULL,
	`grant` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`fetch_count` integer DEFAULT 0 NOT NULL,
	`last_fetched_at` integer,
	`write_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (cast(unixepoch('subsecond') * 1000 as integer)) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `project`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `embassy_project_slug_idx` ON `embassy` (`project_id`,`document_slug`);