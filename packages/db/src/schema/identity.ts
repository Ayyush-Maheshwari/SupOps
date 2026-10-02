import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import type { Role } from '@supops/shared';
import { createdAt, id, ts } from './_common.ts';
import type { RiskPolicy } from './types.ts';

export const users = sqliteTable('users', {
  id: id(),
  email: text('email').notNull().unique(),
  name: text('name').notNull(),
  /** argon2id. Null only if the account is provisioned but not yet activated. */
  passwordHash: text('password_hash'),
  globalRole: text('global_role', { enum: ['owner', 'admin', 'member'] })
    .notNull()
    .default('member'),
  disabledAt: ts('disabled_at'),
  createdAt: createdAt(),
});

/**
 * A Project is the unit that makes this platform project-agnostic: it owns its own
 * targets, credentials, agents, tool allowlist, risk policy and knowledge. Nothing
 * about any particular stack is hardcoded anywhere above this table.
 */
export const projects = sqliteTable('projects', {
  id: id(),
  slug: text('slug').notNull().unique(),
  name: text('name').notNull(),
  description: text('description'),
  /** Appended to the frozen core system prompt. Project-specific context only. */
  systemPromptExtra: text('system_prompt_extra'),
  riskPolicy: text('risk_policy', { mode: 'json' }).$type<RiskPolicy>().notNull(),
  /** Halts every run in the project immediately. Checked before each API call and dispatch. */
  killSwitch: integer('kill_switch', { mode: 'boolean' }).notNull().default(false),
  createdAt: createdAt(),
});

export const projectMembers = sqliteTable(
  'project_members',
  {
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: text('role', {
      enum: ['owner', 'admin', 'operator', 'approver', 'viewer'],
    })
      .notNull()
      .$type<Role>(),
  },
  (t) => [primaryKey({ columns: [t.projectId, t.userId] })],
);
