import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandOfLine, rateSuggestedCommand } from './advisory.ts';

test('suggested commands are rated by the same engine as live ones', () => {
  assert.equal(rateSuggestedCommand('df -h').tier, 'read_only');
  assert.notEqual(rateSuggestedCommand('systemctl restart nginx').tier, 'read_only');
  assert.equal(rateSuggestedCommand('rm -rf /').tier, 'forbidden');
});

test('a <placeholder> is a name to fill in, not a redirection', () => {
  assert.equal(rateSuggestedCommand('systemctl status <app-service>').tier, 'read_only');
  assert.equal(rateSuggestedCommand('kubectl logs <pod> -n <namespace>').tier, 'read_only');
});

test('comment, blank and prompt-prefixed lines', () => {
  assert.equal(commandOfLine('# shows disk usage'), null);
  assert.equal(commandOfLine('   '), null);
  assert.equal(commandOfLine('$ df -h'), 'df -h');
});

test('a command the ruleset does not know is "not recognised", not called risky', () => {
  const r = rateSuggestedCommand('pg_isready -h db-1 -p 5432');
  assert.equal(r.recognised, false);
  assert.equal(rateSuggestedCommand('systemctl restart nginx').recognised, true);
  assert.equal(rateSuggestedCommand('df -h').recognised, true);
  // Unknown joined to something dangerous is still judged on the dangerous part.
  assert.equal(rateSuggestedCommand('pg_isready && rm -rf /').recognised, true);
});
