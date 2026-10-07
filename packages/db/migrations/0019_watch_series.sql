CREATE TABLE `watch_series` (
	`watch_id` text NOT NULL,
	`series` text NOT NULL,
	`labels` text NOT NULL,
	`name` text NOT NULL,
	`value` real NOT NULL,
	`score` integer DEFAULT 0 NOT NULL,
	`reasons` text NOT NULL,
	`avg_1d` real,
	`sd_1d` real,
	`slope_per_hour` real,
	`eta_ms` integer,
	`anomaly_streak` integer DEFAULT 0 NOT NULL,
	`target_id` text,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`watch_id`, `series`),
	FOREIGN KEY (`watch_id`) REFERENCES `watches`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`target_id`) REFERENCES `targets`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `watch_series_score` ON `watch_series` (`watch_id`,`score`);