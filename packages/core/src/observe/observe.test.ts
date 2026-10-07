import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResolvedTarget } from '../tools/types.ts';
import { chooseIncident, groupKeyOf, worstSeverity, type OpenIncidentRef } from './correlate.ts';
import { fromAlertmanager, fromPrometheus, fetchConnectionAlerts } from './sources.ts';
import { checkCitations, parseAction, parseVerdict } from './citations.ts';
import { clusterLogLines, logTemplate } from './logs.ts';
import { promString, runChecks, scopeFromLabels, scopeMatchers } from './checks.ts';
import { formatValue, parseSeriesKey, seriesKey, seriesName } from './signals.ts';
import { queryMetricsTool, queryLogsTool, alertsTool } from '../tools/observability.ts';

const NOW = Date.UTC(2026, 5, 1, 12);
const inc = (id: string, labels: Record<string, string>, targetIds: string[] = [], ago = 60_000): OpenIncidentRef => ({
  id, title: labels.alertname ?? id, groupKey: groupKeyOf({ title: labels.alertname ?? id, labels }), targetIds, lastSeenAt: NOW - ago,
});

// ---- grouping ------------------------------------------------------------------

test('alerts about the same machine join one incident', () => {
  const open = [inc('i1', { alertname: 'HighCPU', instance: 'web-1:9100' })];
  const r = chooseIncident({ title: 'DiskFull', labels: { alertname: 'DiskFull', instance: 'web-1:9100' }, targetIds: [], at: NOW }, open);
  assert.equal(r?.incidentId, 'i1');
  assert.match(r!.reason, /web-1/);
});

test('the same alert on several machines joins one incident', () => {
  const open = [inc('i1', { alertname: 'HighCPU', instance: 'web-1' })];
  const r = chooseIncident({ title: 'HighCPU', labels: { alertname: 'HighCPU', instance: 'web-2' }, targetIds: [], at: NOW }, open);
  assert.equal(r?.incidentId, 'i1');
  assert.match(r!.reason, /several machines/);
});

test('same service, matched target, or namespace group; unrelated alerts do not', () => {
  const open = [
    inc('svc', { alertname: 'Latency', service: 'checkout', namespace: 'shop' }),
    inc('tgt', { alertname: 'Ping' }, ['t-9']),
    inc('ns', { alertname: 'X', namespace: 'billing' }),
  ];
  assert.equal(chooseIncident({ title: 'Errors', labels: { alertname: 'Errors', service: 'checkout', namespace: 'shop' }, targetIds: [], at: NOW }, open)?.incidentId, 'svc');
  assert.equal(chooseIncident({ title: 'Mem', labels: { alertname: 'Mem' }, targetIds: ['t-9'], at: NOW }, open)?.incidentId, 'tgt');
  assert.equal(chooseIncident({ title: 'Y', labels: { alertname: 'Y', namespace: 'billing' }, targetIds: [], at: NOW }, open)?.incidentId, 'ns');
  assert.equal(chooseIncident({ title: 'Z', labels: { alertname: 'Z', instance: 'db-7' }, targetIds: [], at: NOW }, open), null);
});

test('old incidents and other clusters are not joined', () => {
  const stale = [inc('old', { alertname: 'HighCPU', instance: 'web-1' }, [], 60 * 60_000)];
  assert.equal(chooseIncident({ title: 'HighCPU', labels: { alertname: 'HighCPU', instance: 'web-1' }, targetIds: [], at: NOW }, stale), null);
  const other = [inc('c1', { alertname: 'HighCPU', instance: 'web-1', cluster: 'eu' })];
  assert.equal(chooseIncident({ title: 'HighCPU', labels: { alertname: 'HighCPU', instance: 'web-1', cluster: 'us' }, targetIds: [], at: NOW }, other), null);
});

test('an incident takes its worst severity', () => {
  assert.equal(worstSeverity('warning', 'critical'), 'critical');
  assert.equal(worstSeverity('critical', 'info'), 'critical');
});

// ---- sources -------------------------------------------------------------------

test('Alertmanager alerts keep their fingerprint, labels and summary; silenced ones are skipped', () => {
  const list = fromAlertmanager([
    { fingerprint: 'abc', labels: { alertname: 'DiskFull', instance: 'db-1', severity: 'critical' }, annotations: { summary: 'Disk 95% full' }, startsAt: '2026-06-01T11:00:00Z', status: { state: 'active' } },
    { fingerprint: 'def', labels: { alertname: 'Muted' }, status: { state: 'suppressed' } },
  ]);
  assert.equal(list.length, 1);
  assert.deepEqual([list[0]!.fingerprint, list[0]!.title, list[0]!.severity, list[0]!.summary], ['abc', 'DiskFull', 'critical', 'Disk 95% full']);
  assert.equal(list[0]!.startsAt, Date.parse('2026-06-01T11:00:00Z'));
});

test('Prometheus alerts: firing only, with a stable fingerprint from labels', () => {
  const json = { data: { alerts: [
    { labels: { alertname: 'A', instance: 'x' }, state: 'firing', activeAt: '2026-06-01T11:00:00Z' },
    { labels: { alertname: 'B' }, state: 'pending' },
  ] } };
  const a = fromPrometheus(json);
  assert.equal(a.length, 1);
  assert.equal(a[0]!.fingerprint, fromPrometheus(json)[0]!.fingerprint);
  assert.equal(a[0]!.severity, 'unknown');
});

// ---- citations -----------------------------------------------------------------

test('citations to evidence that does not exist are caught', () => {
  const r = checkCitations('Disk is full [E1], caused by logs [E2] and [E7]. Again [E1].', ['E1', 'E2', 'E3']);
  assert.deepEqual(r.cited, ['E1', 'E2', 'E7']);
  assert.deepEqual(r.unknown, ['E7']);
});

test('the verdict is read from the report', () => {
  assert.deepEqual(parseVerdict('## Summary\n**Root cause:** the log volume filled /var [E2]\n**Confidence:** high'), {
    rootCause: 'the log volume filled /var [E2]', confidence: 'high',
  });
  assert.deepEqual(parseVerdict('- Root cause: Inconclusive -- no metrics for the host'), { rootCause: 'Inconclusive -- no metrics for the host', confidence: 'inconclusive' });
  assert.deepEqual(parseVerdict('nothing here'), { rootCause: null, confidence: null });
});

// ---- logs ------------------------------------------------------------------------

test('log lines group by template', () => {
  assert.equal(logTemplate('2026-06-01T11:00:00Z request 8f1c2d3e-1111-2222-3333-444455556666 from 10.1.2.3:443 took 120ms'), '<time> request <id> from <ip> took <n>');
  const g = clusterLogLines(['error: timeout after 30s id=1', 'error: timeout after 31s id=2', 'panic: nil map', '']);
  assert.equal(g[0]!.count, 2);
  assert.equal(g.length, 2);
});

// ---- checks against a fake Prometheus --------------------------------------------

async function fakeProm(answer: (q: string, path: string) => unknown) {
  const queries: string[] = [];
  const server = createServer((req, res) => {
    const url = new URL(req.url!, 'http://x');
    const q = url.searchParams.get('query') ?? '';
    queries.push(q);
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer(q, url.pathname)));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { base, queries, close: () => new Promise<void>((r) => server.close(() => r())) };
}

const conn = (kind: string, baseUrl: string) =>
  ({ id: `c-${kind}`, slug: `${kind}-main`, kind, env: 'prod', config: { kind, baseUrl, allowPrivateNetwork: true } }) as unknown as ResolvedTarget;
const vec = (rows: Array<[Record<string, string>, number]>) => ({ status: 'success', data: { resultType: 'vector', result: rows.map(([metric, v]) => ({ metric, value: [0, String(v)] })) } });

test('scope matchers escape label values', () => {
  assert.equal(promString('a"b\\c'), 'a\\"b\\\\c');
  assert.deepEqual(scopeMatchers({ host: 'web.1', namespace: 'shop' }), ['instance=~"web\\\\.1(:[0-9]+)?"', 'namespace="shop"']);
  assert.deepEqual(scopeFromLabels([{ instance: 'Web-1:9100', namespace: 'shop' }], ['HighCPU']), { host: 'web-1', namespace: 'shop', alertnames: ['HighCPU'] });
});

test('the evidence pack finds what is wrong and marks what is not measured', async () => {
  const be = await fakeProm((q) => {
    if (q.startsWith('count by (alertname')) return vec([[{ alertname: 'DiskFull', severity: 'critical' }, 1], [{ alertname: 'HighCPU' }, 1]]);
    if (q.includes('node_filesystem_avail_bytes') && q.startsWith('max by (instance, mountpoint)')) return vec([[{ instance: 'web-1:9100', mountpoint: '/var' }, 97.5]]);
    if (q.startsWith('count(node_')) return vec([[{}, 3]]);
    if (q.startsWith('count(up)')) return vec([[{}, 3]]);
    return vec([]);
  });
  try {
    const items = await runChecks([conn('prometheus', be.base)], { host: 'web-1', alertnames: ['DiskFull'] });
    const by = Object.fromEntries(items.map((i) => [i.check, i]));
    assert.equal(by.disk!.status, 'interesting');
    assert.match(by.disk!.summary, /web-1:9100 \/var: 97\.5%/);
    assert.equal(by.related_alerts!.status, 'interesting');
    assert.match(by.related_alerts!.summary, /HighCPU/);
    assert.doesNotMatch(by.related_alerts!.summary, /DiskFull/);
    assert.equal(by.targets_down!.status, 'normal');
    assert.equal(by.oom_kills!.status, 'unavailable', 'kube-state-metrics is not there');
    assert.equal(items[0]!.status, 'interesting', 'interesting results first');
    assert.ok(be.queries.some((q) => q.includes('instance=~"web-1(:[0-9]+)?"')), 'scoped to the host');
  } finally {
    await be.close();
  }
});

test('the stack checks look at the monitoring itself', async () => {
  const be = await fakeProm((q) => {
    if (q.includes('prometheus_rule_evaluation_failures_total[1h]')) return vec([[{ rule_group: 'node.rules' }, 4]]);
    if (q.startsWith('up') || q.startsWith('up{')) return vec([[{ job: 'node', instance: 'db-1:9100' }, 0]]);
    return vec([]);
  });
  try {
    const items = await runChecks([conn('prometheus', be.base)], {}, { stack: true });
    const by = Object.fromEntries(items.map((i) => [i.check, i]));
    assert.equal(by.rule_failures!.status, 'interesting');
    assert.equal(by.targets_down!.status, 'interesting');
    assert.match(by.targets_down!.summary, /db-1:9100/);
    assert.equal(by.disk, undefined, 'incident checks are not part of a stack check');
  } finally {
    await be.close();
  }
});

// ---- series helpers --------------------------------------------------------------

test('series keys round-trip and values read naturally', () => {
  const k = seriesKey({ __name__: 'x', mountpoint: '/', instance: 'web-1' });
  assert.equal(k, '{instance="web-1",mountpoint="/"}');
  assert.deepEqual(parseSeriesKey(k), { instance: 'web-1', mountpoint: '/' });
  assert.equal(formatValue(12_345_678_901, 'bytes'), '12.3 GB');
  assert.equal(formatValue(87.25, 'percent'), '87.3%');
  assert.equal(formatValue(0.25, 'seconds'), '250 ms');
});

// ---- tool operations ---------------------------------------------------------------

const ctx = (t: ResolvedTarget) => ({ runId: 'r', toolCallId: 'c', target: t, timeoutMs: 5000, maxOutputBytes: 16_384, signal: new AbortController().signal }) as never;

test('query_metrics forecast says when a disk runs out', async () => {
  const now = Math.floor(Date.now() / 1000);
  const be = await fakeProm(() => ({
    status: 'success',
    data: { resultType: 'matrix', result: [{ metric: { instance: 'web-1', mountpoint: '/' }, values: Array.from({ length: 145 }, (_, i) => [now - (144 - i) * 300, String(50e9 - i * 300 * (1e9 / 3600))]) }] },
  }));
  try {
    const out = await queryMetricsTool.execute({ target: 'p', operation: 'forecast', query: 'node_filesystem_avail_bytes', limit_value: 0, limit_when: 'below' }, ctx(conn('prometheus', be.base)));
    assert.equal(out.ok, true, out.text);
    assert.match(out.text, /reaches 0 in about 3[78]h/);
    assert.match(out.text, /confidence high/);
  } finally {
    await be.close();
  }
});

test('query_metrics status and alerts status describe the stack', async () => {
  const be = await fakeProm((_q, path) => {
    if (path === '/api/v1/status/buildinfo') return { data: { version: '3.1.0' } };
    if (path === '/api/v1/status/runtimeinfo') return { data: { reloadConfigSuccess: false, startTime: 'x' } };
    if (path === '/api/v1/status/tsdb') return { data: { headStats: { numSeries: 1234 }, seriesCountByMetricName: [{ name: 'http_requests_total', value: 900 }] } };
    if (path === '/api/v1/targets') return { data: { activeTargets: [{ labels: { job: 'node' }, health: 'down', lastError: 'connection refused' }, { labels: { job: 'api' }, health: 'up' }] } };
    if (path === '/api/v2/status') return { versionInfo: { version: '0.27.0' }, uptime: 'u', cluster: { status: 'ready', peers: [{ name: 'a' }] }, config: { original: 'receivers:\n- name: team-pager\n- name: "slack"\n' } };
    return {};
  });
  try {
    const p = await queryMetricsTool.execute({ target: 'p', operation: 'status' }, ctx(conn('prometheus', be.base)));
    assert.match(p.text, /Version: 3\.1\.0/);
    assert.match(p.text, /Config reload: FAILED/);
    assert.match(p.text, /Active series: 1234/);
    assert.match(p.text, /2, 1 not up/);
    assert.match(p.text, /connection refused/);
    const a = await alertsTool.execute({ target: 'a', operation: 'status' }, ctx(conn('alertmanager', be.base)));
    assert.match(a.text, /0\.27\.0/);
    assert.match(a.text, /team-pager, slack/);
    const l = await queryLogsTool.execute({ target: 'l' } as never, ctx(conn('loki', be.base)));
    assert.equal(l.ok, false, 'search still needs a query');
  } finally {
    await be.close();
  }
});

test('alerts are read from Prometheus connections', async () => {
  const be = await fakeProm(() => ({ data: { alerts: [{ labels: { alertname: 'A' }, state: 'firing' }] } }));
  try {
    const r = await fetchConnectionAlerts(conn('prometheus', be.base));
    assert.ok('alerts' in r && r.alerts.length === 1);
  } finally {
    await be.close();
  }
});

test('series are named the way people know the machine', () => {
  // A per-VM scrape job beats a cloud DNS instance name.
  assert.equal(seriesName({ instance: 'ip-10-0-4-20.ec2.internal:9100', job: 'billing-api-node-metrics', mountpoint: '/' }), 'billing-api /');
  // An explicit name label beats the job.
  assert.equal(seriesName({ instance: '10.0.4.20:9100', job: 'node', vm_name: 'web-1' }), 'web-1');
  // A generic job says nothing about the machine: fall back to the instance.
  assert.equal(seriesName({ instance: 'web-1:9100', job: 'node-exporter', mountpoint: '/var' }), 'web-1:9100 /var');
  // The namespace only when nothing more specific separates the series.
  assert.equal(seriesName({ namespace: 'shop', persistentvolumeclaim: 'data-0' }), 'data-0');
  assert.equal(seriesName({ job: 'node' }), 'job node');
});

test('the plain verdict is read from the report', () => {
  assert.equal(parseAction('**Action:** act now\n**Root cause:** x'), 'act_now');
  assert.equal(parseAction('- Action: can wait (schedule it)'), 'can_wait');
  assert.equal(parseAction('**Action:** none needed'), 'none');
  assert.equal(parseAction('no verdict here'), null);
});
