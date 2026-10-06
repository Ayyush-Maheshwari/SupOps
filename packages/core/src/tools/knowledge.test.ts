import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExecContext, KnowledgeAccess } from './types.ts';
import { readKnowledgeTool, searchKnowledgeTool } from './knowledge.ts';

const access: KnowledgeAccess = {
  search: (q) => (q.includes('kafka') ? [{ slug: 'kafka-lag', title: 'Kafka consumer lag', kind: 'runbook', snippet: 'scale the consumers' }] : []),
  read: (slug) => (slug === 'kafka-lag' ? { slug, title: 'Kafka consumer lag', kind: 'runbook', body: '1. Check lag\n2. Scale consumers', source: 'ops.pdf, p. 3' } : null),
};
const ctx = (knowledge?: KnowledgeAccess) => ({ runId: 'r', toolCallId: 't', timeoutMs: 1000, maxOutputBytes: 1e5, signal: new AbortController().signal, ...(knowledge ? { knowledge } : {}) }) as unknown as ExecContext;

test('search lists matches by slug; read returns the whole document with its source', async () => {
  const s = await searchKnowledgeTool.execute({ target: 'x', query: 'kafka lag' }, ctx(access));
  assert.match(s.text, /Kafka consumer lag \[kafka-lag, runbook\]/);
  assert.match((await searchKnowledgeTool.execute({ target: 'x', query: 'nothing' }, ctx(access))).text, /No approved documents/);
  const r = await readKnowledgeTool.execute({ target: 'x', slug: 'kafka-lag' }, ctx(access));
  assert.equal(r.ok, true);
  assert.match(r.text, /from ops\.pdf, p\. 3/);
  assert.match(r.text, /2\. Scale consumers/);
  const miss = await readKnowledgeTool.execute({ target: 'x', slug: 'nope' }, ctx(access));
  assert.equal(miss.ok, false);
});

test('both are read-only, and do nothing without the engine-supplied access', async () => {
  assert.equal(searchKnowledgeTool.classifyArgs!({ target: 'x', query: 'q' } as never, {} as never)[0]!.tier, 'read_only');
  assert.equal(readKnowledgeTool.classifyArgs!({ target: 'x', slug: 's' } as never, {} as never)[0]!.tier, 'read_only');
  assert.equal((await readKnowledgeTool.execute({ target: 'x', slug: 'kafka-lag' }, ctx())).ok, false);
});
