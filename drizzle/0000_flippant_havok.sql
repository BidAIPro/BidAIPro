CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`auction_id` text NOT NULL,
	`watchlist_entry_id` text,
	`alert_type` text NOT NULL,
	`threshold_cents` integer,
	`threshold_score` integer,
	`lead_seconds` integer,
	`channel` text DEFAULT 'in-app' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_triggered_at` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`watchlist_entry_id`) REFERENCES `watchlist_entries`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_alerts_owner_status` ON `alerts` (`owner_key`,`status`);--> statement-breakpoint
CREATE INDEX `idx_alerts_auction_status` ON `alerts` (`auction_id`,`status`);--> statement-breakpoint
CREATE TABLE `auctions` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text DEFAULT 'gsa-auctions' NOT NULL,
	`external_id` text NOT NULL,
	`sale_lot_number` text NOT NULL,
	`title` text NOT NULL,
	`canonical_url` text NOT NULL,
	`status` text NOT NULL,
	`currency` text DEFAULT 'USD' NOT NULL,
	`current_bid_cents` integer,
	`bidder_count` integer,
	`bid_increment_cents` integer,
	`reserve_status` text,
	`starts_at` text,
	`ends_at` text,
	`ended_at` text,
	`final_bid_cents` integer,
	`final_status` text,
	`seller_agency` text,
	`city` text NOT NULL,
	`state` text NOT NULL,
	`postal_code` text NOT NULL,
	`address` text,
	`pickup_terms` text,
	`payment_terms` text,
	`removal_deadline` text,
	`primary_image_url` text,
	`first_seen_at` text NOT NULL,
	`last_seen_at` text NOT NULL,
	`last_checked_at` text NOT NULL,
	`price_changed_at` text,
	`raw_payload_hash` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_auctions_source_external` ON `auctions` (`source_key`,`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `uq_auctions_source_lot` ON `auctions` (`source_key`,`sale_lot_number`);--> statement-breakpoint
CREATE INDEX `idx_auctions_status_ends_at` ON `auctions` (`status`,`ends_at`);--> statement-breakpoint
CREATE INDEX `idx_auctions_source_last_checked` ON `auctions` (`source_key`,`last_checked_at`);--> statement-breakpoint
CREATE TABLE `bid_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`auction_id` text NOT NULL,
	`source_check_id` text,
	`observed_at` text NOT NULL,
	`current_bid_cents` integer,
	`bidder_count` integer,
	`status` text NOT NULL,
	`ends_at` text,
	`extension_count` integer DEFAULT 0 NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`source_check_id`) REFERENCES `source_checks`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_bid_observations_auction_observed` ON `bid_observations` (`auction_id`,`observed_at`);--> statement-breakpoint
CREATE INDEX `idx_bid_observations_auction_time` ON `bid_observations` (`auction_id`,`observed_at`);--> statement-breakpoint
CREATE TABLE `comparable_links` (
	`id` text PRIMARY KEY NOT NULL,
	`subject_auction_id` text NOT NULL,
	`comparable_sale_id` text NOT NULL,
	`purpose` text NOT NULL,
	`match_score_bps` integer NOT NULL,
	`match_reason` text NOT NULL,
	`adjustment_cents` integer DEFAULT 0 NOT NULL,
	`weight_bps` integer DEFAULT 10000 NOT NULL,
	`as_of` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`subject_auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`comparable_sale_id`) REFERENCES `comparable_sales`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_comparable_links_subject_comp_purpose` ON `comparable_links` (`subject_auction_id`,`comparable_sale_id`,`purpose`);--> statement-breakpoint
CREATE INDEX `idx_comparable_links_subject_purpose` ON `comparable_links` (`subject_auction_id`,`purpose`);--> statement-breakpoint
CREATE TABLE `comparable_sales` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`external_id` text NOT NULL,
	`source_auction_id` text,
	`canonical_url` text,
	`normalized_vehicle_key` text NOT NULL,
	`vin` text,
	`year` integer NOT NULL,
	`make` text NOT NULL,
	`model` text NOT NULL,
	`trim` text,
	`drivetrain` text,
	`mileage` integer,
	`condition` text,
	`title_status` text,
	`operability` text,
	`city` text,
	`state` text,
	`closed_high_bid_cents` integer NOT NULL,
	`awarded_price_cents` integer,
	`award_status` text DEFAULT 'unknown' NOT NULL,
	`reserve_status` text,
	`currency` text DEFAULT 'USD' NOT NULL,
	`outcome_status` text NOT NULL,
	`ended_at` text NOT NULL,
	`outcome_observed_at` text NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`source_auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_comparable_sales_source_external` ON `comparable_sales` (`source_key`,`external_id`);--> statement-breakpoint
CREATE INDEX `idx_comparable_sales_vehicle_ended` ON `comparable_sales` (`normalized_vehicle_key`,`ended_at`);--> statement-breakpoint
CREATE TABLE `deal_assessments` (
	`id` text PRIMARY KEY NOT NULL,
	`auction_id` text NOT NULL,
	`valuation_id` text,
	`forecast_id` text,
	`calculated_at` text NOT NULL,
	`model_version` text NOT NULL,
	`status` text NOT NULL,
	`tier` integer NOT NULL,
	`score` integer NOT NULL,
	`confidence_bps` integer NOT NULL,
	`conservative_value_cents` integer,
	`expected_close_cents` integer,
	`safe_max_bid_cents` integer,
	`break_even_bid_cents` integer,
	`projected_profit_cents` integer,
	`downside_profit_cents` integer,
	`roi_bps` integer,
	`discount_to_value_bps` integer,
	`probability_profitable_bps` integer,
	`probability_win_under_ceiling_bps` integer,
	`purchase_bid_cents` integer NOT NULL,
	`buyer_premium_cents` integer NOT NULL,
	`purchase_tax_cents` integer NOT NULL,
	`transport_cents` integer NOT NULL,
	`title_registration_cents` integer NOT NULL,
	`inspection_cents` integer NOT NULL,
	`repairs_cents` integer NOT NULL,
	`storage_cents` integer NOT NULL,
	`selling_fees_cents` integer NOT NULL,
	`risk_reserve_cents` integer NOT NULL,
	`total_acquisition_cents` integer NOT NULL,
	`total_exit_costs_cents` integer NOT NULL,
	`total_all_in_cents` integer NOT NULL,
	`warnings_json` text DEFAULT '[]' NOT NULL,
	`reason_codes_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`valuation_id`) REFERENCES `valuations`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`forecast_id`) REFERENCES `forecasts`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_deal_assessments_auction_calculated` ON `deal_assessments` (`auction_id`,`calculated_at`);--> statement-breakpoint
CREATE INDEX `idx_deal_assessments_status_score` ON `deal_assessments` (`status`,`score`);--> statement-breakpoint
CREATE TABLE `forecasts` (
	`id` text PRIMARY KEY NOT NULL,
	`auction_id` text NOT NULL,
	`as_of` text NOT NULL,
	`horizon_seconds` integer NOT NULL,
	`current_bid_at_forecast_cents` integer NOT NULL,
	`status` text NOT NULL,
	`model_version` text NOT NULL,
	`method` text NOT NULL,
	`low_cents` integer,
	`expected_cents` integer,
	`high_cents` integer,
	`confidence_bps` integer DEFAULT 0 NOT NULL,
	`sample_size` integer DEFAULT 0 NOT NULL,
	`exact_model_count` integer DEFAULT 0 NOT NULL,
	`curve_count` integer DEFAULT 0 NOT NULL,
	`evidence_ids_json` text DEFAULT '[]' NOT NULL,
	`evidence_hash` text,
	`provenance` text NOT NULL,
	`reason_codes_json` text DEFAULT '[]' NOT NULL,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_forecasts_auction_as_of_model` ON `forecasts` (`auction_id`,`as_of`,`model_version`);--> statement-breakpoint
CREATE INDEX `idx_forecasts_auction_as_of` ON `forecasts` (`auction_id`,`as_of`);--> statement-breakpoint
CREATE TABLE `refresh_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`auction_id` text,
	`source_key` text DEFAULT 'gsa-auctions' NOT NULL,
	`job_type` text NOT NULL,
	`cadence_bucket` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`due_at` text NOT NULL,
	`locked_until` text,
	`lease_owner` text,
	`attempt_count` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`last_attempt_at` text,
	`completed_at` text,
	`last_error` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_refresh_jobs_status_due` ON `refresh_jobs` (`status`,`due_at`);--> statement-breakpoint
CREATE INDEX `idx_refresh_jobs_auction_type` ON `refresh_jobs` (`auction_id`,`job_type`);--> statement-breakpoint
CREATE INDEX `idx_refresh_jobs_lock` ON `refresh_jobs` (`locked_until`);--> statement-breakpoint
CREATE TABLE `source_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`source_key` text NOT NULL,
	`auction_id` text,
	`scope` text NOT NULL,
	`checked_at` text NOT NULL,
	`success` integer NOT NULL,
	`status_code` integer,
	`latency_ms` integer,
	`result_count` integer,
	`expected_result_count` integer,
	`coverage_status` text DEFAULT 'unknown' NOT NULL,
	`error_code` text,
	`error_message` text,
	`response_hash` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `idx_source_checks_source_checked` ON `source_checks` (`source_key`,`checked_at`);--> statement-breakpoint
CREATE INDEX `idx_source_checks_auction_checked` ON `source_checks` (`auction_id`,`checked_at`);--> statement-breakpoint
CREATE TABLE `valuations` (
	`id` text PRIMARY KEY NOT NULL,
	`auction_id` text NOT NULL,
	`vehicle_id` text NOT NULL,
	`provider` text NOT NULL,
	`provider_kind` text NOT NULL,
	`provider_record_id` text,
	`status` text NOT NULL,
	`valuation_type` text NOT NULL,
	`region_postal_code` text,
	`input_mileage` integer,
	`input_condition` text,
	`low_cents` integer,
	`median_cents` integer,
	`high_cents` integer,
	`confidence_bps` integer DEFAULT 0 NOT NULL,
	`sample_size` integer DEFAULT 0 NOT NULL,
	`as_of` text NOT NULL,
	`expires_at` text,
	`source_url` text,
	`provenance_note` text NOT NULL,
	`raw_payload_hash` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`vehicle_id`) REFERENCES `vehicles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `idx_valuations_vehicle_as_of` ON `valuations` (`vehicle_id`,`as_of`);--> statement-breakpoint
CREATE INDEX `idx_valuations_auction_status_as_of` ON `valuations` (`auction_id`,`status`,`as_of`);--> statement-breakpoint
CREATE TABLE `vehicles` (
	`id` text PRIMARY KEY NOT NULL,
	`auction_id` text NOT NULL,
	`vin` text,
	`normalized_vehicle_key` text NOT NULL,
	`year` integer NOT NULL,
	`make` text NOT NULL,
	`model` text NOT NULL,
	`trim` text,
	`series` text,
	`body_style` text,
	`mileage` integer,
	`odometer_status` text,
	`engine` text,
	`cylinders` integer,
	`fuel_type` text,
	`transmission` text,
	`drivetrain` text,
	`exterior_color` text,
	`interior_color` text,
	`title_status` text,
	`condition` text DEFAULT 'unknown' NOT NULL,
	`operability` text DEFAULT 'unknown' NOT NULL,
	`keys_count` integer,
	`condition_description` text,
	`damage_flags_json` text DEFAULT '[]' NOT NULL,
	`feature_flags_json` text DEFAULT '[]' NOT NULL,
	`service_records_json` text DEFAULT '[]' NOT NULL,
	`source_description` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_vehicles_auction_id` ON `vehicles` (`auction_id`);--> statement-breakpoint
CREATE INDEX `idx_vehicles_normalized_key_mileage` ON `vehicles` (`normalized_vehicle_key`,`mileage`);--> statement-breakpoint
CREATE INDEX `idx_vehicles_vin` ON `vehicles` (`vin`);--> statement-breakpoint
CREATE TABLE `watchlist_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_key` text NOT NULL,
	`auction_id` text NOT NULL,
	`personal_max_bid_cents` integer,
	`notes` text,
	`created_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	`updated_at` text DEFAULT CURRENT_TIMESTAMP NOT NULL,
	FOREIGN KEY (`auction_id`) REFERENCES `auctions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `uq_watchlist_owner_auction` ON `watchlist_entries` (`owner_key`,`auction_id`);--> statement-breakpoint
CREATE INDEX `idx_watchlist_owner_created` ON `watchlist_entries` (`owner_key`,`created_at`);
--> statement-breakpoint
PRAGMA optimize;
