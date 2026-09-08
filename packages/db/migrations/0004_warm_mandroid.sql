CREATE TABLE `alert_subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`channel_id` text NOT NULL,
	`channel_name` text NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `alert_subs_channel` ON `alert_subscriptions` (`channel_id`,`enabled`);--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`source` text DEFAULT 'slack' NOT NULL,
	`channel_id` text,
	`channel_name` text,
	`fingerprint` text NOT NULL,
	`title` text NOT NULL,
	`severity` text DEFAULT 'unknown' NOT NULL,
	`status` text DEFAULT 'new' NOT NULL,
	`summary` text,
	`labels` text,
	`raw_payload` text,
	`slack_ts` text,
	`slack_permalink` text,
	`count` integer DEFAULT 1 NOT NULL,
	`run_id` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`decided_at` integer,
	`decided_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `alerts_project_status` ON `alerts` (`project_id`,`status`,`created_at`);