CREATE TABLE `deal_board_snapshot_chunks` (
	`id` text PRIMARY KEY NOT NULL,
	`snapshot_id` text NOT NULL,
	`chunk_index` integer NOT NULL,
	`item_count` integer NOT NULL,
	`payload_count` integer DEFAULT 0 NOT NULL,
	`active_count` integer DEFAULT 0 NOT NULL,
	`contains_gsa_auctions` integer DEFAULT false NOT NULL,
	`contains_gsa_fleet` integer DEFAULT false NOT NULL,
	`payload_json` text NOT NULL,
	`board_json` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `deal_board_snapshots`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_deal_board_snapshot_chunks_snapshot_index` ON `deal_board_snapshot_chunks` (`snapshot_id`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `idx_deal_board_snapshot_chunks_snapshot_active` ON `deal_board_snapshot_chunks` (`snapshot_id`,`active_count`);--> statement-breakpoint
CREATE TABLE `deal_board_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`cache_key` text DEFAULT 'deal-board' NOT NULL,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`generated_at` text NOT NULL,
	`refreshed_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`item_count` integer DEFAULT 0 NOT NULL,
	`metadata_json` text DEFAULT '{}' NOT NULL,
	`opportunity_index_json` text DEFAULT '{}' NOT NULL,
	`error_code` text,
	`error_message` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_deal_board_snapshots_cache_status_generated` ON `deal_board_snapshots` (`cache_key`,`status`,`generated_at`);--> statement-breakpoint
CREATE INDEX `idx_deal_board_snapshots_expires` ON `deal_board_snapshots` (`expires_at`);