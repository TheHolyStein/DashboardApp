CREATE TABLE `notification_mutes` (
	`user_id` text NOT NULL,
	`module_id` text NOT NULL,
	`until` text NOT NULL,
	PRIMARY KEY(`user_id`, `module_id`)
);
