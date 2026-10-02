import { test } from 'node:test';
import assert from 'node:assert/strict';
import { asSeverity, judgeHealth } from './health-judge.ts';
import type { ScanFinding } from './health-judge.ts';

const f = (targetId: string, severity: ScanFinding['severity'], finding = 'x', reachable?: boolean): ScanFinding =>
  ({ targetId, severity, finding, ...(reachable === undefined ? {} : { reachable }) });

test('notices keep a target healthy but are kept as notes', () => {
  const j = judgeHealth([f('a', 'info'), f('a', 'notice', '12 updates pending'), f('a', 'notice', 'disk at 76%')], ['a']);
  assert.equal(j.states.get('a'), 'ok');
  assert.equal(j.summary.ok, 1);
  assert.equal(j.summary.degraded, 0);
  assert.equal(j.summary.notes, 2);
  assert.equal(j.summary.issues, 0);
  assert.deepEqual(j.issues.map((i) => i.severity), ['notice', 'notice']);
});

test('an essential problem degrades the target', () => {
  for (const sev of ['warning', 'critical'] as const) {
    const j = judgeHealth([f('a', 'notice'), f('a', sev, 'disk 96% on /var')], ['a']);
    assert.equal(j.states.get('a'), 'degraded');
    assert.equal(j.summary.degraded, 1);
    assert.equal(j.summary.issues, 1);
    assert.equal(j.summary.notes, 1);
  }
});

test('unreachable outranks everything, in any order', () => {
  const j = judgeHealth([f('a', 'info', 'ssh timed out', false), f('a', 'critical')], ['a']);
  assert.equal(j.states.get('a'), 'unreachable');
  const k = judgeHealth([f('a', 'critical'), f('a', 'info', 'ssh timed out', false)], ['a']);
  assert.equal(k.states.get('a'), 'unreachable');
  assert.equal(k.summary.unreachable, 1);
});

test('unflagged scoped targets are healthy; findings for unscoped targets are ignored', () => {
  const j = judgeHealth([f('a', 'critical'), f('zzz', 'critical')], ['a', 'b']);
  assert.equal(j.states.get('b'), 'ok');
  assert.equal(j.states.has('zzz'), false);
  assert.deepEqual(j.summary, { checked: 2, ok: 1, degraded: 1, unreachable: 0, issues: 1, notes: 0 });
});

test('issue title is the first line, capped', () => {
  const j = judgeHealth([f('a', 'warning', `${'y'.repeat(200)}\nsecond line`)], ['a']);
  assert.equal(j.issues[0]!.title.length, 120);
  assert.ok(j.issues[0]!.detail.includes('second line'));
});

test('unknown severities read as info', () => {
  assert.equal(asSeverity('bogus'), 'info');
  assert.equal(asSeverity('notice'), 'notice');
});
