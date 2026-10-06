CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`incident_id` text NOT NULL,
	`ref` text NOT NULL,
	`check` text NOT NULL,
	`title` text NOT NULL,
	`connection_id` text,
	`query` text,
	`status` text NOT NULL,
	`summary` text NOT NULL,
	`data` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `evidence_incident` ON `evidence` (`incident_id`);--> statement-breakpoint
CREATE TABLE `incidents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`severity` text DEFAULT 'unknown' NOT NULL,
	`status` text DEFAULT 'open' NOT NULL,
	`origin` text DEFAULT 'alerts' NOT NULL,
	`group_key` text,
	`group_reason` text,
	`target_ids` text,
	`triage_state` text DEFAULT 'none' NOT NULL,
	`triage_note` text,
	`run_id` text,
	`root_cause` text,
	`confidence` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`resolved_at` integer,
	`merged_into` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `incidents_project_status` ON `incidents` (`project_id`,`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `incidents_resolved` ON `incidents` (`resolved_at`);--> statement-breakpoint
CREATE TABLE `metric_points` (
	`watch_id` text NOT NULL,
	`series` text NOT NULL,
	`at` integer NOT NULL,
	`value` real NOT NULL,
	PRIMARY KEY(`watch_id`, `series`, `at`),
	FOREIGN KEY (`watch_id`) REFERENCES `watches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `metric_points_at` ON `metric_points` (`at`);--> statement-breakpoint
CREATE TABLE `observations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`watch_id` text NOT NULL,
	`series` text NOT NULL,
	`labels` text,
	`target_id` text,
	`kind` text NOT NULL,
	`severity` text NOT NULL,
	`message` text NOT NULL,
	`value` real,
	`details` text,
	`incident_id` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`watch_id`) REFERENCES `watches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`incident_id`) REFERENCES `incidents`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `observations_open` ON `observations` (`project_id`,`resolved_at`);--> statement-breakpoint
CREATE INDEX `observations_watch` ON `observations` (`watch_id`,`series`,`kind`);--> statement-breakpoint
CREATE TABLE `watches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`connection_id` text NOT NULL,
	`key` text NOT NULL,
	`title` text NOT NULL,
	`query` text NOT NULL,
	`unit` text DEFAULT 'count' NOT NULL,
	`builtin` integer DEFAULT false NOT NULL,
	`bad_direction` text DEFAULT 'both' NOT NULL,
	`limit` text,
	`group` text DEFAULT 'custom' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`last_run_at` integer,
	`last_error` text,
	`series_count` integer DEFAULT 0 NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`connection_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `watches_connection_key` ON `watches` (`connection_id`,`key`);--> statement-breakpoint
CREATE INDEX `watches_project` ON `watches` (`project_id`);--> statement-breakpoint
ALTER TABLE `alerts` ADD `connection_id` text REFERENCES targets(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `alerts` ADD `incident_id` text REFERENCES incidents(id) ON DELETE set null;--> statement-breakpoint
ALTER TABLE `alerts` ADD `starts_at` integer;--> statement-breakpoint
ALTER TABLE `alerts` ADD `resolved_at` integer;--> statement-breakpoint
CREATE INDEX `alerts_incident` ON `alerts` (`incident_id`);