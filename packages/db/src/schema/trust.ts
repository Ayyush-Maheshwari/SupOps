import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';

export type TrustedToolKey = 'ssh_exec' | 'k8s_kubectl';
export type TrustMatchKind = 'exact' | 'folder';
export type TrustEnv = 'dev' | 'staging' | 'prod';

/**
 * Commands a person trusted: a standing approval. A matching command still carries
 * its honest risk tier; only the wait for a human is skipped, because a human already
 * said yes to exactly this. Forbidden commands can never be trusted, automatic
 * (unattended) runs ignore trust, and production is covered only when a rule says so.
 */
export const trustedCommands = sqliteTable(
  'trusted_commands',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    toolKey: text('tool_key').$type<TrustedToolKey>().notNull(),
    matchKind: text('match_kind').$type<TrustMatchKind>().notNull(),
    /** The command as trusted, normalised: compared exactly for `exact` rules, shown for both. */
    canonical: text('canonical').notNull(),
    /** For `folder` rules: the program, its flags, the folder and the file-name pattern. */
    program: text('program'),
    flags: text('flags', { mode: 'json' }).$type<string[]>(),
    folder: text('folder'),
    glob: text('glob'),
    envs: text('envs', { mode: 'json' }).$type<TrustEnv[]>().notNull(),
    status: text('status').$type<'active' | 'suggested' | 'revoked'>().notNull().default('active'),
    note: text('note'),
    /** The tool call it was trusted from, when there was one. */
    sourceToolCallId: text('source_tool_call_id'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
    approvedAt: ts('approved_at'),
    revokedBy: text('revoked_by').references(() => users.id, { onDelete: 'set null' }),
    revokedAt: ts('revoked_at'),
    hits: integer('hits').notNull().default(0),
    lastUsedAt: ts('last_used_at'),
  },
  (t) => [index('trusted_commands_project').on(t.projectId, t.status)],
);
