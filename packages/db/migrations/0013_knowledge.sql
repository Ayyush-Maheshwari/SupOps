CREATE TABLE `knowledge_docs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`slug` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`tags` text DEFAULT '[]' NOT NULL,
	`scope` text DEFAULT '{}' NOT NULL,
	`pinned` integer DEFAULT false NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`source_run_id` text,
	`created_by` text,
	`approved_by` text,
	`approved_at` integer,
	`use_count` integer DEFAULT 0 NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`approved_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `knowledge_project_slug` ON `knowledge_docs` (`project_id`,`slug`);--> statement-breakpoint
CREATE INDEX `knowledge_project_status` ON `knowledge_docs` (`project_id`,`status`,`kind`);--> statement-breakpoint
CREATE TABLE `run_knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`doc_id` text NOT NULL,
	`via` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`doc_id`) REFERENCES `knowledge_docs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `run_knowledge_run` ON `run_knowledge` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_knowledge_doc` ON `run_knowledge` (`doc_id`);