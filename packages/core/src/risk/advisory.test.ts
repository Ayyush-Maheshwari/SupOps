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
