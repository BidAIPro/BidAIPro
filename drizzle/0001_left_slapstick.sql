ALTER TABLE `valuations` ADD `raw_low_cents` integer;--> statement-breakpoint
ALTER TABLE `valuations` ADD `raw_median_cents` integer;--> statement-breakpoint
ALTER TABLE `valuations` ADD `raw_high_cents` integer;--> statement-breakpoint
ALTER TABLE `valuations` ADD `comparable_median_mileage` integer;--> statement-breakpoint
ALTER TABLE `valuations` ADD `mileage_adjustment_cents` integer;--> statement-breakpoint
ALTER TABLE `valuations` ADD `condition_adjustment_cents` integer;--> statement-breakpoint
ALTER TABLE `valuations` ADD `condition_adjustment_bps` integer;--> statement-breakpoint
ALTER TABLE `valuations` ADD `condition_basis` text;--> statement-breakpoint
ALTER TABLE `valuations` ADD `match_basis` text;