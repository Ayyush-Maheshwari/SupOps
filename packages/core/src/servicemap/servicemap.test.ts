import { test } from 'node:test';
import assert from 'node:assert/strict';
import { confidenceOf, dependenciesOf, failureFlows, impactOf } from './model.ts';
import { keyFor, normalizeName, resolveName } from './resolve.ts';
import { parseConnections, parseListening } from './network.ts';
import { parseExtraction, planDocChanges } from './extract.ts';

const NOW = Date.UTC(2026, 6, 1);
const DAY = 86_400_000;

test('names: one component, many spellings', () => {
  for (const n of ['web-1', 'WEB-1:9100', 'web-1.prod.internal', 'web-1-node-metrics', 'http://web-1:8080/health']) assert.equal(normalizeName(n), 'web-1', n);
  assert.equal(normalizeName('ip-10-0-4-21.ec2.internal'), '10.0.4.21');
  assert.equal(normalizeName('10.0.4.21:5432'), '10.0.4.21');
  assert.equal(keyFor('PostgreSQL primary'), 'postgresql-primary');
  const items = [{ id: '1', key: 'db-1', name: 'db-1', aliases: ['10.0.5.11'] }];
  assert.equal(resolveName(items, 'db-1.internal')?.id, '1');
  assert.equal(resolveName(items, '10.0.5.11:5432')?.id, '1');
  assert.equal(resolveName(items, 'db-2'), undefined);
});

test('confidence: agreement confirms, one source alone says what it is', () => {
  assert.equal(confidenceOf([{ source: 'doc', lastSeenAt: NOW }, { source: 'network', lastSeenAt: NOW }], { now: NOW }).certainty, 'confirmed');
  assert.equal(confidenceOf([{ source: 'manual', lastSeenAt: NOW }], { now: NOW }).score, 100);
  const doc = confidenceOf([{ source: 'doc', lastSeenAt: NOW }], { now: NOW, discoveryCovered: true });
  assert.deepEqual([doc.certainty, doc.drift], ['documented', 'not_seen']);
  assert.equal(confidenceOf([{ source: 'doc', lastSeenAt: NOW }], { now: NOW }).drift, null, 'nobody could have seen it');
  const seen = confidenceOf([{ source: 'network', lastSeenAt: NOW }, { source: 'metrics', lastSeenAt: NOW }], { now: NOW });
  assert.deepEqual([seen.certainty, seen.drift, seen.score], ['observed', 'not_documented', 90]);
  assert.equal(confidenceOf([{ source: 'network', lastSeenAt: NOW - 5 * DAY }], { now: NOW }).certainty, 'stale');
});

test('impact and dependencies follow how failure travels', () => {
  const links = [
    { id: 'l1', fromId: 'lb', toId: 'app', kind: 'routes_to' as const },
    { id: 'l2', fromId: 'app', toId: 'db', kind: 'depends_on' as const },
    { id: 'l3', fromId: 'db', toId: 'replica', kind: 'replicates_to' as const },
    { id: 'l4', fromId: 'prom', toId: 'db', kind: 'monitors' as const },
    { id: 'l5', fromId: 'app', toId: 'host', kind: 'runs_on' as const },
  ];
  assert.equal(failureFlows('replicates_to'), 'from->to');
  assert.deepEqual(impactOf('db', links).map((x) => [x.id, x.depth]), [['app', 1], ['replica', 1], ['lb', 2]]);
  assert.deepEqual(impactOf('host', links).map((x) => x.id), ['app', 'lb']);
  assert.deepEqual(dependenciesOf('lb', links).map((x) => x.id).sort(), ['app', 'db', 'host']);
  assert.deepEqual(impactOf('db', links).find((x) => x.id === 'lb')!.via, ['l2', 'l1']);
});

test('ss output: listening services and live connections', () => {
  const listen = 'LISTEN 0 4096 0.0.0.0:5432 0.0.0.0:* users:(("postgres",pid=812,fd=6))\nLISTEN 0 128 127.0.0.1:6379 0.0.0.0:*\nLISTEN 0 511 [::]:80 [::]:* users:(("nginx",pid=1,fd=7))\n';
  assert.deepEqual(parseListening(listen), [{ port: 80, process: 'nginx' }, { port: 5432, process: 'postgres' }]);
  const est = '0 0 10.0.4.21:51432 10.0.5.11:5432 users:(("node",pid=99,fd=21))\n0 0 10.0.4.21:22 10.9.9.9:60000\n0 0 127.0.0.1:4000 127.0.0.1:5000\nnot a line';
  assert.deepEqual(parseConnections(est), [
    { localPort: 51432, peer: '10.0.5.11', peerPort: 5432, process: 'node' },
    { localPort: 22, peer: '10.9.9.9', peerPort: 60000, process: null },
  ]);
});

test('extraction is checked, not trusted', () => {
  const x = parseExtraction('Here you go: {"items":[{"name":"db-1","type":"database","aliases":["10.0.5.11"],"quote":"db-1 is primary"},{"name":"x","type":"spaceship"}],"links":[{"from":"api","to":"db-1","kind":"talks_to"},{"from":"a","to":"A"}]}');
  assert.equal(x.items.find((i) => i.name === 'x')!.type, 'service', 'unknown type coerced');
  assert.equal(x.links.length, 1, 'self-link dropped');
  assert.equal(x.links[0]!.kind, 'depends_on', 'unknown kind coerced');
  assert.ok(x.items.some((i) => i.name === 'api'), 'a link end becomes an item');
  assert.deepEqual(parseExtraction('no json'), { items: [], links: [] });
});

test('a document becomes support for what exists and suggestions for what does not', () => {
  const items = [
    { id: 'i-api', key: 'api', name: 'api', type: 'service' as const, description: null, aliases: [], locked: false },
    { id: 'i-db', key: 'db-1', name: 'db-1', type: 'host' as const, description: null, aliases: [], locked: true },
    { id: 'i-old', key: 'cache-old', name: 'cache-old', type: 'cache' as const, description: null, aliases: [], locked: false },
  ];
  const links = [
    { id: 'l-api-db', fromId: 'i-api', toId: 'i-db', kind: 'depends_on' as const },
    { id: 'l-api-cache', fromId: 'i-api', toId: 'i-old', kind: 'depends_on' as const },
  ];
  const plan = planDocChanges({
    extraction: {
      items: [
        { name: 'API', type: 'service', aliases: ['10.0.4.30'], quote: 'the API' },
        { name: 'db-1.internal', type: 'database', aliases: [], quote: 'db-1 is the primary' },
        { name: 'redis-1', type: 'cache', aliases: [], quote: 'sessions live in redis-1' },
      ],
      links: [
        { from: 'api', to: 'db-1', kind: 'depends_on', quote: 'API uses db-1' },
        { from: 'api', to: 'redis-1', kind: 'depends_on', quote: 'sessions live in redis-1' },
      ],
    },
    items,
    links,
    previousItemIds: ['i-api', 'i-old'],
    previousLinkIds: ['l-api-cache'],
    docOnlyItemIds: ['i-old'],
    docOnlyLinkIds: ['l-api-cache'],
  });
  assert.deepEqual(plan.supportLinks.map((s) => s.linkId), ['l-api-db']);
  const ops = plan.proposals.map((p) => `${p.op}:${String(p.payload.name ?? p.payload.to ?? '')}`);
  assert.ok(ops.includes('add_item:redis-1'));
  assert.ok(ops.includes('add_link:redis-1'));
  assert.ok(ops.includes('update_item:api'), 'a new alias for api');
  assert.ok(!ops.some((o) => o.startsWith('update_item:db-1')), 'a locked entry is never changed by a document');
  assert.ok(ops.includes('remove_link:cache-old'));
  assert.ok(ops.includes('remove_item:cache-old'));
});

test('a cluster describes itself: workloads, the services that select them, ingresses and env settings', async () => {
  const { parseKubernetes, hostsInValue } = await import('./kubernetes.ts');
  assert.deepEqual(hostsInValue('postgres://app:pw@db-1.prod.internal:5432/shop'), ['db-1.prod.internal']);
  assert.deepEqual(hostsInValue('kafka-0:9092,kafka-1:9092'), ['kafka-0', 'kafka-1']);
  assert.deepEqual(hostsInValue('true'), []);
  const m = parseKubernetes({
    items: [
      { kind: 'Deployment', metadata: { name: 'api', namespace: 'shop' }, spec: { template: { metadata: { labels: { app: 'api' } }, spec: { containers: [{ image: 'shop/api:1.4', env: [
        { name: 'DB_HOST', value: 'db-1.prod.internal' }, { name: 'CACHE_URL', value: 'redis://redis:6379' }, { name: 'LOG_LEVEL', value: 'debug' },
      ] }] } } } },
      { kind: 'StatefulSet', metadata: { name: 'redis', namespace: 'shop' }, spec: { template: { metadata: { labels: { app: 'redis' } }, spec: { containers: [{ image: 'redis:7' }] } } } },
      { kind: 'Service', metadata: { name: 'api-svc', namespace: 'shop' }, spec: { selector: { app: 'api' } } },
      { kind: 'Service', metadata: { name: 'redis', namespace: 'shop' }, spec: { selector: { app: 'redis' } } },
      { kind: 'Ingress', metadata: { name: 'web', namespace: 'shop' }, spec: { rules: [{ host: 'shop.example.com', http: { paths: [{ path: '/', backend: { service: { name: 'api-svc' } } }] } }] } },
    ],
  }, 'prod');
  const api = m.items.find((i) => i.name === 'api')!;
  assert.ok(api.aliases.includes('api-svc.shop.svc.cluster.local'));
  assert.equal(m.items.find((i) => i.name === 'redis')!.type, 'cache');
  assert.deepEqual(m.links.map((l) => `${l.from} ${l.kind} ${l.to}`).sort(), [
    'prod/shop/api depends_on db-1.prod.internal',
    'prod/shop/api depends_on prod/shop/redis',
    'prod/shop/ingress-web routes_to prod/shop/api',
  ]);
});

test('loopback names never identify a component; a shared address prefers the machine', () => {
  const items = [
    { id: 'm', key: 'prom', name: 'prom', aliases: ['127.0.0.1', '10.0.0.9'], type: 'monitoring' },
    { id: 'h', key: 'mon-1', name: 'mon-1', aliases: ['10.0.0.9'], type: 'host' },
  ];
  assert.equal(resolveName(items, '127.0.0.1'), undefined);
  assert.equal(resolveName(items, 'localhost:9090'), undefined);
  assert.equal(resolveName(items, '10.0.0.9:9090')?.id, 'h');
});
