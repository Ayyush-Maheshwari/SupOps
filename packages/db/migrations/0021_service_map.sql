CREATE TABLE `ci_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`item_id` text,
	`link_id` text,
	`source` text NOT NULL,
	`ref` text NOT NULL,
	`detail` text,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `ci_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`link_id`) REFERENCES `ci_links`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_evidence_fact` ON `ci_evidence` (`project_id`,`item_id`,`link_id`,`source`,`ref`);--> statement-breakpoint
CREATE INDEX `ci_evidence_link` ON `ci_evidence` (`link_id`);--> statement-breakpoint
CREATE INDEX `ci_evidence_item` ON `ci_evidence` (`item_id`);--> statement-breakpoint
CREATE TABLE `ci_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`type` text DEFAULT 'service' NOT NULL,
	`env` text,
	`description` text,
	`aliases` text NOT NULL,
	`attrs` text NOT NULL,
	`target_id` text,
	`status` text DEFAULT 'approved' NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_items_key` ON `ci_items` (`project_id`,`key`);--> statement-breakpoint
CREATE INDEX `ci_items_target` ON `ci_items` (`target_id`);--> statement-breakpoint
CREATE TABLE `ci_links` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`from_id` text NOT NULL,
	`to_id` text NOT NULL,
	`kind` text DEFAULT 'depends_on' NOT NULL,
	`detail` text,
	`status` text DEFAULT 'approved' NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`updated_by` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`from_id`) REFERENCES `ci_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`to_id`) REFERENCES `ci_items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`updated_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ci_links_pair` ON `ci_links` (`project_id`,`from_id`,`to_id`,`kind`);--> statement-breakpoint
CREATE INDEX `ci_links_to` ON `ci_links` (`to_id`);--> statement-breakpoint
CREATE TABLE `ci_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`origin` text NOT NULL,
	`source_ref` text,
	`source_title` text,
	`op` text NOT NULL,
	`payload` text NOT NULL,
	`quote` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`decided_by` text,
	`decided_at` integer,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `ci_proposals_project` ON `ci_proposals` (`project_id`,`status`);