CREATE TABLE `run_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`mime` text NOT NULL,
	`name` text,
	`width` integer,
	`height` integer,
	`bytes` integer NOT NULL,
	`data` blob NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `run_attachments_run` ON `run_attachments` (`run_id`,`created_at`);