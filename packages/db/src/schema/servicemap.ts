import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { createdAt, id, ts } from './_common.ts';
import { projects, users } from './identity.ts';
import { targets } from './targets.ts';

/**
 * The service map: what a project is made of (components) and how the parts depend
 * on each other (links), built from several sources and kept honest by the evidence
 * behind every entry. Documents say what should be; registered targets, live
 * connections on machines, Kubernetes and metrics say what is. Agreement raises
 * confidence; disagreement is shown as drift. People edit it like documents.
 */

export const CI_TYPES = [
  'service', 'host', 'database', 'cache', 'queue', 'load_balancer', 'storage',
  'cluster', 'gateway', 'external', 'monitoring', 'other',
] as const;
export type CiType = (typeof CI_TYPES)[number];

export const CI_LINK_KINDS = [
  'depends_on', 'runs_on', 'routes_to', 'replicates_to', 'reads_from', 'writes_to', 'backs_up_to', 'monitors',
] as const;
export type CiLinkKind = (typeof CI_LINK_KINDS)[number];

/** approved: in the map. draft: proposed by a non-admin, waiting. archived: removed (kept for history). */
export type CiStatus = 'approved' | 'draft' | 'archived';

export type CiSource = 'doc' | 'target' | 'network' | 'kubernetes' | 'metrics' | 'manual';

export const ciItems = sqliteTable(
  'ci_items',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    /** Stable identity within the project, e.g. `db-1`, `postgresql@db-1`. */
    key: text('key').notNull(),
    name: text('name').notNull(),
    type: text('type').$type<CiType>().notNull().default('service'),
    env: text('env'),
    description: text('description'),
    /** Other names it is known by: hostnames, IPs, scrape jobs, Kubernetes names. */
    aliases: text('aliases', { mode: 'json' }).$type<string[]>().notNull().$defaultFn(() => []),
    /** Free details: version, port, owner, runbook... */
    attrs: text('attrs', { mode: 'json' }).$type<Record<string, string>>().notNull().$defaultFn(() => ({})),
    /** The registered machine/cluster/connection this is, when there is one. */
    targetId: text('target_id').references(() => targets.id, { onDelete: 'set null' }),
    status: text('status').$type<CiStatus>().notNull().default('approved'),
    /** Edited by a person: automatic sources may add evidence, never change its fields. */
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('ci_items_key').on(t.projectId, t.key), index('ci_items_target').on(t.targetId)],
);

export const ciLinks = sqliteTable(
  'ci_links',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    fromId: text('from_id')
      .notNull()
      .references(() => ciItems.id, { onDelete: 'cascade' }),
    toId: text('to_id')
      .notNull()
      .references(() => ciItems.id, { onDelete: 'cascade' }),
    kind: text('kind').$type<CiLinkKind>().notNull().default('depends_on'),
    /** e.g. "tcp/5432", "HTTP via /api" */
    detail: text('detail'),
    status: text('status').$type<CiStatus>().notNull().default('approved'),
    locked: integer('locked', { mode: 'boolean' }).notNull().default(false),
    createdAt: createdAt(),
    updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
    updatedBy: text('updated_by').references(() => users.id, { onDelete: 'set null' }),
  },
  (t) => [uniqueIndex('ci_links_pair').on(t.projectId, t.fromId, t.toId, t.kind), index('ci_links_to').on(t.toId)],
);

/**
 * Why an entry is in the map: one row per source that says so. A document quote, a
 * connection seen on a machine, a Kubernetes object, a metric. `lastSeenAt` lets
 * observed evidence age out, and is what "documented but not seen" is judged by.
 */
export const ciEvidence = sqliteTable(
  'ci_evidence',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    itemId: text('item_id').references(() => ciItems.id, { onDelete: 'cascade' }),
    linkId: text('link_id').references(() => ciLinks.id, { onDelete: 'cascade' }),
    source: text('source').$type<CiSource>().notNull(),
    /** Which document, machine, cluster or connection -- stable for the same fact. */
    ref: text('ref').notNull(),
    /** A quote from the document, or what was seen ("web-1 -> 10.0.5.11:5432 (postgres)"). */
    detail: text('detail'),
    firstSeenAt: createdAt(),
    lastSeenAt: ts('last_seen_at').notNull().$defaultFn(() => new Date()),
  },
  (t) => [
    uniqueIndex('ci_evidence_fact').on(t.projectId, t.itemId, t.linkId, t.source, t.ref),
    index('ci_evidence_link').on(t.linkId),
    index('ci_evidence_item').on(t.itemId),
  ],
);

/**
 * A change waiting for a person: from a document (what it now says differs from the
 * map), or an edit by someone who is not an admin. Accepting applies it.
 */
export const ciProposals = sqliteTable(
  'ci_proposals',
  {
    id: id(),
    projectId: text('project_id')
      .notNull()
      .references(() => projects.id, { onDelete: 'cascade' }),
    origin: text('origin').$type<'doc' | 'manual'>().notNull(),
    /** The document (id) it came from, or the person's edit. */
    sourceRef: text('source_ref'),
    sourceTitle: text('source_title'),
    op: text('op').$type<'add_item' | 'update_item' | 'remove_item' | 'add_link' | 'update_link' | 'remove_link'>().notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
    /** A quote from the document supporting it. */
    quote: text('quote'),
    status: text('status').$type<'pending' | 'accepted' | 'rejected'>().notNull().default('pending'),
    createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    decidedBy: text('decided_by').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: ts('decided_at'),
  },
  (t) => [index('ci_proposals_project').on(t.projectId, t.status)],
);
