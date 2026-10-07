ALTER TABLE `incidents` ADD `ignored_until` integer;--> statement-breakpoint
ALTER TABLE `incidents` ADD `ignored_by` text;--> statement-breakpoint
ALTER TABLE `incidents` ADD `ignore_reason` text;