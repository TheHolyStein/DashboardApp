ALTER TABLE `login_attempts` ADD `lock_level` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `login_attempts` ADD `last_failure_at` text;
