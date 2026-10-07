import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ResolvedTarget } from '../tools/types.ts';
import { scanSignal, seriesFilterQuery } from './scan.ts';
import { assessSeries } from './vulnerability.ts';

const HOUR = 3_600_000;
const disk = { unit: 'bytes', badDirection: 'down' as const, limit: { value: 0, when: 'below' as const } };
const cpu = { unit: 'percent', badDirection: 'up' as const, limit: null, minDelta: 10 };

test('a disk filling steadily is scored by how soon it runs out', () => {
  // 10 GB free, losing 1 GB an hour in both windows: about 10 hours left.
  const a = assessSeries({ key: 'k', labels: {}, value: 10e9, deriv6h: -1e9 / 3600, deriv1d: -0.9e9 / 3600 }, disk, [10e9, 50e9]);
  assert.ok(a.forecast && Math.abs(a.forecast.etaMs - 10 * HOUR) < 60_000);
  assert.equal(a.forecast!.confidence, 'high');
  assert.equal(a.score, 85);
  assert.match(a.reasons[0]!, /runs out in 10h/);
  // Sooner is worse.
  assert.equal(assessSeries({ key: 'k', labels: {}, value: 2e9, deriv6h: -1e9 / 3600, deriv1d: -1e9 / 3600 }, disk, []).score, 95);
});

test('a sudden drop that the last day does not show is low confidence', () => {
  const a = assessSeries({ key: 'k', labels: {}, value: 10e9, deriv6h: -1e9 / 3600, deriv1d: 0.1e9 / 3600 }, disk, []);
  assert.equal(a.forecast!.confidence, 'low');
  assert.ok(a.score < 85);
});

test('unusual means far from the last day and not like yesterday', () => {
  const now = { key: 'k', labels: {}, value: 92, avg1d: 30, sd1d: 5 };
  const a = assessSeries({ ...now, yesterday: 28 }, cpu, [92, 30]);
  assert.ok(a.anomaly);
  assert.ok(a.score >= 72);
  // The same spike at this hour yesterday: a pattern (a nightly job), not an anomaly.
  assert.equal(assessSeries({ ...now, yesterday: 90 }, cpu, [92, 30]).anomaly, null);
  // The harmless direction is never unusual.
  assert.equal(assessSeries({ key: 'k', labels: {}, value: 1, avg1d: 30, sd1d: 5, yesterday: 30 }, cpu, []).anomaly, null);
});

test('without a limit, series are ranked against their peers', () => {
  const restarts = { unit: 'count', badDirection: 'up' as const, limit: null };
  const peers = [0, 0, 3, 12];
  const top = assessSeries({ key: 'a', labels: {}, value: 12 }, restarts, peers);
  const mid = assessSeries({ key: 'b', labels: {}, value: 3 }, restarts, peers);
  const none = assessSeries({ key: 'c', labels: {}, value: 0 }, restarts, peers);
  assert.ok(top.score > mid.score && mid.score > none.score);
  assert.deepEqual(top.reasons, ['highest of 4']);
});

test('a series can be picked out of any query by its labels', () => {
  assert.equal(
    seriesFilterQuery('sum by (instance) (x)', { instance: 'web-1:9100', job: 'a"b' }),
    '(sum by (instance) (x)) and on(instance, job) label_replace(label_replace(vector(1), "instance", "web-1:9100", "", ""), "job", "a\\"b", "", "")',
  );
  assert.equal(seriesFilterQuery('up', {}), 'up');
});

test('one scan covers every series, with the day and trend alongside', async () => {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    const q = new URL(req.url!, 'http://x').searchParams.get('query') ?? '';
    seen.push(q);
    const rows = Array.from({ length: 120 }, (_, i) => ({ metric: { instance: `vm-${i}` }, value: [0, String(
      q.startsWith('avg_over_time') ? 50 : q.startsWith('stddev') ? 2 : q.includes('offset 1d') ? 49 : q.startsWith('deriv') ? -0.001 : 40 + i,
    )] }));
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ status: 'success', data: { resultType: 'vector', result: rows } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  try {
    const target = { id: 'p', slug: 'p', kind: 'prometheus', env: 'prod', config: { kind: 'prometheus', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, allowPrivateNetwork: true } } as unknown as ResolvedTarget;
    const r = await scanSignal(target, 'x', { withTrend: true });
    assert.ok('series' in r);
    assert.equal(r.series.length, 120, 'every series, not the first 50');
    const s = r.series.find((x) => x.labels.instance === 'vm-7')!;
    assert.deepEqual([s.value, s.avg1d, s.sd1d, s.yesterday, s.deriv6h], [47, 50, 2, 49, -0.001]);
    assert.equal(seen.length, 6);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

test('built-in levels: any scrape target down, or load above the core count, is a problem', () => {
  const down = assessSeries({ key: 'k', labels: {}, value: 1 }, { unit: 'count', badDirection: 'up', limit: null, warn: 1, crit: 3 }, [0, 1]);
  assert.equal(down.score, 62);
  const load = assessSeries({ key: 'k', labels: {}, value: 1.9 }, { unit: 'ratio', badDirection: 'up', limit: null, warn: 1, crit: 1.5 }, [0.4, 1.9]);
  assert.equal(load.score, 80);
  assert.match(load.reasons[0]!, /at or above 1.5/);
  const cert = assessSeries({ key: 'k', labels: {}, value: 10 }, { unit: 'days', badDirection: 'down', limit: null, warn: 14, crit: 3 }, []);
  assert.equal(cert.score, 62);
});

test('over a limit is a breach, worse when still moving the wrong way', () => {
  const used = { unit: 'percent', badDirection: 'up' as const, limit: { value: 75, when: 'above' as const } };
  const stable = assessSeries({ key: 'k', labels: {}, value: 78.5, deriv6h: 0, deriv1d: 0 }, used, []);
  assert.equal(stable.forecast?.over, true);
  assert.equal(stable.forecast?.worsening, false);
  assert.equal(stable.score, 72);
  assert.match(stable.reasons[0]!, /over its limit of 75%/);
  const rising = assessSeries({ key: 'k', labels: {}, value: 78.5, deriv6h: 0.001, deriv1d: 0.001 }, used, []);
  assert.equal(rising.score, 90);
  assert.match(rising.reasons[0]!, /still rising/);
});
