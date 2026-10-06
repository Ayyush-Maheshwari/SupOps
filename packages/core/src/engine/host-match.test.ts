import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TargetConfig } from '@supops/db';
import { hostCandidates, hostForms, matchTargetsByHost, matchTargetsEmbedded, parseHostAddresses, scopeAlert, withJumps, withMachinesBehind } from './host-match.ts';

const ssh = (id: string, slug: string, extra: Record<string, unknown> = {}) => ({
  id, slug, kind: 'ssh',
  config: { kind: 'ssh', host: '203.0.113.5', port: 22, user: 'ec2-user', sudo: false, ...extra } as TargetConfig,
});

const jump = ssh('j', 'jumphost', { addresses: ['jump-metrics', '10.0.4.20'] });
const behindA = ssh('a', 'worker1', { via: { alias: 'worker1' }, addresses: ['10.0.4.40'] });
const behindB = ssh('b', 'logstore1', { via: { alias: 'logstore1' } });
const cluster = { id: 'k', slug: 'prod', kind: 'k8s', config: { kind: 'k8s', allowedNamespaces: [] } as unknown as TargetConfig };
const all = [jump, behindA, behindB, cluster];

test('alert host values are normalised: ports, AWS private names, short names', () => {
  assert.deepEqual(hostForms('10.0.4.20:9100'), ['10.0.4.20']);
  assert.deepEqual(hostForms('ip-10-0-4-20.us-east-1.compute.internal'), [
    'ip-10-0-4-20.us-east-1.compute.internal', 'ip-10-0-4-20', '10.0.4.20',
  ]);
  assert.deepEqual(hostForms('Jump-Metrics'), ['jump-metrics']);
  assert.deepEqual(hostForms(''), []);
});

test('an alert about the jump matches the jump, not every machine behind it', () => {
  for (const v of ['ip-10-0-4-20.us-east-1.compute.internal', '10.0.4.20:9100', 'jump-metrics']) {
    assert.deepEqual(matchTargetsByHost(all, v).map((t) => t.slug), ['jumphost'], v);
  }
  // The jump's public address is shared by the machines behind it, but is only the jump's own.
  assert.deepEqual(matchTargetsByHost(all, '203.0.113.5').map((t) => t.slug), ['jumphost']);
});

test('machines behind a jump match by alias and recorded address', () => {
  assert.deepEqual(matchTargetsByHost(all, 'logstore1:9100').map((t) => t.slug), ['logstore1']);
  assert.deepEqual(matchTargetsByHost(all, 'ip-10-0-4-40.ec2.internal').map((t) => t.slug), ['worker1']);
  assert.deepEqual(matchTargetsByHost(all, 'nothing-like-it'), []);
});

test('a scope with machines behind a jump also includes the jump', () => {
  assert.deepEqual(withJumps([behindB, cluster], all).map((t) => t.slug), ['logstore1', 'prod', 'jumphost']);
  assert.deepEqual(withJumps([cluster], all).map((t) => t.slug), ['prod']);
  assert.deepEqual(withJumps([jump, behindA], all).map((t) => t.slug), ['jumphost', 'worker1']);
});

test('a scoped jump brings the machines behind it, as the Investigate picker does', () => {
  assert.deepEqual(withMachinesBehind([jump], all).map((t) => t.slug), ['jumphost', 'worker1', 'logstore1']);
  assert.deepEqual(withMachinesBehind([behindA, cluster], all).map((t) => t.slug), ['worker1', 'prod']);
});

const envd = all.map((t) => ({ ...t, env: t.kind === 'k8s' ? 'staging' : 'prod' }));
const alert = (o: Partial<Parameters<typeof scopeAlert>[0]>) => ({ labels: {}, title: 'HostHighLoad', summary: null, channelName: null, ...o });
const slugs = (r: { targets: Array<{ slug: string }> }) => r.targets.map((t) => t.slug).sort();

test('an alert matched to the jump can still reach the machines behind it', () => {
  const r = scopeAlert(alert({ labels: { instance: '10.0.4.20:9100' } }), envd);
  assert.deepEqual(r.matched.map((t) => t.slug), ['jumphost']);
  assert.deepEqual(slugs(r), ['jumphost', 'logstore1', 'worker1']);
  assert.equal(r.by, 'label');
});

test('an alert about one machine behind a jump scopes to it and its jump, not its siblings', () => {
  const r = scopeAlert(alert({ labels: { instance: 'ip-10-0-4-40.ec2.internal' } }), envd);
  assert.deepEqual(slugs(r), ['jumphost', 'worker1']);
});

test('with no host label, a machine named in the alert text is found', () => {
  const r = scopeAlert(alert({ title: 'HostOutOfDiskSpace', summary: 'Disk is almost full on logstore1 (/ at 95%)' }), envd);
  assert.deepEqual(r.matched.map((t) => t.slug), ['logstore1']);
  assert.deepEqual(slugs(r), ['jumphost', 'logstore1']);
  assert.equal(r.by, 'text');
});

test('a machine whose name is embedded in a longer one in the alert is found', () => {
  const coder = ssh('c', 'coderunner', { via: { alias: 'coderunner' } });
  const bastion = ssh('u', 'bastion');
  const pool = [bastion, coder, behindB].map((t) => ({ ...t, env: 'staging' }));
  // The alert carries only an IP no target has recorded, and the instance's AWS name.
  const r = scopeAlert(
    alert({ title: 'HostOutOfDiskSpace', labels: { instance: '10.0.7.15:9100', name: 'acme-code-runner-restored' }, channelName: '#acme-alerts' }),
    pool,
  );
  assert.deepEqual(r.matched.map((t) => t.slug), ['coderunner']);
  assert.equal(r.by, 'text');
  assert.deepEqual(slugs(r), ['bastion', 'coderunner'], 'its jump comes too, its siblings do not');
  // Short names are never matched inside other words: "acme" alone would not count.
  assert.ok(!matchTargetsEmbedded([ssh('a', 'acme')], ['acme-code-runner-restored']).length);
});

test('the channel name narrows to an environment, and a jump there brings its machines', () => {
  // "prod" is both the machines' environment and the cluster's slug, so all of them.
  const r = scopeAlert(alert({ channelName: '#acme-prod-alerts' }), envd);
  assert.deepEqual(slugs(r), ['jumphost', 'logstore1', 'prod', 'worker1']);
  assert.equal(r.by, 'channel');
});

test('nothing recognisable leaves the run unscoped', () => {
  const r = scopeAlert(alert({ summary: 'something went wrong somewhere', channelName: '#general' }), envd);
  assert.deepEqual(r.targets, []);
  assert.equal(r.reason, null);
});

test('host candidates are the host-like words of the text', () => {
  assert.deepEqual(hostCandidates('Disk full on `web-1` (10.0.4.40:9100), 95%'), ['Disk', 'full', 'web-1', '10.0.4.40:9100']);
});

test('host addresses are parsed from hostname output, without loopback or link-local', () => {
  assert.deepEqual(
    parseHostAddresses('supops-ok\njump-metrics\n10.0.4.20 172.17.0.1 127.0.0.1 fe80::1 2406:da1a::5 \n'),
    ['jump-metrics', '10.0.4.20', '172.17.0.1', '2406:da1a::5'],
  );
});

test('the opening message lists addresses so the agent can map an alert to a machine', async () => {
  const { buildOpeningMessage } = await import('./prompt.ts');
  const msg = buildOpeningMessage({
    projectName: 'p',
    task: 'disk full on ip-10-0-4-20',
    targets: [
      { slug: 'jumphost', kind: 'ssh', env: 'prod', description: null, addresses: ['jump-metrics', '10.0.4.20'] },
      { slug: 'worker1', kind: 'ssh', env: 'prod', description: 'Behind 203.0.113.5 (ssh worker1)', addresses: ['10.0.4.40'] },
    ],
  });
  assert.match(msg, /- jumphost \(ssh, env=prod\) \[also known as jump-metrics, 10\.0\.4\.20\]/);
  assert.match(msg, /Addresses of machines behind a jump: worker1=10\.0\.4\.40/);
  assert.match(msg, /about a jump host itself/);
});
