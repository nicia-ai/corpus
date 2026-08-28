CREATE TABLE `oauth_client_assertion` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `oauth_client_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`resource_id` text NOT NULL,
	`metadata` text,
	`created_at` integer,
	FOREIGN KEY (`client_id`) REFERENCES `oauth_client`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`resource_id`) REFERENCES `oauth_resource`(`identifier`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthClientResource_clientId_resourceId_uidx` ON `oauth_client_resource` (`client_id`,`resource_id`);--> statement-breakpoint
CREATE INDEX `oauthClientResource_clientId_idx` ON `oauth_client_resource` (`client_id`);--> statement-breakpoint
CREATE INDEX `oauthClientResource_resourceId_idx` ON `oauth_client_resource` (`resource_id`);--> statement-breakpoint
CREATE TABLE `oauth_resource` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`name` text NOT NULL,
	`access_token_ttl` integer,
	`refresh_token_ttl` integer,
	`signing_algorithm` text,
	`signing_key_id` text,
	`allowed_scopes` text,
	`custom_claims` text,
	`dpop_bound_access_tokens_required` integer DEFAULT false,
	`disabled` integer DEFAULT false,
	`created_at` integer,
	`updated_at` integer,
	`policy_version` integer DEFAULT 1,
	`metadata` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_resource_identifier_unique` ON `oauth_resource` (`identifier`);--> statement-breakpoint
-- The pre-upgrade schema declared BOTH an inline `.unique()` on `slug`
-- (SQLite name: organization_slug_unique) AND this explicitly-named
-- `uniqueIndex` builder entry — redundant, both created back in 0000.
-- auth:schema's regen drops the explicit builder entry; the inline
-- `.unique()` (and its index) is untouched, so the slug is still enforced
-- unique after this statement.
DROP INDEX `organization_slug_uidx`;--> statement-breakpoint
ALTER TABLE `account` ADD `issuer` text;--> statement-breakpoint
ALTER TABLE `jwks` ADD `alg` text;--> statement-breakpoint
ALTER TABLE `jwks` ADD `crv` text;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD `authorization_code_id` text;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD `revoked` integer;--> statement-breakpoint
ALTER TABLE `oauth_access_token` ADD `confirmation` text;--> statement-breakpoint
CREATE INDEX `oauthAccessToken_authorizationCodeId_idx` ON `oauth_access_token` (`authorization_code_id`);--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `client_discovery_id` text;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `client_credentials_scopes` text DEFAULT '[]';--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `backchannel_logout_uri` text;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `backchannel_logout_session_required` integer;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `application_type` text;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `jwks` text;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `jwks_uri` text;--> statement-breakpoint
ALTER TABLE `oauth_client` ADD `dpop_bound_access_tokens` integer DEFAULT false;--> statement-breakpoint
ALTER TABLE `oauth_consent` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauth_consent` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `authorization_code_id` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `resources` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `requested_user_info_claims` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `rotated_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `rotation_replay_response` text;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `rotation_replay_expires_at` integer;--> statement-breakpoint
ALTER TABLE `oauth_refresh_token` ADD `confirmation` text;--> statement-breakpoint
CREATE INDEX `oauthRefreshToken_authorizationCodeId_idx` ON `oauth_refresh_token` (`authorization_code_id`);