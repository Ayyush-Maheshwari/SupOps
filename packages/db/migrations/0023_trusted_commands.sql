CREATE TABLE `trusted_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`tool_key` text NOT NULL,
	`match_kind` text NOT NULL,
	`canonical` text NOT NULL,
	`program` text,
	`flags` text,
	`folder` text,
	`glob` text,
	`envs` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`note` text,
	`source_tool_call_id` text,
	`created_by` text,
	`created_at` integer NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`revoked_by` text,
	`revoked_at` integer,
	`hits` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`revoked_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `trusted_commands_project` ON `trusted_commands` (`project_id`,`status`);