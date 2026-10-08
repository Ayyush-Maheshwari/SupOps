-- The service map is now built from documents, diagrams and people; live sources only
-- confirm what is on it. Remove what live discovery added on its own: entries no
-- document supports and no person touched. Their links and evidence go with them.
DELETE FROM `ci_links` WHERE `locked` = 0 AND `id` NOT IN (SELECT `link_id` FROM `ci_evidence` WHERE `link_id` IS NOT NULL AND `source` IN ('doc', 'manual'));
--> statement-breakpoint
DELETE FROM `ci_items` WHERE `locked` = 0 AND `id` NOT IN (SELECT `item_id` FROM `ci_evidence` WHERE `item_id` IS NOT NULL AND `source` IN ('doc', 'manual'));
--> statement-breakpoint
DELETE FROM `ci_links` WHERE `from_id` NOT IN (SELECT `id` FROM `ci_items`) OR `to_id` NOT IN (SELECT `id` FROM `ci_items`);
--> statement-breakpoint
DELETE FROM `ci_evidence` WHERE (`item_id` IS NOT NULL AND `item_id` NOT IN (SELECT `id` FROM `ci_items`)) OR (`link_id` IS NOT NULL AND `link_id` NOT IN (SELECT `id` FROM `ci_links`));
