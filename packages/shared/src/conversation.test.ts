import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConversationValid, ConversationInvariantError } from './conversation.ts';
import { maxTier, isApprovable } from './risk.ts';
import { assertSchemaProfile } from './chat.ts';
import type { ChatMessage } from './chat.ts';

const call = (id: string, name: string) => ({
  id,
  type: 'function' as const,
  function: { name, arguments: '{}' },
});

const valid: ChatMessage[] = [
  { role: 'system', content: 'you are an ops agent' },
  { role: 'user', content: 'checkout is 500ing' },
  { role: 'assistant', content: null, tool_calls: [call('c1', 'ssh_exec'), call('c2', 'ssh_exec')] },
  { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  { role: 'tool', tool_call_id: 'c2', content: 'ok' },
  { role: 'assistant', content: 'worker pool was wedged' },
];

test('accepts a well-formed conversation with parallel tool calls', () => {
  assertConversationValid(valid);
});

test('accepts a conversation with no tool calls at all', () => {
  assertConversationValid([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
  ]);
});

test('rejects a partially-answered tool batch (the suspend/resume bug)', () => {
  // This is exactly what a naive "execute what you can, park the rest" resume produces.
  const broken: ChatMessage[] = [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: null, tool_calls: [call('c1', 'a'), call('c2', 'b')] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: 'done' },
  ];
  assert.throws(() => assertConversationValid(broken), ConversationInvariantError);
});

test('rejects a truncated conversation that ends mid-batch', () => {
  assert.throws(
    () =>
      assertConversationValid([
        { role: 'user', content: 'x' },
        { role: 'assistant', content: null, tool_calls: [call('c1', 'a')] },
      ]),
    /ends after 0/,
  );
});

test('rejects out-of-order tool replies', () => {
  assert.throws(
    () =>
      assertConversationValid([
        { role: 'user', content: 'x' },
        { role: 'assistant', content: null, tool_calls: [call('c1', 'a'), call('c2', 'b')] },
        { role: 'tool', tool_call_id: 'c2', content: 'ok' },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ]),
    /out of order/,
  );
});

test('rejects an orphan tool message', () => {
  assert.throws(
    () =>
      assertConversationValid([
        { role: 'user', content: 'x' },
        { role: 'tool', tool_call_id: 'nope', content: 'ok' },
      ]),
    /orphan/,
  );
});

test('rejects duplicate tool_call ids', () => {
  assert.throws(
    () =>
      assertConversationValid([
        { role: 'user', content: 'x' },
        { role: 'assistant', content: null, tool_calls: [call('c1', 'a')] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
        { role: 'assistant', content: null, tool_calls: [call('c1', 'a')] },
        { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      ]),
    /duplicate/,
  );
});

test('risk tiers only ever join upward', () => {
  assert.equal(maxTier('read_only', 'high', 'low'), 'high');
  assert.equal(maxTier('read_only'), 'read_only');
  assert.equal(maxTier(), 'read_only');
  assert.equal(maxTier('medium', 'forbidden'), 'forbidden');
});

test('forbidden is never approvable', () => {
  assert.equal(isApprovable('high'), true);
  assert.equal(isApprovable('forbidden'), false);
});

test('schema profile rejects keys backends silently drop', () => {
  assert.throws(
    () =>
      assertSchemaProfile({
        type: 'object',
        properties: { worker_id: { type: 'string', pattern: '^w-[0-9]+$' } as never },
      }),
    /pattern/,
  );
  // The supported subset passes.
  assertSchemaProfile({
    type: 'object',
    properties: { target: { type: 'string', enum: ['web-1'], description: 'host' } },
    required: ['target'],
  });
});
