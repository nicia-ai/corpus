CREATE TABLE `mirror_state` (
	`corpus_slug` text PRIMARY KEY NOT NULL,
	`intent` text DEFAULT 'sync' NOT NULL,
	`generation` integer DEFAULT 0 NOT NULL,
	`synced_generation` integer DEFAULT 0 NOT NULL,
	`changed_by` text NOT NULL,
	`changed_at` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`retry_at` integer,
	`last_error` text,
	`last_commit` text,
	`last_synced_at` text,
	CONSTRAINT "mirror_state_intent_valid" CHECK(intent in ('sync', 'rebuild', 'delete'))
);
