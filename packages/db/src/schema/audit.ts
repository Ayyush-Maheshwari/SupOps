import { index, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { createdAt, id } from './_common.ts';
import { projects, users } from './identity.ts';

/**
 * Who changed what. Autonomy, agents and platform settings decide what the agents
 * are allowed to do, so every change to them is recorded with its before and after.
 */
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: id(),
    at: createdAt(),
    actorId: text('actor_id').references(() => users.id, { onDelete: 'set null' }),
    actorName: text('actor_name'),
    projectId: text('project_id').references(() => projects.id, { onDelete: 'cascade' }),
    /** e.g. 'project.policy', 'project.settings', 'agent', 'settings.llm', 'settings.retention'. */
    entity: text('entity').notNull(),
    entityId: text('entity_id'),
    action: text('action').notNull(),
    before: text('before', { mode: 'json' }).$type<unknown>(),
    after: text('after', { mode: 'json' }).$type<unknown>(),
  },
  (t) => [index('audit_project_at').on(t.projectId, t.at), index('audit_entity').on(t.entity, t.entityId)],
);
