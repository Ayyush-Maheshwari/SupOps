ALTER TABLE `run_steps` ADD `origin` text;--> statement-breakpoint
ALTER TABLE `tool_calls` ADD `target_fingerprint` text;--> statement-breakpoint
CREATE INDEX `tool_calls_run` ON `tool_calls` (`run_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `alerts_run` ON `alerts` (`run_id`);--> statement-breakpoint
CREATE INDEX `health_checks_run` ON `health_checks` (`run_id`);--> statement-breakpoint
CREATE INDEX `health_issues_run` ON `health_issues` (`run_id`);