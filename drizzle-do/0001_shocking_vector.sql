CREATE TABLE `comment` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`thread_id` integer NOT NULL,
	`body` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `comment_thread_id` ON `comment` (`thread_id`);--> statement-breakpoint
CREATE TABLE `comment_thread` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_slug` text NOT NULL,
	`anchor_block_id` text NOT NULL,
	`anchor_start` integer NOT NULL,
	`anchor_end` integer NOT NULL,
	`quote_prefix` text NOT NULL,
	`quote_exact` text NOT NULL,
	`quote_suffix` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_by` text,
	`resolved_at` text,
	CONSTRAINT "comment_thread_status_valid" CHECK(status in ('open', 'resolved', 'orphaned'))
);
--> statement-breakpoint
CREATE INDEX `comment_thread_doc` ON `comment_thread` (`document_slug`);--> statement-breakpoint
CREATE TABLE `document_block_map` (
	`document_slug` text NOT NULL,
	`doc_version` integer NOT NULL,
	`parser_version` integer NOT NULL,
	`blocks` text NOT NULL,
	PRIMARY KEY(`document_slug`, `doc_version`)
);
--> statement-breakpoint
CREATE TABLE `document_block_seq` (
	`document_slug` text PRIMARY KEY NOT NULL,
	`next` integer DEFAULT 0 NOT NULL
);
