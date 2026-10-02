import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { RiskTier } from '@supops/shared';
import { createdAt, id, ts } from './_common.ts';
import { projects } from './identity.ts';
import { targets } from './targets.ts';

/**
 * Enforcement the engine learned from what happened in earlier runs.
 *
 * Rules only ever make things stricter: a command humans keep denying, or a change
 * that keeps failing, needs more approval next time (or is blocked). They are built
 * only from facts the engine recorded -- who denied what, and exit codes -- never from
 * anything a model wrote. Each is visible, explained and reversible.
 */
export const learnedRules = sqliteTable(
  'learned_rules',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    signature: text('signature').notNull(),
    /** A readable example of the action, for the UI. */
    example: text('example').notNull(),
    /** null = every target in the project. */
    targetId: text('target_id').references(() => targets.id, { onDelete: 'cascade' }),
    effect: text('effect').$type<'raise' | 'block'>().notNull(),
    /** For `raise`: the action needs at least this tier. */
    minTier: text('min_tier').$type<RiskTier>().notNull(),
    trigger: text('trigger').$type<'denied' | 'failed_change' | 'manual'>().notNull(),
    reason: text('reason').notNull(),
    /** Copied in, so the rule still explains itself after the runs are cleaned up. */
    evidenceJson: text('evidence_json', { mode: 'json' }).$type<Array<{ runId: string | null; at: number; by: string | null; comment: string | null; state: string }>>().notNull(),
    status: text('status').$type<'active' | 'disabled'>().notNull().default('active'),
    hits: integer('hits').notNull().default(0),
    lastHitAt: ts('last_hit_at'),
    /** Set by "reset learned rules", so the reset can be undone. */
    resetBatch: text('reset_batch'),
    createdAt: createdAt(),
    updatedAt: ts('updated_at'),
  },
  (t) => [index('learned_rules_project').on(t.projectId, t.status, t.signature)],
);
