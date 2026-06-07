CREATE TABLE `suggestion` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`document_slug` text NOT NULL,
	`base_doc_version` integer NOT NULL,
	`proposed_markdown` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` text NOT NULL,
	`resolved_by` text,
	`resolved_at` text,
	CONSTRAINT "suggestion_status_valid" CHECK(status in ('open', 'applied', 'rejected', 'stale'))
);
--> statement-breakpoint
CREATE INDEX `suggestion_doc` ON `suggestion` (`document_slug`);--> statement-breakpoint
CREATE TABLE `suggestion_hunk` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`suggestion_id` integer NOT NULL,
	`ordinal` integer NOT NULL,
	`op` text NOT NULL,
	`base_start` integer NOT NULL,
	`base_end` integer NOT NULL,
	`proposed_text` text NOT NULL,
	`decision` text NOT NULL,
	CONSTRAINT "suggestion_hunk_op_valid" CHECK(op in ('replace', 'insert', 'delete')),
	CONSTRAINT "suggestion_hunk_decision_valid" CHECK(decision in ('pending', 'accepted', 'rejected'))
);
--> statement-breakpoint
CREATE INDEX `suggestion_hunk_suggestion` ON `suggestion_hunk` (`suggestion_id`);