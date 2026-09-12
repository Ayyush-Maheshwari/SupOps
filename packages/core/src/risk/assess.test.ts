import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISK_POLICY } from '@supops/db';
import type { RiskPolicy } from '@supops/db';
import type { ResolvedTarget, ToolDef } from '../tools/types.ts';
import { sshExecTool } from '../tools/builtin.ts';
import { assessRisk } from './index.ts';

const def = sshExecTool as unknown as ToolDef<never>;

const staging: ResolvedTarget = {
  id: 't1',
  slug: 'web-1',
  kind: 'ssh',
  env: 'staging',
  sensitivity: 1,
  description: 'app server',
  config: { kind: 'ssh', host: '10.0.0.5', port: 22, user: 'ops', sudo: true },
  credentialId: null,
  protectedPaths: null,
  writablePaths: null,
  unitAllowlist: null,
};
const prod: ResolvedTarget = { ...staging, slug: 'prod-db', env: 'prod' };

const assess = (command: string, target = staging, policy: RiskPolicy = DEFAULT_RISK_POLICY) =>
  assessRisk({
    def,
    args: { command },
    rendered: command,
    target,
    policy,
  });

test('read-only work runs without asking, even on production', () => {
  assert.equal(assess('df -h').decision, 'auto');
  assert.equal(assess('df -h', prod).decision, 'auto');
  assert.equal(assess('systemctl status nginx', prod).tier, 'read_only');
});

test('production raises a mutating action one tier; staging does not', () => {
  assert.equal(assess('systemctl restart nginx', staging).tier, 'medium');
  assert.equal(assess('systemctl restart nginx', prod).tier, 'high');
  assert.equal(assess('mkdir -p /tmp/x', prod).tier, 'medium');
});

test('medium and above require approval under the default policy', () => {
  assert.equal(assess('mkdir -p /tmp/x').decision, 'auto'); // low
  assert.equal(assess('systemctl restart nginx').decision, 'approve');
  assert.equal(assess('rm -rf /opt/cache').decision, 'approve');
});

test('forbidden is blocked outright, never queued for approval', () => {
  const v = assess('rm -rf /');
  assert.equal(v.tier, 'forbidden');
  assert.equal(v.decision, 'block');
});

test('a model risk hint can raise a tier but never lower one', () => {
  // The realistic attack is tool output that tells the agent an action is safe.
  const lowered = assessRisk({
    def,
    args: { command: 'rm -rf /opt/app' },
    rendered: 'rm -rf /opt/app',
    target: staging,
    policy: DEFAULT_RISK_POLICY,
    modelHint: 'read_only',
  });
  assert.equal(lowered.tier, 'high', 'a model claiming safety must not lower the tier');

  const raised = assessRisk({
    def,
    args: { command: 'df -h' },
    rendered: 'df -h',
    target: staging,
    policy: DEFAULT_RISK_POLICY,
    modelHint: 'high',
  });
  assert.equal(raised.tier, 'high', 'a model flagging danger must be able to raise the tier');
});

test('a permissive policy widens auto-execution but cannot reach forbidden', () => {
  const permissive: RiskPolicy = { ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'high' };
  assert.equal(assess('rm -rf /opt/cache', staging, permissive).decision, 'auto');
  assert.equal(assess('rm -rf /', staging, permissive).decision, 'block');
});

test('every assessment carries an explanation for the approver', () => {
  const v = assess('systemctl restart nginx', prod);
  assert.ok(v.contributions.some((c) => c.stage === 'baseline'));
  assert.ok(v.contributions.some((c) => c.stage === 'arguments'));
  assert.ok(v.contributions.some((c) => c.stage === 'target'));
  assert.ok(v.contributions.every((c) => c.reason.length > 0));
});
