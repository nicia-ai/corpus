CREATE TABLE `change_events` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_type` text NOT NULL,
	`document_slug` text,
	`collection_slug` text,
	`before_json` text,
	`after_json` text,
	`changed_at` text NOT NULL,
	`changed_by` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `content_blobs` (
	`hash` text PRIMARY KEY NOT NULL,
	`bytes` blob NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `instrumentation_outbox` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`local_event_id` integer NOT NULL,
	`schema_version` integer NOT NULL,
	`project_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`event_type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` text NOT NULL,
	`attempt_count` integer DEFAULT 0 NOT NULL
);
