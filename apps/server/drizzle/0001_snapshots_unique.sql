CREATE UNIQUE INDEX `snapshots_module_instance_uq` ON `snapshots` (`module_id`, coalesce(`instance_id`, ''));
