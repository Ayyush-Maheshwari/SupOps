import { integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, id } from './_common.ts';
import { projects } from './identity.ts';
import type { RiskPolicy, RunBudget } from './types.ts';

export const agents = sqliteTable(
  'agents',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    role: text('role').notNull(),
    /** Frozen text. No interpolation -- dynamic context goes in the first user message. */
    systemPrompt: text('system_prompt').notNull(),
    model: text('model'),
    /**
     * May only NARROW the project policy. Validated on write so the hot path can
     * merge without re-checking.
     */
    riskPolicyOverride: text('risk_policy_override', { mode: 'json' })
      .$type<Partial<RiskPolicy> | null>(),
    /**
     * null = every tool the project has enabled. Keep this small (8-12): tool-call
     * accuracy falls off sharply with tool count, especially on small local models.
     */
    toolKeys: text('tool_keys', { mode: 'json' }).$type<string[] | null>(),
    budget: text('budget', { mode: 'json' }).$type<RunBudget>().notNull(),
    enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('agents_project_slug').on(t.projectId, t.slug)],
);
