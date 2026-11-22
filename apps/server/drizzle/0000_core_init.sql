CREATE TABLE `audit_log` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`at` text NOT NULL,
	`user_id` text,
	`action` text NOT NULL,
	`detail` text,
	`ip` text
);
--> statement-breakpoint
CREATE INDEX `audit_log_at_idx` ON `audit_log` (`at`);--> statement-breakpoint
CREATE INDEX `audit_log_user_idx` ON `audit_log` (`user_id`);--> statement-breakpoint
CREATE TABLE `http_cache` (
	`key` text PRIMARY KEY NOT NULL,
	`status` integer NOT NULL,
	`headers` text DEFAULT '{}' NOT NULL,
	`body` blob,
	`expires_at` text NOT NULL,
	`etag` text
);
--> statement-breakpoint
CREATE INDEX `http_cache_expires_idx` ON `http_cache` (`expires_at`);--> statement-breakpoint
CREATE TABLE `instances` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`page_id` text NOT NULL,
	`settings` text DEFAULT '{}' NOT NULL,
	`x` integer DEFAULT 0 NOT NULL,
	`y` integer DEFAULT 0 NOT NULL,
	`w` integer DEFAULT 1 NOT NULL,
	`h` integer DEFAULT 1 NOT NULL,
	`mobile_order` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`page_id`) REFERENCES `pages`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `instances_page_idx` ON `instances` (`page_id`);--> statement-breakpoint
CREATE INDEX `instances_module_idx` ON `instances` (`module_id`);--> statement-breakpoint
CREATE TABLE `job_state` (
	`module_id` text NOT NULL,
	`job` text NOT NULL,
	`instance_id` text DEFAULT '' NOT NULL,
	`last_run_at` text,
	`last_ok_at` text,
	`failures` integer DEFAULT 0 NOT NULL,
	`next_run_at` text,
	PRIMARY KEY(`module_id`, `job`, `instance_id`)
);
--> statement-breakpoint
CREATE INDEX `job_state_next_idx` ON `job_state` (`next_run_at`);--> statement-breakpoint
CREATE TABLE `kv` (
	`module_id` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`module_id`, `key`)
);
--> statement-breakpoint
CREATE TABLE `module_state` (
	`module_id` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT 1 NOT NULL,
	`config` text DEFAULT '{}' NOT NULL,
	`migration_id` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`user_id` text,
	`level` text NOT NULL,
	`title` text NOT NULL,
	`body` text,
	`url` text,
	`dedupe_key` text,
	`created_at` text NOT NULL,
	`read_at` text
);
--> statement-breakpoint
CREATE INDEX `notifications_user_idx` ON `notifications` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `notifications_dedupe_idx` ON `notifications` (`module_id`,`dedupe_key`);--> statement-breakpoint
CREATE TABLE `pages` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`sort` integer DEFAULT 0 NOT NULL,
	`shared` integer DEFAULT 0 NOT NULL,
	`background` text
);
--> statement-breakpoint
CREATE INDEX `pages_owner_idx` ON `pages` (`owner_id`,`sort`);--> statement-breakpoint
CREATE TABLE `secrets` (
	`module_id` text NOT NULL,
	`name` text NOT NULL,
	`nonce` blob NOT NULL,
	`ciphertext` blob NOT NULL,
	PRIMARY KEY(`module_id`, `name`)
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`module_id` text NOT NULL,
	`instance_id` text,
	`data` text NOT NULL,
	`updated_at` text NOT NULL,
	`job_ok` integer DEFAULT 1 NOT NULL
);
