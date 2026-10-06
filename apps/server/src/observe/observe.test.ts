import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

// The server's modules open the database named in the environment when imported:
// point them at a fresh one before loading anything.
process.env.DATABASE_PATH = join(mkdtempSync(join(tmpdir(), 'supops-observe-')), 'test.db');
process.env.SUPOPS_MASTER_KEY = randomBytes(32).toString('base64');
process.env.LLM_BASE_URL = 'http://127.0.0.1:9/';

const { db, settingsStore } = await import('../context.ts');
const { agents, alerts, incidents, observations, projects, targets, watches, DEFAULT_RISK_POLICY, DEFAULT_RUN_BUDGET } = await import('@supops/db');
const { eq } = await import('drizzle-orm');
const { pollConnection } = await import('./alert-poller.ts');
const { ingestAlert } = await import('./ingest.ts');
const { mergeIncidents, splitIncident } = await import('./incidents.ts');
const { projectConnections } = await import('./connections.ts');
const { sampleWatch } = await import('./watcher.ts');
const { evidenceBlock } = await import('./triage.ts');
const { cleanupObservability } = await import('@supops/core');

// ---- a fake Alertmanager + Prometheus --------------------------------------------

let firing: Array<Record<string, unknown>> = [];
let diskSeries: Array<[number, string]> = [];
let server: Server;
let base = '';

before(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const send = (v: unknown) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(v));
    if (url.pathname === '/api/v2/alerts') return send(firing);
    if (url.pathname === '/api/v1/query_range') {
      return send({ status: 'success', data: { resultType: 'matrix', result: [{ metric: { instance: 'web-1:9100', mountpoint: '/var' }, values: diskSeries }] } });
    }
    if (url.pathname === '/api/v1/query') return send({ status: 'success', data: { resultType: 'vector', result: [] } });
    res.writeHead(404).end('{}');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => new Promise<void>((r) => server.close(() => r())));

function seed() {
  // Nothing in these tests may start an investigation.
  settingsStore.saveObservability({ autoTriage: false });
  const project = db.insert(projects).values({ slug: `p-${randomBytes(3).toString('hex')}`, name: 'P', riskPolicy: DEFAULT_RISK_POLICY, createdAt: new Date() }).returning().get();
  db.insert(agents).values({ projectId: project.id, slug: 'triage', name: 'Triage', role: 'triage', systemPrompt: 'x', budget: DEFAULT_RUN_BUDGET, createdAt: new Date() }).run();
  const web = db.insert(targets).values({
    projectId: project.id, slug: 'web-1', name: 'web-1', kind: 'ssh', env: 'prod', sensitivity: 1, tags: [],
    config: { kind: 'ssh', host: '203.0.113.10', port: 22, user: 'ops', sudo: false, addresses: ['web-1'] }, createdAt: new Date(),
  }).returning().get();
  const am = db.insert(targets).values({
    projectId: project.id, slug: 'am', name: 'am', kind: 'alertmanager', env: 'prod', sensitivity: 1, tags: [],
    config: { kind: 'alertmanager', baseUrl: base, allowPrivateNetwork: true }, createdAt: new Date(),
  } as never).returning().get();
  const prom = db.insert(targets).values({
    projectId: project.id, slug: 'prom', name: 'prom', kind: 'prometheus', env: 'prod', sensitivity: 1, tags: [],
    config: { kind: 'prometheus', baseUrl: base, allowPrivateNetwork: true }, createdAt: new Date(),
  } as never).returning().get();
  return { projectId: project.id, web, am, prom };
}

const amAlert = (fingerprint: string, alertname: string, instance: string, severity = 'warning') => ({
  fingerprint, labels: { alertname, instance, severity }, annotations: { summary: `${alertname} on ${instance}` }, startsAt: new Date().toISOString(), status: { state: 'active' },
});

test('alerts read from Alertmanager are grouped, merged with Slack copies, and resolved when gone', async () => {
  const { projectId, web, am } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === am.id)!;

  firing = [amAlert('f1', 'HighCPU', 'web-1:9100'), amAlert('f2', 'DiskFull', 'web-1:9100', 'critical')];
  const st = await pollConnection(projectId, conn);
  assert.equal(st.ok, true);
  let rows = db.select().from(alerts).where(eq(alerts.projectId, projectId)).all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.source === 'alertmanager' && r.connectionId === am.id));
  assert.equal(new Set(rows.map((r) => r.incidentId)).size, 1, 'one incident for one machine');
  const inc = db.select().from(incidents).where(eq(incidents.id, rows[0]!.incidentId!)).get()!;
  assert.equal(inc.severity, 'critical');
  assert.deepEqual(inc.targetIds, [web.id]);
  assert.match(inc.title, /on web-1/);

  // Polling again does not duplicate or bump counts.
  await pollConnection(projectId, conn);
  rows = db.select().from(alerts).where(eq(alerts.projectId, projectId)).all();
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.count === 1));

  // The same alert relayed through Slack joins the existing row.
  const slack = (status: 'firing' | 'resolved') =>
    ingestAlert({
      projectId, source: 'slack', fingerprint: 'slack-fp', title: 'HighCPU', severity: 'warning', summary: null,
      labels: { alertname: 'HighCPU', instance: 'web-1:9100' }, status, notification: true,
      slack: { channelId: 'C1', channelName: 'alerts', permalink: 'https://example.slack.com/x' },
    });
  slack('firing');
  rows = db.select().from(alerts).where(eq(alerts.projectId, projectId)).all();
  assert.equal(rows.length, 2, 'merged, not duplicated');
  assert.equal(rows.find((r) => r.title === 'HighCPU')!.slackPermalink, 'https://example.slack.com/x');
  // Slack saying "resolved" does not close what the connection still reports.
  slack('resolved');
  assert.equal(db.select().from(alerts).where(eq(alerts.fingerprint, `${am.id}:f1`)).get()!.status, 'new');

  // Gone from Alertmanager: resolved, kept as history.
  firing = [amAlert('f2', 'DiskFull', 'web-1:9100', 'critical')];
  await pollConnection(projectId, conn);
  const cpu = db.select().from(alerts).where(eq(alerts.fingerprint, `${am.id}:f1`)).get()!;
  assert.equal(cpu.status, 'resolved');
  assert.ok(cpu.resolvedAt);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, inc.id)).get()!.status, 'open');

  firing = [];
  await pollConnection(projectId, conn);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, inc.id)).get()!.status, 'resolved');
});

test('a failed read resolves nothing', async () => {
  const { projectId, am } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === am.id)!;
  firing = [amAlert('x1', 'Down', 'db-9')];
  await pollConnection(projectId, conn);
  const broken = { ...conn, config: { ...(conn.config as object), baseUrl: 'http://127.0.0.1:9' } } as typeof conn;
  const st = await pollConnection(projectId, broken);
  assert.equal(st.ok, false);
  assert.equal(db.select().from(alerts).where(eq(alerts.fingerprint, `${am.id}:x1`)).get()!.status, 'new');
});

test('unrelated alerts open separate incidents; a person can merge and split them', async () => {
  const { projectId, am } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === am.id)!;
  firing = [amAlert('a', 'DiskFull', 'db-1'), amAlert('b', 'Latency', 'api-7')];
  await pollConnection(projectId, conn);
  const rows = db.select().from(alerts).where(eq(alerts.projectId, projectId)).all();
  const [i1, i2] = [...new Set(rows.map((r) => r.incidentId!))];
  assert.ok(i1 && i2 && i1 !== i2);

  const merged = mergeIncidents(i2, i1)!;
  assert.equal(db.select().from(alerts).where(eq(alerts.incidentId, i1)).all().length, 2);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, i2)).get()!.mergedInto, i1);
  assert.match(merged.groupReason ?? '', /merged by a person/);

  const latency = rows.find((r) => r.title === 'Latency')!;
  const split = splitIncident(i1, [latency.id])!;
  assert.equal(db.select().from(alerts).where(eq(alerts.id, latency.id)).get()!.incidentId, split.id);
  assert.equal(splitIncident(split.id, [latency.id]), null, 'cannot split out every alert');
});

test('the watcher stores samples and opens a predicted incident before a disk fills', async () => {
  const { projectId, prom, web } = seed();
  const conn = projectConnections(projectId).find((c) => c.id === prom.id)!;
  const now = Date.now();
  // /var losing 1 GB an hour with 20 GB left: full in about 20 hours.
  diskSeries = Array.from({ length: 100 }, (_, i) => {
    const t = Math.floor(now / 1000) - (99 - i) * 300;
    return [t, String(20e9 + (99 - i) * 300 * (1e9 / 3600))];
  });
  const w = db.insert(watches).values({
    projectId, connectionId: prom.id, key: 'disk_free', title: 'Disk free', query: 'node_filesystem_avail_bytes', unit: 'bytes',
    builtin: true, badDirection: 'down', limit: { value: 0, when: 'below' }, group: 'resources',
  }).returning().get();

  await sampleWatch(w, conn, now);
  const sampled = db.select().from(watches).where(eq(watches.id, w.id)).get()!;
  assert.equal(sampled.seriesCount, 1);
  assert.equal(sampled.lastError, null);

  const obs = db.select().from(observations).where(eq(observations.watchId, w.id)).all();
  const f = obs.find((o) => o.kind === 'forecast')!;
  assert.ok(f, 'a forecast was recorded');
  assert.equal(f.severity, 'warning', 'about 20h left: inside the 24h warning horizon');
  assert.equal(f.targetId, web.id, 'tied to the machine by its instance label');
  assert.match(f.message, /Disk free on web-1:9100 \/var runs out in about (19|20)h/);
  const inc = db.select().from(incidents).where(eq(incidents.id, f.incidentId!)).get()!;
  assert.equal(inc.origin, 'prediction');
  assert.equal(inc.status, 'open');

  const block = evidenceBlock(inc, [], []);
  assert.match(block, /raised by a forecast/);
  assert.match(block, /Forecast: Disk free on web-1/);

  // The disk was cleaned up: the forecast and its incident resolve.
  diskSeries = diskSeries.map(([t]) => [t, '500000000000']);
  await sampleWatch(db.select().from(watches).where(eq(watches.id, w.id)).get()!, conn, now + 300_000);
  assert.ok(db.select().from(observations).where(eq(observations.id, f.id)).get()!.resolvedAt);
  assert.equal(db.select().from(incidents).where(eq(incidents.id, inc.id)).get()!.status, 'resolved');

  // And the 15-day clean-up leaves recent data alone.
  const r = cleanupObservability(db, { days: 15 });
  assert.equal(r.incidents, 0);
});
