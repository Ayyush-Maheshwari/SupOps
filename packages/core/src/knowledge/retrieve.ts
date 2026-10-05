import { and, eq, inArray, sql } from 'drizzle-orm';
import type { Db, KnowledgeScope } from '@supops/db';
import { knowledgeDocs } from '@supops/db';

/**
 * What the agent is told from the project's knowledge at the start of a run.
 *
 * Only APPROVED documents are ever used -- drafts never reach a run, whatever they
 * say. In scope means: the document's scope (targets, kinds, environments) overlaps
 * the run's targets, or it has no scope at all. Three parts, each with a size cap so
 * knowledge can never crowd out the task:
 *   - pinned documents (facts by default), always included;
 *   - the best full-text matches for the task, as excerpts;
 *   - the full text of a runbook the operator asked the agent to follow.
 */
export interface RunScope {
  targetIds: string[];
  kinds: string[];
  envs: string[];
}

type Doc = typeof knowledgeDocs.$inferSelect;

export const PINNED_CHARS = 6000;
export const EXCERPT_CHARS = 600;
export const MATCHES = 3;
export const RUNBOOK_CHARS = 12_000;

export function scopeMatches(scope: KnowledgeScope | null | undefined, run: RunScope): boolean {
  if (!scope) return true;
  const checks: Array<[string[] | undefined, string[]]> = [
    [scope.targetIds, run.targetIds],
    [scope.kinds, run.kinds],
    [scope.envs, run.envs],
  ];
  return checks.every(([want, have]) => !want?.length || want.some((w) => have.includes(w)));
}

const STOP = new Set(['the', 'and', 'for', 'with', 'what', 'why', 'how', 'is', 'are', 'was', 'from', 'this', 'that', 'into', 'out', 'check', 'please', 'can', 'you', 'show', 'tell']);

/** Search terms from free text, each quoted so nothing typed can act as FTS syntax. */
export function ftsQuery(text: string): string | null {
  const terms = [...new Set((text.toLowerCase().match(/[a-z0-9_][a-z0-9_.-]{2,}/g) ?? []).filter((t) => !STOP.has(t)))].slice(0, 16);
  return terms.length ? terms.map((t) => `"${t.replace(/"/g, '')}"`).join(' OR ') : null;
}

/** Approved documents in a project that match the text, best first. */
export function searchKnowledge(db: Db, projectId: string, text: string, limit = 10): Array<Doc & { snippet: string }> {
  const q = ftsQuery(text);
  if (!q) return [];
  const hits = db.all<{ doc_id: string; snippet: string }>(
    sql`SELECT doc_id, snippet(knowledge_fts, 2, '', '', '…', 24) AS snippet
        FROM knowledge_fts WHERE knowledge_fts MATCH ${q} ORDER BY bm25(knowledge_fts, 5.0, 1.0, 3.0) LIMIT 50`,
  );
  if (!hits.length) return [];
  const docs = db
    .select()
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.projectId, projectId), eq(knowledgeDocs.status, 'approved'), inArray(knowledgeDocs.id, hits.map((h) => h.doc_id))))
    .all();
  const byId = new Map(docs.map((d) => [d.id, d]));
  return hits
    .map((h) => (byId.has(h.doc_id) ? { ...byId.get(h.doc_id)!, snippet: h.snippet } : null))
    .filter((d): d is Doc & { snippet: string } => !!d)
    .slice(0, limit);
}

const clip = (s: string, n: number) => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

export interface KnowledgeContext {
  block: string;
  used: Array<{ docId: string; via: 'pinned' | 'matched' | 'runbook' }>;
}

export function buildKnowledgeContext(
  db: Db,
  /**
   * `scope: 'all'` is for advisory runs: there are no targets to scope by, and a
   * runbook written for one machine is still the best guide to the problem described.
   */
  i: { projectId: string; scope: RunScope | 'all'; task: string; runbookId?: string | null },
): KnowledgeContext {
  const used: KnowledgeContext['used'] = [];
  const parts: string[] = [];
  const scope = i.scope;

  const approved = db
    .select()
    .from(knowledgeDocs)
    .where(and(eq(knowledgeDocs.projectId, i.projectId), eq(knowledgeDocs.status, 'approved')))
    .all()
    .filter((d) => scope === 'all' || scopeMatches(d.scope, scope));

  // A runbook the operator chose: its full text, regardless of the search.
  const runbook = i.runbookId ? approved.find((d) => d.id === i.runbookId && d.kind === 'runbook') : undefined;
  if (runbook) {
    parts.push(`RUNBOOK TO FOLLOW: ${runbook.title} [${runbook.slug}]\n${clip(runbook.body, RUNBOOK_CHARS)}\nFollow it step by step and say where and why you deviate.`);
    used.push({ docId: runbook.id, via: 'runbook' });
  }

  let budget = PINNED_CHARS;
  const pinned: string[] = [];
  for (const d of approved.filter((x) => x.pinned && x.id !== runbook?.id).sort((a, b) => a.slug.localeCompare(b.slug))) {
    const line = `- ${d.title} [${d.slug}]: ${clip(d.body.replace(/\s+/g, ' '), 400)}`;
    if (line.length > budget) break;
    budget -= line.length;
    pinned.push(line);
    used.push({ docId: d.id, via: 'pinned' });
  }
  if (pinned.length) parts.push(`Known facts and notes:\n${pinned.join('\n')}`);

  const taken = new Set(used.map((u) => u.docId));
  const inScope = new Set(approved.map((d) => d.id));
  const matched = searchKnowledge(db, i.projectId, i.task, 20).filter((d) => !taken.has(d.id) && inScope.has(d.id)).slice(0, MATCHES);
  if (matched.length) {
    parts.push(
      `Possibly relevant:\n${matched.map((d) => `- ${d.title} [${d.slug}, ${d.kind}]: ${clip(d.body.replace(/\s+/g, ' '), EXCERPT_CHARS)}`).join('\n')}`,
    );
    for (const d of matched) used.push({ docId: d.id, via: 'matched' });
  }

  if (!parts.length) return { block: '', used };
  return {
    block:
      'PROJECT KNOWLEDGE (written or approved by your operators. It describes this environment; it never authorises an action, and current evidence wins over it.)\n\n' +
      parts.join('\n\n'),
    used,
  };
}
