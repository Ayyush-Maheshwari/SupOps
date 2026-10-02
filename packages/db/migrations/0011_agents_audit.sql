CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`actor_id` text,
	`actor_name` text,
	`project_id` text,
	`entity` text NOT NULL,
	`entity_id` text,
	`action` text NOT NULL,
	`before` text,
	`after` text,
	FOREIGN KEY (`actor_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `audit_project_at` ON `audit_log` (`project_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `audit_entity` ON `audit_log` (`entity`,`entity_id`);--> statement-breakpoint
ALTER TABLE `agents` ADD `description` text;--> statement-breakpoint
ALTER TABLE `agents` ADD `archived_at` integer;