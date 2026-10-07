import { and, eq, inArray, lt, ne } from 'drizzle-orm';
import { ciEvidence, ciItems, ciLinks } from '@supops/db';
import type { CiLinkKind, CiSource, CiType } from '@supops/db';
import { confidenceOf, isAnonymousName, keyFor, normalizeName, resolveName } from '@supops/core';
import type { Confidence } from '@supops/core';
import { db } from '../context.ts';

/**
 * Writing to the service map. Every automatic source goes through here, so the rules
 * hold everywhere: a component is found by any of its names before a new one is
 * made; a person's edits (locked) are never overwritten, only given more evidence;
 * and every fact records where it came from.
 */

type ItemRow = typeof ciItems.$inferSelect;
type LinkRow = typeof ciLinks.$inferSelect;

export interface ItemInput {
  key?: string;
  name: string;
  type: CiType;
  env?: string | null;
  description?: string | null;
  aliases?: string[];
  attrs?: Record<string, string>;
  targetId?: string | null;
}

export function projectItems(projectId: string, opts: { all?: boolean } = {}): ItemRow[] {
  return db
    .select()
    .from(ciItems)
    .where(and(eq(ciItems.projectId, projectId), ...(opts.all ? [] : [ne(ciItems.status, 'archived')])))
    .all();
}

export function projectLinks(projectId: string, opts: { all?: boolean } = {}): LinkRow[] {
  return db
    .select()
    .from(ciLinks)
    .where(and(eq(ciLinks.projectId, projectId), ...(opts.all ? [] : [ne(ciLinks.status, 'archived')])))
    .all();
}

/** Find a component by any of its names, or by its registered target. */
export function findItem(projectId: string, input: Pick<ItemInput, 'key' | 'name' | 'aliases' | 'targetId'>, items = projectItems(projectId, { all: true })): ItemRow | undefined {
  if (input.targetId) {
    const byTarget = items.find((i) => i.targetId === input.targetId);
    if (byTarget) return byTarget;
    // A registered target is never folded into a component that is another target.
    items = items.filter((i) => !i.targetId);
  }
  if (input.key) {
    const byKey = items.find((i) => i.key === input.key);
    if (byKey) return byKey;
  }
  return [input.name, ...(input.aliases ?? [])].map((n) => resolveName(items, n)).find(Boolean);
}

/** A key nobody else in the project has. */
function freeKey(projectId: string, wanted: string): string {
  const base = keyFor(wanted);
  const taken = new Set(projectItems(projectId, { all: true }).map((i) => i.key));
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`;
}

/**
 * Add or refresh a component from an automatic source. An existing one gains any new
 * names; its other fields change only while no person has edited it.
 */
export function upsertItem(projectId: string, input: ItemInput, evidence: { source: CiSource; ref: string; detail?: string | null }, now = new Date()): ItemRow {
  const existing = findItem(projectId, input);
  let row: ItemRow;
  if (existing) {
    const names = new Set([existing.name, ...existing.aliases].map(normalizeName));
    const newAliases = [input.name, ...(input.aliases ?? [])].filter((a) => a && !isAnonymousName(a) && !names.has(normalizeName(a)));
    const patch: Partial<typeof ciItems.$inferInsert> = {};
    if (newAliases.length) patch.aliases = [...existing.aliases, ...newAliases].slice(0, 40);
    if (!existing.locked) {
      // A more specific type from a better source wins over the generic "service"/"other".
      if (existing.type === 'service' || existing.type === 'other') if (input.type !== existing.type && input.type !== 'service') patch.type = input.type;
      if (input.description && !existing.description) patch.description = input.description;
      if (input.env && !existing.env) patch.env = input.env;
      if (input.attrs && Object.keys(input.attrs).length) patch.attrs = { ...existing.attrs, ...input.attrs };
    }
    if (input.targetId && !existing.targetId) patch.targetId = input.targetId;
    // Seen again: an automatically archived component comes back.
    if (existing.status === 'archived' && !existing.locked && evidence.source !== 'doc') patch.status = 'approved';
    row = Object.keys(patch).length
      ? db.update(ciItems).set({ ...patch, updatedAt: now }).where(eq(ciItems.id, existing.id)).returning().get()
      : existing;
  } else {
    row = db
      .insert(ciItems)
      .values({
        projectId,
        key: freeKey(projectId, input.key ?? input.name),
        name: input.name,
        type: input.type,
        env: input.env ?? null,
        description: input.description ?? null,
        aliases: (input.aliases ?? []).filter((a) => !isAnonymousName(a)),
        attrs: input.attrs ?? {},
        targetId: input.targetId ?? null,
      })
      .returning()
      .get();
  }
  addEvidence(projectId, { itemId: row.id }, evidence, now);
  return row;
}

export function upsertLink(
  projectId: string,
  fromId: string,
  toId: string,
  kind: CiLinkKind,
  evidence: { source: CiSource; ref: string; detail?: string | null },
  opts: { detail?: string | null; now?: Date } = {},
): LinkRow | null {
  if (fromId === toId) return null;
  const now = opts.now ?? new Date();
  const existing = db
    .select()
    .from(ciLinks)
    .where(and(eq(ciLinks.projectId, projectId), eq(ciLinks.fromId, fromId), eq(ciLinks.toId, toId), eq(ciLinks.kind, kind)))
    .get();
  let row: LinkRow;
  if (existing) {
    const patch: Partial<typeof ciLinks.$inferInsert> = {};
    if (opts.detail && !existing.detail && !existing.locked) patch.detail = opts.detail;
    if (existing.status === 'archived' && !existing.locked && evidence.source !== 'doc') patch.status = 'approved';
    row = Object.keys(patch).length ? db.update(ciLinks).set({ ...patch, updatedAt: now }).where(eq(ciLinks.id, existing.id)).returning().get() : existing;
  } else {
    row = db.insert(ciLinks).values({ projectId, fromId, toId, kind, detail: opts.detail ?? null }).returning().get();
  }
  addEvidence(projectId, { linkId: row.id }, evidence, now);
  return row;
}

/** Record (or refresh) that a source supports an entry. */
export function addEvidence(projectId: string, on: { itemId?: string; linkId?: string }, e: { source: CiSource; ref: string; detail?: string | null }, now = new Date()): void {
  const where = and(
    eq(ciEvidence.projectId, projectId),
    on.itemId ? eq(ciEvidence.itemId, on.itemId) : eq(ciEvidence.linkId, on.linkId!),
    eq(ciEvidence.source, e.source),
    eq(ciEvidence.ref, e.ref),
  );
  const hit = db.select({ id: ciEvidence.id }).from(ciEvidence).where(where).get();
  if (hit) db.update(ciEvidence).set({ lastSeenAt: now, ...(e.detail ? { detail: e.detail.slice(0, 500) } : {}) }).where(eq(ciEvidence.id, hit.id)).run();
  else db.insert(ciEvidence).values({ projectId, itemId: on.itemId ?? null, linkId: on.linkId ?? null, source: e.source, ref: e.ref, detail: e.detail?.slice(0, 500) ?? null, firstSeenAt: now, lastSeenAt: now }).run();
}

/** Remove one source's support from entries. */
export function dropEvidence(projectId: string, on: { itemIds?: string[]; linkIds?: string[] }, source: CiSource, ref: string): void {
  if (on.itemIds?.length) db.delete(ciEvidence).where(and(eq(ciEvidence.projectId, projectId), inArray(ciEvidence.itemId, on.itemIds), eq(ciEvidence.source, source), eq(ciEvidence.ref, ref))).run();
  if (on.linkIds?.length) db.delete(ciEvidence).where(and(eq(ciEvidence.projectId, projectId), inArray(ciEvidence.linkId, on.linkIds), eq(ciEvidence.source, source), eq(ciEvidence.ref, ref))).run();
}

/**
 * Tidy after discovery: live evidence nobody has seen for `maxAgeMs` goes, and an
 * automatic entry with no evidence left is archived (a person's entry never is).
 */
export function pruneObserved(projectId: string, maxAgeMs: number, now = Date.now()): { archivedItems: number; archivedLinks: number } {
  db.delete(ciEvidence)
    .where(and(eq(ciEvidence.projectId, projectId), inArray(ciEvidence.source, ['network', 'kubernetes', 'metrics']), lt(ciEvidence.lastSeenAt, new Date(now - maxAgeMs))))
    .run();
  const ev = db.select({ itemId: ciEvidence.itemId, linkId: ciEvidence.linkId }).from(ciEvidence).where(eq(ciEvidence.projectId, projectId)).all();
  const withItem = new Set(ev.map((e) => e.itemId).filter(Boolean));
  const withLink = new Set(ev.map((e) => e.linkId).filter(Boolean));
  let archivedLinks = 0;
  for (const l of projectLinks(projectId)) {
    if (!l.locked && !withLink.has(l.id)) {
      db.update(ciLinks).set({ status: 'archived' }).where(eq(ciLinks.id, l.id)).run();
      archivedLinks++;
    }
  }
  let archivedItems = 0;
  for (const i of projectItems(projectId)) {
    if (!i.locked && !withItem.has(i.id)) {
      db.update(ciItems).set({ status: 'archived' }).where(eq(ciItems.id, i.id)).run();
      archivedItems++;
    }
  }
  return { archivedItems, archivedLinks };
}

// ---- reading -----------------------------------------------------------------------

export interface EvidenceView {
  id: string;
  source: CiSource;
  ref: string;
  detail: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

/** The map with how sure each entry is. `covered`: components a machine scan looked at recently. */
export function mapWithConfidence(projectId: string): {
  items: Array<ItemRow & { confidence: Confidence; evidence: EvidenceView[] }>;
  links: Array<LinkRow & { confidence: Confidence; evidence: EvidenceView[]; alsoSupportedBy: CiSource[]; supersededBy: string | null }>;
} {
  const items = projectItems(projectId).filter((i) => i.status !== 'draft');
  const links = projectLinks(projectId).filter((l) => l.status !== 'draft');
  const ev = db.select().from(ciEvidence).where(eq(ciEvidence.projectId, projectId)).all();
  const now = Date.now();
  const byItem = new Map<string, EvidenceView[]>();
  const byLink = new Map<string, EvidenceView[]>();
  for (const e of ev) {
    const v = { id: e.id, source: e.source, ref: e.ref, detail: e.detail, firstSeenAt: e.firstSeenAt, lastSeenAt: e.lastSeenAt };
    if (e.itemId) byItem.set(e.itemId, [...(byItem.get(e.itemId) ?? []), v]);
    if (e.linkId) byLink.set(e.linkId, [...(byLink.get(e.linkId) ?? []), v]);
  }
  // A machine scan "covers" a component on it: the host itself, and what runs on it.
  const scanned = new Set(items.filter((i) => (byItem.get(i.id) ?? []).some((e) => e.source === 'network' && e.ref.startsWith('scan:') && now - e.lastSeenAt.getTime() < 3 * 86_400_000)).map((i) => i.id));
  const hostOf = new Map<string, string>();
  for (const l of links) if (l.kind === 'runs_on') hostOf.set(l.fromId, l.toId);
  const covered = (id: string) => scanned.has(id) || scanned.has(hostOf.get(id) ?? '');
  const lite = (list: EvidenceView[]) => list.map((e) => ({ source: e.source, lastSeenAt: e.lastSeenAt.getTime() }));

  // "a depends on db-1" and "a depends on postgresql on db-1" are the same connection
  // told at two levels: each one's evidence counts for the other. Both ends are
  // lifted to their host (a service on a machine stands for the machine too).
  const DEP: string[] = ['depends_on', 'reads_from', 'writes_to'];
  const up = (id: string) => [id, ...(hostOf.has(id) ? [hostOf.get(id)!] : [])];
  const pairKey = (a: string, b: string) => `${a}>${b}`;
  const byPair = new Map<string, EvidenceView[]>();
  for (const l of links) {
    if (!DEP.includes(l.kind)) continue;
    for (const a of up(l.fromId)) for (const b of up(l.toId)) byPair.set(pairKey(a, b), [...(byPair.get(pairKey(a, b)) ?? []), ...(byLink.get(l.id) ?? [])]);
  }
  const corroborating = (l: LinkRow): EvidenceView[] => {
    if (!DEP.includes(l.kind)) return [];
    const out: EvidenceView[] = [];
    for (const a of up(l.fromId)) for (const b of up(l.toId)) out.push(...(byPair.get(pairKey(a, b)) ?? []));
    // Only what the link does not already have, from other sources.
    const own = new Set((byLink.get(l.id) ?? []).map((e) => e.id));
    return out.filter((e) => !own.has(e.id));
  };

  return {
    items: items.map((i) => ({ ...i, evidence: byItem.get(i.id) ?? [], confidence: confidenceOf(lite(byItem.get(i.id) ?? []), { now, discoveryCovered: covered(i.id) }) })),
    links: links.map((l) => {
      const own = byLink.get(l.id) ?? [];
      const also = corroborating(l);
      // A host-level connection that a service-level one spells out more exactly.
      const supersededBy = DEP.includes(l.kind)
        ? links.find((x) => x.id !== l.id && DEP.includes(x.kind) && up(x.fromId).includes(l.fromId) && x.toId !== l.toId && hostOf.get(x.toId) === l.toId)?.id ?? null
        : null;
      return {
        ...l,
        supersededBy,
        evidence: own,
        // Evidence for the same connection at the other level, shown as such.
        alsoSupportedBy: [...new Set(also.map((e) => e.source))],
        // A documented connection from a scanned machine that the scan did not see is drift.
        confidence: confidenceOf(lite([...own, ...also]), { now, discoveryCovered: covered(l.fromId) && DEP.includes(l.kind) }),
      };
    }),
  };
}
