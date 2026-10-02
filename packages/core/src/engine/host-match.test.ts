import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TargetConfig } from '@supops/db';
import { hostForms, matchTargetsByHost, parseHostAddresses, withJumps } from './host-match.ts';

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
