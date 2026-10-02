CREATE TABLE `learned_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`signature` text NOT NULL,
	`example` text NOT NULL,
	`target_id` text,
	`effect` text NOT NULL,
	`min_tier` text NOT NULL,
	`trigger` text NOT NULL,
	`reason` text NOT NULL,
	`evidence_json` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`hits` integer DEFAULT 0 NOT NULL,
	`last_hit_at` integer,
	`reset_batch` text,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `learned_rules_project` ON `learned_rules` (`project_id`,`status`,`signature`);--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `signature` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `learned_at` integer;--> statement-breakpoint
CREATE INDEX `tool_calls_signature` ON `tool_calls` (`signature`);