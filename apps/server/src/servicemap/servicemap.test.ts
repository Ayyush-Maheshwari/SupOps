import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-map-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db } = await import('../context.ts');
const { ciEvidence, ciItems, ciLinks, incidents, projects, targets, DEFAULT_RISK_POLICY } = await import('@supops/db');
const { and, eq } = await import('drizzle-orm');
const { addEvidence, findItem, mapWithConfidence, pruneObserved, upsertItem, upsertLink } = await import('./store.ts');
const { applyChange } = await import('./docs.ts');
const { fromMetrics, fromTargets } = await import('./discover.ts');
const { incidentMapView, mapRelation, serviceMapContext } = await import('./context.ts');

let server: Server;
let base = '';
before(async () => {
  server = createServer((req, res) => {
    const q = new URL(req.url!, 'http://x').searchParams.get('query') ?? '';
    const vec = (rows: Array<[Record<string, string>, number]>) => ({ status: 'success', data: { resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [0, String(v)] })) } });
    res.writeHead(200, { 'content-type': 'application/json' });
    if (q === 'count by (job, instance) (up)') return res.end(JSON.stringify(vec([[{ job: 'billing-node-metrics', instance: '10.0.7.5:9100' }, 1], [{ job: 'node', instance: 'web-1:9100' }, 1]])));
    if (q === 'count by (instance, job) (pg_up)') return res.end(JSON.stringify(vec([[{ instance: '10.0.7.5:9187', job: 'billing-node-metrics' }, 1]])));
    if (q.includes('traces_service_graph_request_total')) return res.end(JSON.stringify(vec([[{ client: 'checkout', server: 'payments' }, 2.5]])));
    res.end(JSON.stringify(vec([])));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

function seed() {
  const project = db.insert(projects).values({ slug: `p-${randomBytes(3).toString('hex')}`, name: 'P', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).returning().get();
  const t = (slug: string, cfg: Record<string, unknown>, kind = 'ssh') =>
    db.insert(targets).values({ projectId: project.id, slug, name: slug, kind, env: 'prod', sensitivity: 1, tags: [], config: cfg, createdAt: new Date() } as never).returning().get();
  const web = t('web-1', { kind: 'ssh', host: '203.0.113.20', port: 22, user: 'ops', sudo: false, addresses: ['10.0.4.21', 'web-1'] });
  const dbh = t('db-1', { kind: 'ssh', host: '203.0.113.21', port: 22, user: 'ops', sudo: false, addresses: ['10.0.5.11'] });
  const prom = t('prom', { kind: 'prometheus', baseUrl: base, allowPrivateNetwork: true }, 'prometheus');
  fromTargets(project.id);
  return { projectId: project.id, web, dbh, prom };
}

test('one component, many names; a person\'s entry is never overwritten', () => {
  const { projectId, web } = seed();
  const viaIp = upsertItem(projectId, { name: '10.0.4.21', type: 'host' }, { source: 'network', ref: 'x:peer:10.0.4.21' });
  const target = findItem(projectId, { targetId: web.id, name: 'web-1' })!;
  assert.equal(viaIp.id, target.id, 'the IP resolves to the registered machine');
  // Locked by a person: automatic sources add evidence but change nothing.
  db.update(ciItems).set({ locked: true, description: 'kept', type: 'host' }).where(eq(ciItems.id, target.id)).run();
  const again = upsertItem(projectId, { name: 'web-1', type: 'database', description: 'overwrite?' }, { source: 'metrics', ref: 'm' });
  assert.equal(again.description, 'kept');
  assert.equal(again.type, 'host');
});

test('an accepted suggestion creates the missing ends, locked and attributed', () => {
  const { projectId } = seed();
  const r = applyChange(projectId, { op: 'add_link', payload: { from: 'checkout-api', to: 'db-1', kind: 'depends_on', detail: 'tcp/5432' }, origin: 'doc', sourceRef: 'doc-1', quote: 'checkout-api uses db-1' }, null);
  assert.equal(r.ok, true);
  const link = db.select().from(ciLinks).where(eq(ciLinks.projectId, projectId)).all().find((l) => l.kind === 'depends_on')!;
  assert.equal(link.locked, true);
  const ev = db.select().from(ciEvidence).where(eq(ciEvidence.linkId, link.id)).all();
  assert.deepEqual(ev.map((e) => [e.source, e.ref, e.detail]), [['doc', 'doc-1', 'checkout-api uses db-1']]);
  assert.ok(findItem(projectId, { name: 'checkout-api' }), 'the end that did not exist was added');
});

test('drift: documented but not seen by a scan that could have; observed but not documented', () => {
  const { projectId, web, dbh } = seed();
  const w = findItem(projectId, { targetId: web.id, name: 'web-1' })!;
  const d = findItem(projectId, { targetId: dbh.id, name: 'db-1' })!;
  const docLink = upsertLink(projectId, w.id, d.id, 'depends_on', { source: 'doc', ref: 'doc-9', detail: 'web-1 uses db-1' })!;
  let link = mapWithConfidence(projectId).links.find((l) => l.id === docLink.id)!;
  assert.deepEqual([link.confidence.certainty, link.confidence.drift], ['documented', null], 'no scan yet: just documented');
  addEvidence(projectId, { itemId: w.id }, { source: 'network', ref: `scan:${web.id}` });
  link = mapWithConfidence(projectId).links.find((l) => l.id === docLink.id)!;
  assert.equal(link.confidence.drift, 'not_seen', 'scanned and not seen');
  addEvidence(projectId, { linkId: docLink.id }, { source: 'network', ref: `${web.id}:out:10.0.5.11:5432` });
  link = mapWithConfidence(projectId).links.find((l) => l.id === docLink.id)!;
  assert.equal(link.confidence.certainty, 'confirmed');
  const obs = upsertLink(projectId, d.id, w.id, 'depends_on', { source: 'network', ref: 'n' })!;
  assert.equal(mapWithConfidence(projectId).links.find((l) => l.id === obs.id)!.confidence.drift, 'not_documented');
});

test('metrics alone build a map: scraped machines, exporters, traced traffic', async () => {
  const { projectId, web } = seed();
  const r = await fromMetrics(projectId);
  assert.deepEqual(r.errors, []);
  const billing = findItem(projectId, { name: 'billing' });
  assert.ok(billing, 'a per-VM job names the machine');
  assert.ok(billing!.aliases.includes('10.0.7.5:9100'));
  const pg = findItem(projectId, { key: 'postgresql@billing', name: 'postgresql on billing' });
  assert.equal(pg?.type, 'database');
  assert.ok(db.select().from(ciLinks).where(and(eq(ciLinks.fromId, pg!.id), eq(ciLinks.toId, billing!.id), eq(ciLinks.kind, 'runs_on'))).get());
  assert.equal(findItem(projectId, { name: 'web-1:9100' })?.targetId, web.id, 'scraped instance joins the registered machine');
  const checkout = findItem(projectId, { name: 'checkout' })!;
  const payments = findItem(projectId, { name: 'payments' })!;
  assert.ok(db.select().from(ciLinks).where(and(eq(ciLinks.fromId, checkout.id), eq(ciLinks.toId, payments.id))).get());
});

test('pruning archives automatic entries nothing supports any more, never a person\'s', () => {
  const { projectId } = seed();
  const auto = upsertItem(projectId, { name: 'ghost', type: 'external' }, { source: 'network', ref: 'old' });
  const manual = upsertItem(projectId, { name: 'kept', type: 'service' }, { source: 'network', ref: 'old2' });
  db.update(ciItems).set({ locked: true }).where(eq(ciItems.id, manual.id)).run();
  db.update(ciEvidence).set({ lastSeenAt: new Date(Date.now() - 30 * 86_400_000) }).where(eq(ciEvidence.projectId, projectId)).run();
  // Targets still support the registered machines.
  db.update(ciEvidence).set({ lastSeenAt: new Date() }).where(and(eq(ciEvidence.projectId, projectId), eq(ciEvidence.source, 'target'))).run();
  pruneObserved(projectId, 15 * 86_400_000);
  assert.equal(db.select().from(ciItems).where(eq(ciItems.id, auto.id)).get()!.status, 'archived');
  assert.equal(db.select().from(ciItems).where(eq(ciItems.id, manual.id)).get()!.status, 'approved');
});

test('incidents: what it depends on (and which is unhealthy), what it affects, and grouping', () => {
  const { projectId, web, dbh } = seed();
  const w = findItem(projectId, { targetId: web.id, name: 'web-1' })!;
  const d = findItem(projectId, { targetId: dbh.id, name: 'db-1' })!;
  const pg = upsertItem(projectId, { key: 'postgresql@db-1', name: 'postgresql on db-1', type: 'database' }, { source: 'network', ref: 'l' });
  upsertLink(projectId, pg.id, d.id, 'runs_on', { source: 'network', ref: 'l' });
  upsertLink(projectId, w.id, pg.id, 'depends_on', { source: 'network', ref: 'c' });
  const lb = upsertItem(projectId, { name: 'lb-1', type: 'load_balancer' }, { source: 'doc', ref: 'd' });
  upsertLink(projectId, lb.id, w.id, 'routes_to', { source: 'doc', ref: 'd' });
  db.insert(incidents).values({ projectId, title: 'DiskFull on db-1', status: 'open', targetIds: [dbh.id] }).run();

  const v = incidentMapView(projectId, [web.id]);
  assert.deepEqual(v.dependsOn.map((x) => x.name), ['db-1', 'postgresql on db-1']);
  assert.match(v.dependsOn[0]!.problems.join(), /open incident: DiskFull on db-1/);
  assert.deepEqual(v.affected.map((x) => x.name), ['lb-1']);
  assert.match(mapRelation(projectId, [web.id], [dbh.id]) ?? '', /web-1 depends on postgresql on db-1/);
  assert.match(serviceMapContext(projectId, [web.id]) ?? '', /web-1 depends on postgresql on db-1/);
});
