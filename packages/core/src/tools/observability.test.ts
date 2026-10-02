import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ExecContext, ResolvedTarget } from './types.ts';
import { addressProblem, buildUrl, safeGet } from './executors/http.ts';
import { alertsTool, condensePrometheus, indexAllowed, queryLogsTool, queryMetricsTool, timeWindow } from './observability.ts';

// ---- the network guard ---------------------------------------------------------

test('cloud metadata and link-local addresses are always refused', () => {
  for (const ip of ['169.254.169.254', '169.254.10.1', '100.100.100.200', 'fd00:ec2::254', '0.0.0.0', '::ffff:169.254.169.254']) {
    assert.ok(addressProblem(ip, true), `${ip} must be refused even with private network allowed`);
  }
});

test('private and loopback addresses need the connection to allow them', () => {
  for (const ip of ['10.0.0.5', '192.168.1.2', '172.20.0.1', '127.0.0.1', '::1', '100.64.0.1']) {
    assert.ok(addressProblem(ip, false), ip);
    assert.equal(addressProblem(ip, true), null, ip);
  }
  assert.equal(addressProblem('34.120.10.5', false), null);
});

test('requests cannot leave the configured origin', () => {
  assert.equal(buildUrl('https://prom.internal:9090', '/api/v1/query', { query: 'up' }).href, 'https://prom.internal:9090/api/v1/query?query=up');
  assert.equal(buildUrl('https://grafana.x/prometheus/', '/api/v1/labels').pathname, '/prometheus/api/v1/labels');
  assert.throws(() => buildUrl('https://prom.internal', '//evil.example/x'));
  assert.throws(() => buildUrl('https://prom.internal', '/../../etc'));
  assert.throws(() => buildUrl('file:///etc/passwd', '/x'));
});

test('a literal metadata IP is refused before any connection', async () => {
  await assert.rejects(
    safeGet({ baseUrl: 'http://169.254.169.254', path: '/latest/meta-data', allowPrivateNetwork: true, timeoutMs: 2000, maxBytes: 1000 }),
    /never reachable/,
  );
});

// ---- helpers -----------------------------------------------------------------

test('time windows: relative times, ordering and the per-connection cap', () => {
  const now = Date.UTC(2026, 9, 1, 12);
  const w = timeWindow('now-1h', 'now', 'now-15m', 24, now);
  assert.deepEqual(w, { start: now - 3.6e6, end: now });
  assert.match((timeWindow('now', 'now-1h', 'now-15m', 24, now) as { error: string }).error, /before end/);
  assert.match((timeWindow('now-48h', undefined, 'now-15m', 24, now) as { error: string }).error, /at most 24h/);
});

test('index allowlists use simple globs', () => {
  assert.ok(indexAllowed('logs-2026.10.01', ['logs-*']));
  assert.ok(!indexAllowed('secrets', ['logs-*']));
  assert.ok(indexAllowed('anything', []));
});

test('Prometheus results are condensed to one line per series', () => {
  const out = condensePrometheus(
    { resultType: 'matrix', result: [{ metric: { __name__: 'up', job: 'api' }, values: [[1, '1'], [2, '0'], [3, '1']] }] },
    50,
  );
  assert.equal(out, 'up{job="api"}: 3 points, first 1, last 1, min 0, max 1');
  assert.equal(condensePrometheus({ resultType: 'vector', result: [] }, 50), '(no series matched)');
});

// ---- end to end against a fake backend ---------------------------------------

async function fakeBackend(routes: Record<string, (url: URL, body: string) => unknown>) {
  const seen: Array<{ path: string; auth?: string; tenant?: string }> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const url = new URL(req.url!, 'http://x');
      seen.push({ path: url.pathname, auth: req.headers.authorization, tenant: req.headers['x-scope-orgid'] as string | undefined });
      if (url.pathname === '/redirect') {
        res.writeHead(302, { location: 'http://169.254.169.254/' }).end();
        return;
      }
      const h = routes[url.pathname];
      if (!h) {
        res.writeHead(404).end('{}');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(h(url, body)));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

function ctxFor(kind: string, baseUrl: string, extra: Record<string, unknown> = {}, secret?: string): ExecContext {
  const target = {
    id: 't', slug: `${kind}-1`, kind, env: 'prod', sensitivity: 1, description: null,
    config: { kind, baseUrl, allowPrivateNetwork: true, ...extra },
    credentialId: null, protectedPaths: null, writablePaths: null, unitAllowlist: null,
    ...(secret ? { secret } : {}),
  } as unknown as ResolvedTarget;
  return { runId: 'r', toolCallId: 'c', target, timeoutMs: 5000, maxOutputBytes: 16_384, signal: new AbortController().signal } as ExecContext;
}

test('query_metrics runs a range query with auth and summarises the result', async () => {
  const be = await fakeBackend({
    '/api/v1/query_range': (u) => ({
      status: 'success',
      data: { resultType: 'matrix', result: [{ metric: { __name__: 'http_requests_total', code: '500' }, values: [[1, '2'], [2, u.searchParams.get('query') === 'rate(x[5m])' ? '9' : '0']] }] },
    }),
  });
  try {
    const out = await queryMetricsTool.execute(
      { target: 'p', operation: 'range', query: 'rate(x[5m])', start: 'now-1h' },
      ctxFor('prometheus', be.base, {}, JSON.stringify({ type: 'bearer', token: 'tok-123' })),
    );
    assert.equal(out.ok, true, out.text);
    assert.match(out.text, /http_requests_total\{code="500"\}: 2 points, first 2, last 9/);
    assert.equal(be.seen[0]!.auth, 'Bearer tok-123');
  } finally {
    await be.close();
  }
});

test('query_metrics refuses a window longer than the connection allows', async () => {
  const out = await queryMetricsTool.execute({ target: 'p', operation: 'range', query: 'up', start: 'now-30d' }, ctxFor('prometheus', 'http://127.0.0.1:1'));
  assert.equal(out.ok, false);
  assert.match(out.text, /at most 168h/);
});

test('query_logs reads Loki newest-first with the tenant header', async () => {
  const be = await fakeBackend({
    '/loki/api/v1/query_range': () => ({
      data: { result: [{ stream: { app: 'api' }, values: [['1790000000000000000', 'old line'], ['1790000060000000000', 'new line']] }] },
    }),
  });
  try {
    const out = await queryLogsTool.execute({ target: 'l', query: '{app="api"} |= "error"' }, ctxFor('loki', be.base, { tenantId: 'team-a' }));
    assert.equal(out.ok, true, out.text);
    const lines = out.text.split('\n');
    assert.match(lines[0]!, /new line/);
    assert.match(lines[1]!, /old line/);
    assert.equal(be.seen[0]!.tenant, 'team-a');
  } finally {
    await be.close();
  }
});

test('query_logs enforces the Elasticsearch index allowlist', async () => {
  const out = await queryLogsTool.execute({ target: 'e', query: 'level:error', index: 'secrets' }, ctxFor('elasticsearch', 'http://127.0.0.1:1', { indices: ['logs-*'] }));
  assert.equal(out.ok, false);
  assert.match(out.text, /not allowed/);
});

test('alerts lists active Alertmanager alerts', async () => {
  const be = await fakeBackend({
    '/api/v2/alerts': () => [{ labels: { alertname: 'DiskFull', instance: 'db1' }, status: { state: 'active' }, startsAt: '2026-10-01T10:00:00Z', annotations: { summary: '/data at 95%' } }],
  });
  try {
    const out = await alertsTool.execute({ target: 'a', operation: 'list_alerts' }, ctxFor('alertmanager', be.base));
    assert.match(out.text, /1 alerts\nDiskFull .* active since 2026-10-01T10:00:00Z -- \/data at 95%/);
  } finally {
    await be.close();
  }
});

test('a redirect is not followed, so a backend cannot bounce the agent elsewhere', async () => {
  const be = await fakeBackend({});
  try {
    const r = await safeGet({ baseUrl: be.base, path: '/redirect', allowPrivateNetwork: true, timeoutMs: 3000, maxBytes: 1000 });
    assert.equal(r.status, 302);
    assert.equal(be.seen.length, 1);
  } finally {
    await be.close();
  }
});

test('loopback is refused when the connection does not allow private networks', async () => {
  const be = await fakeBackend({ '/api/v1/labels': () => ({ data: [] }) });
  try {
    await assert.rejects(
      safeGet({ baseUrl: be.base.replace('127.0.0.1', 'localhost'), path: '/api/v1/labels', allowPrivateNetwork: false, timeoutMs: 3000, maxBytes: 1000 }),
      /private or loopback/,
    );
  } finally {
    await be.close();
  }
});

test('Grafana queries go through the Prometheus datasource proxy; no uid is refused', async () => {
  const be = await fakeBackend({
    '/api/datasources/proxy/uid/prom1/api/v1/query': () => ({ data: { resultType: 'vector', result: [{ metric: { __name__: 'up', job: 'api' }, value: [1, '1'] }] } }),
  });
  try {
    const ok = await queryMetricsTool.execute({ target: 'g', operation: 'instant', query: 'up' }, ctxFor('grafana', be.base, { datasourceUid: 'prom1' }));
    assert.match(ok.text, /up\{job="api"\} = 1/);
    const none = await queryMetricsTool.execute({ target: 'g', operation: 'instant', query: 'up' }, ctxFor('grafana', be.base));
    assert.equal(none.ok, false);
    assert.match(none.text, /datasource uid/);
  } finally {
    await be.close();
  }
});

test('silence matchers parse and are classified by risk', async () => {
  const { parseMatchers } = await import('./observability.ts');
  assert.deepEqual(parseMatchers('alertname="DiskFull",instance="db1"'), [
    { name: 'alertname', value: 'DiskFull', isRegex: false, isEqual: true },
    { name: 'instance', value: 'db1', isRegex: false, isEqual: true },
  ]);
  const tier = (args: Record<string, unknown>) => alertsTool.classifyArgs!({ operation: 'create_silence', ...args } as never, {} as never);
  assert.equal(tier({ matchers: 'alertname="X"', duration: '2h' })[0]!.tier, 'medium');
  assert.equal(tier({ matchers: '', duration: '2h' })[0]!.tier, 'forbidden', 'no matcher mutes everything');
  assert.equal(tier({ matchers: 'alertname="X"', duration: '2d' })[0]!.tier, 'forbidden', 'over 24h is refused');
  assert.equal(alertsTool.classifyArgs!({ operation: 'list_alerts' } as never, {} as never)[0]!.tier, 'read_only');
  assert.equal(alertsTool.classifyArgs!({ operation: 'expire_silence', silence_id: 'x' } as never, {} as never)[0]!.tier, 'low');
});

test('creating a silence POSTs matchers; expiring one DELETEs it', async () => {
  const be = await fakeBackend({ '/api/v2/silences': () => ({ silenceID: 'sil-1' }) });
  try {
    const out = await alertsTool.execute({ target: 'a', operation: 'create_silence', matchers: 'alertname="DiskFull"', duration: '2h', comment: 'maintenance' }, ctxFor('alertmanager', be.base));
    assert.match(out.text, /Silence created \(sil-1\)/);
    assert.equal(be.seen[0]!.path, '/api/v2/silences');
  } finally {
    await be.close();
  }
});
