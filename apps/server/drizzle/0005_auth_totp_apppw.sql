ALTER TABLE `users` ADD `totp_last_step` integer;--> statement-breakpoint
ALTER TABLE `app_passwords` ADD `selector` text DEFAULT '' NOT NULL;--> statement-breakpoint
CREATE INDEX `app_passwords_selector_idx` ON `app_passwords` (`selector`);
