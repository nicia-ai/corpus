CREATE TABLE `event_log` (
	`monotonic_id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`schema_version` integer NOT NULL,
	`project_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`event_type` text NOT NULL,
	`timestamp` text NOT NULL,
	`payload` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `event_log_idempotency_key_unique` ON `event_log` (`idempotency_key`);