import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConversationValid } from '@supops/shared';
import type { ChatMessage } from '@supops/shared';
import { estimateTokens, fitToContext } from './context.ts';

/** A run with `n` tool calls, each returning `size` characters of output. */
function conversation(n: number, size: number): ChatMessage[] {
  const msgs: ChatMessage[] = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'investigate' },
  ];
  for (let i = 0; i < n; i += 1) {
    msgs.push({ role: 'assistant', content: null, tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'ssh_exec', arguments: '{"command":"journalctl"}' } }] });
    msgs.push({ role: 'tool', tool_call_id: `c${i}`, content: `[exit 0]\nline-start-${i}\n${'x'.repeat(size)}\nline-end-${i}` });
  }
  return msgs;
}

test('a conversation within budget is sent untouched', () => {
  const msgs = conversation(5, 2000);
  const r = fitToContext(msgs, 64_000);
  assert.equal(r.elided, 0);
  assert.equal(r.messages, msgs);
});

test('over budget, the oldest large outputs are elided first and recent ones kept whole', () => {
  const msgs = conversation(40, 16_000); // ~180k estimated tokens
  const r = fitToContext(msgs, 64_000);
  assert.ok(r.elided > 0);
  assert.ok(estimateTokens(r.messages) <= 64_000, `still ${estimateTokens(r.messages)} tokens`);
  const tools = r.messages.filter((m) => m.role === 'tool');
  assert.match(String(tools[0]!.content), /elided to keep the conversation/);
  assert.match(String(tools[0]!.content), /line-start-0/, 'the note keeps how the output began');
  for (const t of tools.slice(-6)) assert.doesNotMatch(String(t.content), /elided/, 'recent outputs stay whole');
});

test('elision never breaks tool-call pairing and never edits the input', () => {
  const msgs = conversation(40, 16_000);
  const before = JSON.stringify(msgs);
  const r = fitToContext(msgs, 30_000);
  assert.doesNotThrow(() => assertConversationValid(r.messages));
  assert.equal(JSON.stringify(msgs), before, 'the stored history object is not mutated');
});

test('small outputs are never elided individually (old turns are folded instead)', () => {
  const r = fitToContext(conversation(60, 500), 1_000);
  assert.ok(r.messages.filter((m) => m.role === 'tool').every((m) => !String(m.content).includes('elided')));
  assert.doesNotThrow(() => assertConversationValid(r.messages));
});

test('when eliding outputs is not enough, the oldest whole exchanges fold into a recap', () => {
  const msgs = conversation(60, 900); // many small outputs: nothing to elide, still too big
  const r = fitToContext(msgs, 6_000);
  assert.ok(r.messages.length < msgs.length);
  assert.doesNotThrow(() => assertConversationValid(r.messages));
  assert.equal(r.messages[0], msgs[0]);
  assert.equal(r.messages[1], msgs[1], 'the original task is always kept');
  assert.match(String(r.messages[2]!.content), /summarised by SupOps/);
  assert.match(String(r.messages[2]!.content), /ran ssh_exec/);
  const last = msgs.at(-1)!;
  assert.equal(r.messages.at(-1), last, 'the most recent exchange is untouched');
});
