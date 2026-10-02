import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISK_POLICY } from '@supops/db';
import type { RiskPolicy } from '@supops/db';
import { autoCeiling } from '@supops/shared';
import { mergePolicy, projectCeiling, validateAgentOverride, validateProjectPolicy } from './policy.ts';

const project: RiskPolicy = { ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'low', autoExecuteCeiling: 'medium' };

test('defaults: low auto-runs, high never, prod capped at low, health read-only, alerts low', () => {
  const p = DEFAULT_RISK_POLICY;
  assert.equal(autoCeiling({ policy: p, sensitive: false }).tier, 'low');
  assert.equal(autoCeiling({ policy: { ...p, autoExecuteMaxTier: 'high' }, sensitive: false }).tier, 'medium');
  assert.equal(autoCeiling({ policy: { ...p, autoExecuteMaxTier: 'medium' }, sensitive: true }).tier, 'low');
  assert.equal(autoCeiling({ policy: p, sensitive: false, trigger: 'health' }).tier, 'read_only');
  assert.equal(autoCeiling({ policy: { ...p, autoExecuteMaxTier: 'medium' }, sensitive: false, trigger: 'alert' }).tier, 'low');
  assert.equal(autoCeiling({ policy: { ...p, autoExecuteMaxTier: 'medium' }, sensitive: false, trigger: 'chat' }).tier, 'medium');
});

test('the ceiling reason names what set the limit', () => {
  assert.match(autoCeiling({ policy: { ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'medium' }, sensitive: true }).reason, /production/);
  assert.match(autoCeiling({ policy: DEFAULT_RISK_POLICY, sensitive: false, trigger: 'health' }).reason, /health-triggered/);
  assert.match(
    autoCeiling({ policy: { ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'medium', toolAutoExecuteCap: { run_script: 'read_only' } }, sensitive: false, toolKey: 'run_script' }).reason,
    /run_script/,
  );
});

test('an agent may be raised up to the project ceiling, never past it', () => {
  assert.equal(mergePolicy(project, { autoExecuteMaxTier: 'medium' }).autoExecuteMaxTier, 'medium');
  assert.equal(mergePolicy(project, { autoExecuteMaxTier: 'high' }).autoExecuteMaxTier, 'medium', 'clamped');
  const strict = { ...project, autoExecuteCeiling: 'low' as const };
  assert.equal(mergePolicy(strict, { autoExecuteMaxTier: 'medium' }).autoExecuteMaxTier, 'low', 'a lowered ceiling reins in old overrides');
  assert.match(String(validateAgentOverride(strict, { autoExecuteMaxTier: 'medium' })), /only up to low/);
  assert.equal(validateAgentOverride(project, { autoExecuteMaxTier: 'medium' }), null);
});

test('every other override field can only make things stricter', () => {
  const m = mergePolicy(project, {
    prodAutoExecuteCap: 'medium', // looser than project's default low -> ignored
    requireSecondPersonAtTier: 'medium', // stricter than high -> applied
    approverRoleByTier: { medium: 'viewer', high: 'owner' }, // viewer is weaker -> ignored; owner stronger -> applied
    ttlMsByTier: { medium: 60 * 60_000, high: 60_000 }, // longer ignored, shorter applied
    triggerAutoExecuteCap: { alert: 'read_only' },
    onExpiry: 'abort_run',
  });
  assert.equal(m.prodAutoExecuteCap ?? 'low', 'low');
  assert.equal(m.requireSecondPersonAtTier, 'medium');
  assert.equal(m.approverRoleByTier.medium, 'operator');
  assert.equal(m.approverRoleByTier.high, 'owner');
  assert.equal(m.ttlMsByTier.medium, 30 * 60_000);
  assert.equal(m.ttlMsByTier.high, 60_000);
  assert.equal(m.triggerAutoExecuteCap?.alert, 'read_only');
  assert.equal(m.onExpiry, 'abort_run');

  const lax = mergePolicy(project, { requireSecondPersonAtTier: null, onExpiry: 'continue_as_denied' });
  assert.equal(lax.requireSecondPersonAtTier, 'high', 'an agent cannot remove the second-person rule');
});

test('no project setting can make high-risk actions run on their own', () => {
  assert.equal(projectCeiling({ ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'high', autoExecuteCeiling: 'high' }), 'medium');
  assert.match(String(validateProjectPolicy({ ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'high' })), /always need a human/);
  assert.match(String(validateProjectPolicy({ ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'medium', autoExecuteCeiling: 'low' })), /cannot be lower/);
  assert.equal(validateProjectPolicy({ ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'low', autoExecuteCeiling: 'medium' }), null);
});

test('the opening message states the effective autonomy in plain words', async () => {
  const { describeAutonomy } = await import('@supops/shared');
  assert.equal(
    describeAutonomy(DEFAULT_RISK_POLICY),
    'Actions up to low risk run on their own here; everything else waits for a human, and forbidden actions never run.',
  );
  assert.match(
    describeAutonomy({ ...DEFAULT_RISK_POLICY, autoExecuteMaxTier: 'medium' }),
    /up to medium risk run on their own here; on production and sensitive targets, actions up to low risk/,
  );
  assert.match(describeAutonomy(DEFAULT_RISK_POLICY, 'health'), /^Only read-only actions run/);
});
