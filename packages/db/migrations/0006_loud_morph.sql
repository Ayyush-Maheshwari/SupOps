CREATE TABLE `become_secrets` (
	`id` text PRIMARY KEY NOT NULL,
	`target_id` text NOT NULL,
	`sudo_user` text DEFAULT '' NOT NULL,
	`credential_id` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`credential_id`) REFERENCES `credentials`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `become_secrets_target_user` ON `become_secrets` (`target_id`,`sudo_user`);