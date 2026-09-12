import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { assertConversationValid } from '@supops/shared';
import { runs, toolCalls } from '@supops/db';
import { RetryableLLMError } from '../llm/errors.ts';
import { RunStore } from './store.ts';
import {
  ScriptedLLM,
  SpyTool,
  freshDb,
  makeEngine,
  seedRun,
  toolCall,
} from './harness.test-util.ts';

const SPEC = [
  {
    type: 'function' as const,
    function: {
      name: 'shell',
      description: 'test shell',
      parameters: {
        type: 'object' as const,
        properties: {
          target: { type: 'string' as const, enum: ['web-1'] },
          command: { type: 'string' as const },
        },
        required: ['target', 'command'],
      },
    },
  },
];

test('read-only work executes without asking anyone', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'df -h' })] },
    { role: 'assistant', content: 'Disk is at 41%. Nothing wrong here.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);

  await engine.runToCompletion(runId);

  assert.deepEqual(spy.executions, ['df -h']);
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'succeeded');
});

test('a risky action suspends the run and waits for a human', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })],
    },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);

  await engine.runToCompletion(runId);

  // Nothing ran, and the run is parked rather than failed.
  assert.deepEqual(spy.executions, [], 'a medium-risk action must not execute unapproved');
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  assert.equal(run?.status, 'awaiting_approval');

  const call = db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).get();
  assert.equal(call?.state, 'awaiting_approval');
  assert.equal(call?.tier, 'medium');
  assert.equal(call?.renderedCommand, 'systemctl restart nginx');
  // The approver needs to know why, not just that.
  assert.ok(call?.riskJson?.contributions.some((c) => c.reason.includes('systemctl restart')));
});

/**
 * The central claim of the product: a run suspended at an approval gate survives the
 * process dying, and resumes on completely fresh objects.
 */
test('a suspended run resumes correctly after the worker process dies', async () => {
  const db = freshDb();
  const script = [
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })],
    },
    { role: 'assistant' as const, content: 'nginx is back up and healthy.' },
  ];

  // --- process 1: reaches the gate, then "crashes" ---
  const spy1 = new SpyTool();
  const engine1 = makeEngine(db, new ScriptedLLM(script), [spy1.def()]);
  const runId = seedRun(db, SPEC);
  await engine1.runToCompletion(runId);
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'awaiting_approval');

  // A human approves, hours later.
  const pending = db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).get()!;
  db.update(toolCalls)
    .set({ state: 'approved', decidedAt: new Date(), decisionComment: 'go ahead' })
    .where(eq(toolCalls.id, pending.id))
    .run();
  db.update(runs).set({ status: 'queued' }).where(eq(runs.id, runId)).run();

  // --- process 2: entirely new engine, LLM and tool objects ---
  const spy2 = new SpyTool();
  const llm2 = new ScriptedLLM(script.slice(1));
  const engine2 = makeEngine(db, llm2, [spy2.def()]);
  engine2.store.recoverStaleRuns();
  await engine2.runToCompletion(runId);

  assert.deepEqual(spy2.executions, ['systemctl restart nginx'], 'approved action should run after resume');
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'succeeded');

  // The rebuilt conversation must be well-formed, and must carry the tool result.
  const sent = llm2.calls.at(-1)!;
  assertConversationValid(sent);
  const reply = sent.find((m) => m.role === 'tool');
  assert.ok(reply && 'content' in reply && reply.content.includes('ran: systemctl restart nginx'));
});

test('a denial is fed back as an error, and the agent continues instead of dying', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const script = [
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })],
    },
    { role: 'assistant' as const, content: 'Understood -- I will not restart it. Escalating instead.' },
  ];

  const engine1 = makeEngine(db, new ScriptedLLM(script), [spy.def()]);
  const runId = seedRun(db, SPEC);
  await engine1.runToCompletion(runId);

  const pending = db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).get()!;
  db.update(toolCalls)
    .set({ state: 'denied', decidedAt: new Date(), decisionComment: 'mid-deploy', isError: true })
    .where(eq(toolCalls.id, pending.id))
    .run();
  db.update(runs).set({ status: 'queued' }).where(eq(runs.id, runId)).run();

  const llm2 = new ScriptedLLM(script.slice(1));
  const engine2 = makeEngine(db, llm2, [spy.def()]);
  await engine2.runToCompletion(runId);

  assert.deepEqual(spy.executions, [], 'a denied command must never execute');
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'succeeded');

  const reply = llm2.calls.at(-1)!.find((m) => m.role === 'tool')!;
  assert.ok('content' in reply && reply.content.startsWith('ERROR:'), 'denial must be unmistakably an error');
  assert.ok('content' in reply && reply.content.includes('mid-deploy'), 'the approver reason must reach the agent');
});

/**
 * The most dangerous recovery bug there is: re-running a mutating command because we
 * do not know whether the first attempt took effect.
 */
test('a command interrupted mid-flight is never silently re-executed', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const script = [
    {
      role: 'assistant' as const,
      content: null,
      tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'df -h' })],
    },
    { role: 'assistant' as const, content: 'Checked current state before retrying.' },
  ];
  const engine1 = makeEngine(db, new ScriptedLLM(script), [spy.def()]);
  const runId = seedRun(db, SPEC);

  // Simulate: the call was dispatched, then the process died before the result landed.
  const store = new RunStore(db);
  const step = store.appendStep(runId, script[0]!);
  const call = store.createToolCalls(runId, step.id, [
    {
      toolCallId: 'c1',
      callIndex: 0,
      toolKey: 'shell',
      argsJson: { target: 'web-1', command: 'df -h' },
      argsHash: 'x',
    },
  ])[0]!;
  store.updateToolCall(call.id, { state: 'executing', startedAt: new Date() } as never);

  const recovered = store.recoverStaleRuns();
  assert.equal(recovered.toolCalls, 1);

  const after = db.select().from(toolCalls).where(eq(toolCalls.id, call.id)).get();
  assert.equal(after?.state, 'unknown_outcome');

  db.update(runs).set({ status: 'queued' }).where(eq(runs.id, runId)).run();
  const llm2 = new ScriptedLLM(script.slice(1));
  const engine2 = makeEngine(db, llm2, [spy.def()]);
  await engine2.runToCompletion(runId);

  assert.deepEqual(spy.executions, [], 'an unknown-outcome call must not be re-run');
  const reply = llm2.calls.at(-1)!.find((m) => m.role === 'tool')!;
  assert.ok('content' in reply && reply.content.includes('outcome unknown'));
  assert.ok('content' in reply && reply.content.includes('Verify the current state'));
});

test('a forbidden action is blocked outright and never offered for approval', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'rm -rf /' })] },
    { role: 'assistant', content: 'That is not something I can do.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);

  await engine.runToCompletion(runId);

  assert.deepEqual(spy.executions, []);
  const call = db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).get();
  assert.equal(call?.state, 'blocked');
  assert.equal(call?.tier, 'forbidden');
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'succeeded');
});

test('an invented target is corrected rather than executed', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'prod-db', command: 'df -h' })] },
    { role: 'assistant', content: 'Using web-1 instead.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);

  await engine.runToCompletion(runId);

  assert.deepEqual(spy.executions, []);
  const reply = llm.calls.at(-1)!.find((m) => m.role === 'tool')!;
  assert.ok('content' in reply && reply.content.includes('not a registered target'));
  assert.ok('content' in reply && reply.content.includes('web-1'), 'tell the model what IS valid');
});

/**
 * Gemini 3 attaches `extra_content.google.thought_signature` to every function call
 * and returns a 400 on the next request if it is not echoed back, so any code that
 * rebuilds a tool call from just the fields we care about breaks multi-turn tool use
 * outright. This is cheap to regress and expensive to diagnose -- the symptom is an
 * opaque provider error one turn later.
 */
test('provider-specific fields on a tool call survive persistence and replay', async () => {
  const db = freshDb();
  const spy = new SpyTool();

  const signed = toolCall('c1', 'shell', { target: 'web-1', command: 'df -h' });
  (signed as Record<string, unknown>).extra_content = {
    google: { thought_signature: 'OPAQUE-SIGNATURE-XYZ' },
  };

  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [signed] },
    { role: 'assistant', content: 'Disk is fine.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);

  await engine.runToCompletion(runId);

  // The second request must carry the signature back, byte-identical.
  const replayed = llm.calls.at(-1)!;
  const assistant = replayed.find((m) => m.role === 'assistant' && m.tool_calls?.length);
  assert.ok(assistant, 'assistant turn with tool_calls should be replayed');

  const call = (assistant as { tool_calls: Array<Record<string, unknown>> }).tool_calls[0]!;
  assert.deepEqual(
    call.extra_content,
    { google: { thought_signature: 'OPAQUE-SIGNATURE-XYZ' } },
    'provider-specific fields must be preserved verbatim through the database',
  );
});

/**
 * A rate-limited run must back off, not spin. The original bug retried every two
 * seconds indefinitely, which keeps the provider's limit tripped and is
 * indistinguishable from a hung run.
 */
test('repeated provider rate limits back off exponentially and eventually give up', async () => {
  const db = freshDb();
  const spy = new SpyTool();

  const alwaysLimited = {
    config: { baseUrl: 'http://test', apiKey: 't', model: 'test-model' },
    calls: [] as unknown[],
    async complete() {
      throw new RetryableLLMError('Provider returned 429: quota exceeded', 429, 2000);
    },
    asClient() {
      return this as unknown as ReturnType<ScriptedLLM['asClient']>;
    },
  };

  const engine = makeEngine(db, alwaysLimited as unknown as ScriptedLLM, [spy.def()]);
  const runId = seedRun(db, SPEC);

  const delays: number[] = [];
  for (let i = 0; i < 10; i += 1) {
    const before = Date.now();
    await engine.runToCompletion(runId);
    const run = db.select().from(runs).where(eq(runs.id, runId)).get()!;
    if (run.status === 'failed') break;
    assert.equal(run.status, 'suspended');
    delays.push((run.resumeAfter?.getTime() ?? before) - before);
    // Simulate the scheduler picking it back up once the delay has elapsed.
    db.update(runs).set({ status: 'queued' }).where(eq(runs.id, runId)).run();
  }

  const final = db.select().from(runs).where(eq(runs.id, runId)).get()!;
  assert.equal(final.status, 'failed', 'must stop retrying rather than loop forever');
  assert.match(final.statusReason ?? '', /gave up after/);
  assert.match(final.statusReason ?? '', /rate limiting/);

  // Backoff must actually grow, not sit at a constant interval.
  assert.ok(delays.length >= 4, `expected several backoffs, got ${delays.length}`);
  assert.ok(
    delays.at(-1)! > delays[0]! * 2,
    `backoff should grow: first=${delays[0]}ms last=${delays.at(-1)}ms`,
  );
});
