import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISK_POLICY } from '@supops/db';
import { canDecide, globalRolesMeeting, requiredRole } from './approval.ts';

const base = {
  policy: DEFAULT_RISK_POLICY, // medium: operator, high: admin, second person at high
  startedBy: 'alice',
  eligibleApprovers: 3,
};
const member = { id: 'bob', globalRole: 'member' };
const admin = { id: 'carol', globalRole: 'admin' };
const aliceAdmin = { id: 'alice', globalRole: 'admin' };

test('the role each tier needs comes from the policy', () => {
  assert.equal(requiredRole('medium', DEFAULT_RISK_POLICY), 'operator');
  assert.equal(requiredRole('high', DEFAULT_RISK_POLICY), 'admin');
  assert.deepEqual(globalRolesMeeting('admin'), ['owner', 'admin']);
  assert.deepEqual(globalRolesMeeting('operator'), ['owner', 'admin', 'member']);
});

test('a member can approve medium but not high', () => {
  assert.deepEqual(canDecide({ ...base, decision: 'approve', tier: 'medium', decider: member }), { ok: true, selfApproved: false });
  const high = canDecide({ ...base, decision: 'approve', tier: 'high', decider: member });
  assert.equal(high.ok, false);
  assert.match((high as { reason: string }).reason, /needs an admin/);
});

test('anyone signed in can deny, at any tier', () => {
  assert.equal(canDecide({ ...base, decision: 'deny', tier: 'high', decider: member }).ok, true);
  assert.equal(canDecide({ ...base, decision: 'deny', tier: 'high', decider: aliceAdmin }).ok, true);
});

test('high-risk actions need someone other than whoever started the run', () => {
  const own = canDecide({ ...base, decision: 'approve', tier: 'high', decider: aliceAdmin });
  assert.equal(own.ok, false);
  assert.match((own as { reason: string }).reason, /second person/);
  assert.deepEqual(canDecide({ ...base, decision: 'approve', tier: 'high', decider: admin }), { ok: true, selfApproved: false });
  // Below the second-person tier, approving your own run is fine.
  assert.deepEqual(canDecide({ ...base, decision: 'approve', tier: 'medium', decider: aliceAdmin }), { ok: true, selfApproved: false });
});

test('a single-approver install can self-approve, and it is flagged', () => {
  assert.deepEqual(
    canDecide({ ...base, eligibleApprovers: 1, decision: 'approve', tier: 'high', decider: aliceAdmin }),
    { ok: true, selfApproved: true },
  );
});

test('runs nobody started (alerts, schedules) have no second-person conflict', () => {
  assert.deepEqual(
    canDecide({ ...base, startedBy: null, decision: 'approve', tier: 'high', decider: aliceAdmin }),
    { ok: true, selfApproved: false },
  );
});
