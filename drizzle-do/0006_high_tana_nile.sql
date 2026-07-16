CREATE TABLE `suggestion_message` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`suggestion_id` integer NOT NULL,
	`body` text NOT NULL,
	`created_by` text NOT NULL,
	`channel` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `suggestion_message_suggestion` ON `suggestion_message` (`suggestion_id`);