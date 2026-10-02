CREATE TABLE `run_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`run_id` text,
	`run_title` text,
	`step_id` text,
	`user_id` text,
	`rating` text NOT NULL,
	`correction` text,
	`doc_id` text,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`run_id`) REFERENCES `runs`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`doc_id`) REFERENCES `knowledge_docs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `run_feedback_run` ON `run_feedback` (`run_id`);--> statement-breakpoint
CREATE INDEX `run_feedback_project` ON `run_feedback` (`project_id`,`created_at`);