import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADVISORY_PROMPT, buildOpeningMessage, buildSystemPrompt } from './prompt.ts';

test('advisory runs say there is no access, and list no targets', () => {
  assert.ok(buildSystemPrompt(null, 'agent', { advisory: true }).endsWith(ADVISORY_PROMPT));
  assert.ok(!buildSystemPrompt(null, 'agent').includes('ADVISORY MODE'));

  const opening = buildOpeningMessage({ projectName: 'p', targets: [], task: 'nginx 502s', knowledge: 'PROJECT KNOWLEDGE ...', advisory: true });
  assert.match(opening, /Mode: advisory/);
  assert.match(opening, /PROJECT KNOWLEDGE/);
  assert.doesNotMatch(opening, /Targets you may act on/);
  assert.ok(opening.endsWith('Task:\nnginx 502s'));
});
