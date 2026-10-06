import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { knowledgeDocs, projects } from '@supops/db';
import { freshDb } from '../engine/harness.test-util.ts';
import { buildKnowledgeContext, ftsQuery, readRunKnowledge, scopeMatches, searchKnowledge, searchRunKnowledge } from './retrieve.ts';

function setup() {
  const db = freshDb();
  const p = db.insert(projects).values({ slug: 'p', name: 'P', riskPolicy: {} as never, createdAt: new Date() }).returning().get();
  const add = (o: Partial<typeof knowledgeDocs.$inferInsert> & { slug: string; title: string; body: string }) =>
    db.insert(knowledgeDocs).values({ projectId: p.id, kind: 'note', status: 'approved', ...o }).returning().get();
  return { db, projectId: p.id, add };
}
const scope = { targetIds: ['t-web'], kinds: ['ssh'], envs: ['prod'] };

test('search terms are quoted, so typed text cannot act as FTS syntax', () => {
  assert.equal(ftsQuery('disk "full" OR NEAR(x)'), '"disk" OR "full" OR "near"');
  assert.equal(ftsQuery('a an to'), null);
});

test('scope: empty matches everything; set dimensions must overlap', () => {
  assert.ok(scopeMatches({}, scope));
  assert.ok(scopeMatches({ envs: ['prod'] }, scope));
  assert.ok(!scopeMatches({ envs: ['dev'] }, scope));
  assert.ok(!scopeMatches({ targetIds: ['other'] }, scope));
});

test('only approved, in-scope documents ever reach a run', () => {
  const { db, projectId, add } = setup();
  add({ slug: 'db-primary', title: 'Primary database', body: 'db-1 is the postgres primary', kind: 'fact', pinned: true });
  add({ slug: 'draft', title: 'Draft note', body: 'postgres replication lag explained', status: 'draft' });
  add({ slug: 'dev-only', title: 'Dev box', body: 'postgres in dev uses port 5433', scope: { envs: ['dev'] } });
  add({ slug: 'lag', title: 'Replication lag', body: 'check pg_stat_replication for postgres lag' });

  const ctx = buildKnowledgeContext(db, { projectId, scope, task: 'postgres replication lag on prod' });
  assert.match(ctx.block, /Primary database \[db-primary\]/);
  assert.match(ctx.block, /Replication lag \[lag/);
  assert.doesNotMatch(ctx.block, /Draft note/, 'drafts never reach a run');
  assert.doesNotMatch(ctx.block, /Dev box/, 'out-of-scope docs are excluded');
  assert.match(ctx.block, /never authorises an action/);
  assert.deepEqual(ctx.used.map((u) => u.via).sort(), ['matched', 'pinned']);
});

test('advisory runs have no targets, so every approved document is in scope', () => {
  const { db, projectId, add } = setup();
  add({ slug: 'dev-only', title: 'Dev box', body: 'postgres in dev uses port 5433', scope: { envs: ['dev'] }, pinned: true });
  add({ slug: 'draft', title: 'Draft note', body: 'postgres port notes', status: 'draft', pinned: true });
  const ctx = buildKnowledgeContext(db, { projectId, scope: 'all', task: 'postgres port' });
  assert.match(ctx.block, /Dev box/);
  assert.doesNotMatch(ctx.block, /Draft note/, 'drafts still never reach a run');
});

test('a chosen runbook is included in full and recorded', () => {
  const { db, projectId, add } = setup();
  const rb = add({ slug: 'disk-full', title: 'Disk full on web', body: '1. df -h\n2. rotate logs\n3. verify', kind: 'runbook' });
  const ctx = buildKnowledgeContext(db, { projectId, scope, task: 'anything', runbookId: rb.id });
  assert.match(ctx.block, /RUNBOOK TO FOLLOW: Disk full on web/);
  assert.match(ctx.block, /2\. rotate logs/);
  assert.deepEqual(ctx.used, [{ docId: rb.id, via: 'runbook' }]);
});

test('nothing relevant means no knowledge block at all', () => {
  const { db, projectId } = setup();
  assert.equal(buildKnowledgeContext(db, { projectId, scope, task: 'hello' }).block, '');
});

test('the full-text index follows edits and deletes', () => {
  const { db, projectId, add } = setup();
  const d = add({ slug: 'n', title: 'Nginx notes', body: 'reload with nginx -s reload' });
  assert.equal(searchKnowledge(db, projectId, 'nginx').length, 1);
  db.update(knowledgeDocs).set({ body: 'apache only now', title: 'Apache notes' }).where(eq(knowledgeDocs.id, d.id)).run();
  assert.equal(searchKnowledge(db, projectId, 'nginx').length, 0);
  assert.equal(searchKnowledge(db, projectId, 'apache').length, 1);
  db.delete(knowledgeDocs).where(eq(knowledgeDocs.id, d.id)).run();
  assert.equal(searchKnowledge(db, projectId, 'apache').length, 0);
});

test('every other approved document is listed in an index the agent can choose from', () => {
  const { db, projectId, add } = setup();
  add({ slug: 'db-primary', title: 'Primary database', body: 'db-1 is the postgres primary', kind: 'fact', pinned: true });
  add({ slug: 'kafka-lag', title: 'Kafka consumer lag', body: 'scale the consumers', kind: 'runbook' });
  add({ slug: 'cert-renewal', title: 'Renew TLS certificates', body: 'certbot renew', kind: 'runbook' });
  add({ slug: 'draft', title: 'Draft note', body: 'x', status: 'draft' });
  add({ slug: 'dev-only', title: 'Dev box', body: 'y', scope: { envs: ['dev'] } });
  const ctx = buildKnowledgeContext(db, { projectId, scope, task: 'something unrelated' });
  assert.match(ctx.block, /read in full with read_knowledge/);
  assert.match(ctx.block, /- Kafka consumer lag \[kafka-lag, runbook\]/);
  assert.match(ctx.block, /- Renew TLS certificates \[cert-renewal, runbook\]/);
  assert.doesNotMatch(ctx.block, /Draft note|Dev box/, 'drafts and out-of-scope documents are not offered');
  assert.doesNotMatch(ctx.block, /\[db-primary, fact\]/, 'a document already given in full is not indexed again');
  assert.ok(!ctx.used.some((u) => u.via === 'matched'), 'listing a document is not using it');
});

test('the knowledge tools read only approved documents in the run scope', () => {
  const { db, projectId, add } = setup();
  add({ slug: 'kafka-lag', title: 'Kafka consumer lag', body: 'Scale the consumer group.', kind: 'runbook' });
  add({ slug: 'draft', title: 'Kafka draft', body: 'kafka secret plan', status: 'draft' });
  add({ slug: 'dev-only', title: 'Kafka on dev', body: 'kafka dev', scope: { envs: ['dev'] } });
  assert.deepEqual(searchRunKnowledge(db, { projectId, scope, query: 'kafka' }).map((h) => h.slug), ['kafka-lag']);
  assert.equal(readRunKnowledge(db, { projectId, scope, slug: 'kafka-lag' })?.body, 'Scale the consumer group.');
  assert.equal(readRunKnowledge(db, { projectId, scope, slug: 'draft' }), null);
  assert.equal(readRunKnowledge(db, { projectId, scope, slug: 'dev-only' }), null);
  assert.equal(readRunKnowledge(db, { projectId, scope: 'all', slug: 'dev-only' })?.title, 'Kafka on dev', 'advisory runs read every approved document');
});
