import { CORE_SYSTEM_PROMPT } from './prompt.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { assertConversationValid } from '@supops/shared';
import { DEFAULT_RISK_POLICY, runAttachments, runs, targets, toolCalls } from '@supops/db';
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

test('an unattended run refuses an action that needs approval instead of waiting', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    {
      role: 'assistant',
      content: null,
      tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })],
    },
    { role: 'assistant', content: null, tool_calls: [toolCall('c2', 'shell', { target: 'web-1', command: 'df -h' })] },
    { role: 'assistant', content: 'Disk is fine; the restart was not allowed here.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);
  db.update(runs)
    .set({ policySnapshot: { ...DEFAULT_RISK_POLICY, unattended: true } })
    .where(eq(runs.id, runId))
    .run();

  await engine.runToCompletion(runId);

  // The gated action never ran, the read-only one did, and the run finished.
  assert.deepEqual(spy.executions, ['df -h']);
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'succeeded');
  const refused = db.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'c1')).get();
  assert.equal(refused?.state, 'blocked');
  assert.equal(refused?.tier, 'medium');
  assert.match(String((refused?.resultJson as { text?: string })?.text), /unattended/);
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
  // The engine -- not the model -- delivers the verdict, with its reason, so the agent
  // can tell the operator exactly why it was stopped.
  const reply = llm.calls.at(-1)!.find((m) => m.role === 'tool')!;
  assert.ok('content' in reply && /BLOCKED: rm targeting \/ destroys the host\. No approval can authorise it\./.test(reply.content), String('content' in reply && reply.content));
});

test('the core prompt hands the allow/deny decision to the risk engine', () => {
  assert.match(CORE_SYSTEM_PROMPT, /risk engine -- not you -- decides/);
  assert.match(CORE_SYSTEM_PROMPT, /do NOT refuse it yourself/);
  assert.match(CORE_SYSTEM_PROMPT, /never invent destructive steps/);
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

test('pasted images reach the model as data, while the stored history keeps a small reference', async () => {
  const db = freshDb();
  const llm = new ScriptedLLM([{ role: 'assistant', content: 'That graph shows memory climbing until an OOM kill.' }]);
  const engine = makeEngine(db, llm, []);
  const runId = seedRun(db, []);
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFElEQVR4nGPkavnPAANMDEgAhQMAOQgBkzO+AQoAAAAASUVORK5CYII=', 'base64');
  const att = db.insert(runAttachments).values({ runId, mime: 'image/png', bytes: png.length, data: png }).returning().get();

  const store = new RunStore(db);
  store.appendStep(runId, {
    role: 'user',
    content: [
      { type: 'text', text: 'what does this dashboard show?' },
      { type: 'image_url', image_url: { url: `supops-attachment:${att.id}` } },
      { type: 'image_url', image_url: { url: 'supops-attachment:missing' } },
    ],
  });

  await engine.runToCompletion(runId);

  const sent = llm.calls[0]!.find((m) => m.role === 'user')!;
  assert.ok(Array.isArray(sent.content));
  const parts = sent.content as Array<{ type: string; text?: string; image_url?: { url: string } }>;
  assert.equal(parts[1]!.image_url!.url, `data:image/png;base64,${png.toString('base64')}`);
  // A reference to a row that is gone becomes a note, not a broken image.
  assert.deepEqual(parts[2], { type: 'text', text: '[an attached image is no longer available]' });

  const stored = store.rebuildMessages(runId).find((m) => m.role === 'user')!;
  assert.match(JSON.stringify(stored), /supops-attachment:/);
  assert.doesNotMatch(JSON.stringify(stored), /base64/);
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'succeeded');
});

test('a scoped run cannot reach another project host by naming it', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    // db-prod exists in the project but is not in this run's scope.
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'db-prod', command: 'df -h' })] },
    { role: 'assistant', content: 'That host is outside this run.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);
  const run = db.select().from(runs).where(eq(runs.id, runId)).get()!;
  db.insert(targets).values({
    projectId: run.projectId, slug: 'db-prod', name: 'db', kind: 'ssh', env: 'prod',
    sensitivity: 3, description: 'primary database', tags: [],
    config: { kind: 'ssh', host: '10.0.0.9', port: 22, user: 'ops', sudo: false },
    createdAt: new Date(),
  }).run();

  await engine.runToCompletion(runId);

  assert.deepEqual(spy.executions, [], 'nothing may run on a host outside the run scope');
  const call = db.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'c1')).get();
  assert.equal(call?.state, 'blocked');
  assert.match(String((call?.resultJson as { text?: string })?.text), /not a registered target/);
  assert.doesNotMatch(String((call?.resultJson as { text?: string })?.text), /db-prod,|, db-prod/);
});

test('a tool the run was not started with cannot be called, even if the agent has it now', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const other = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell2', { target: 'web-1', command: 'id' })] },
    { role: 'assistant', content: 'ok' },
  ]);
  // The registry knows shell2, but the run's frozen tool snapshot only has `shell`.
  const engine = makeEngine(db, llm, [spy.def(), other.def('shell2')]);
  const runId = seedRun(db, SPEC);

  await engine.runToCompletion(runId);

  assert.deepEqual(other.executions, []);
  const call = db.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'c1')).get();
  assert.equal(call?.state, 'blocked');
});

test('an approval nobody answers expires; the agent is told and carries on', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })] },
    { role: 'assistant', content: 'The restart was never approved, so nothing changed.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);
  await engine.runToCompletion(runId);
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'awaiting_approval');

  const store = new RunStore(db);
  // Not yet: the default medium TTL is 30 minutes.
  assert.deepEqual(store.expireStaleApprovals(new Date(Date.now() + 60_000)), []);
  const expired = store.expireStaleApprovals(new Date(Date.now() + 31 * 60_000));
  assert.equal(expired.length, 1);
  assert.equal(db.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'c1')).get()?.state, 'expired');
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'queued');

  await engine.runToCompletion(runId);
  assert.deepEqual(spy.executions, [], 'an expired approval must never run the action');
  const reply = llm.calls[1]!.find((m) => m.role === 'tool');
  assert.match(String(reply?.content), /expired/);
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'succeeded');
});

test('with onExpiry abort_run, an expired approval stops the run', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })] },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);
  db.update(runs).set({ policySnapshot: { ...DEFAULT_RISK_POLICY, onExpiry: 'abort_run' } }).where(eq(runs.id, runId)).run();
  await engine.runToCompletion(runId);

  const [e] = new RunStore(db).expireStaleApprovals(new Date(Date.now() + 31 * 60_000));
  assert.equal(e?.aborted, true);
  const run = db.select().from(runs).where(eq(runs.id, runId)).get();
  assert.equal(run?.status, 'failed');
  assert.match(String(run?.statusReason), /expired/);
  assert.deepEqual(spy.executions, []);
});

// ---- session budgets and output limits ------------------------------------

/** Turn a seeded run into an interactive session whose first turn has an operator message. */
function asSession(db: ReturnType<typeof freshDb>, runId: string) {
  db.update(runs).set({ interactive: true }).where(eq(runs.id, runId)).run();
  new RunStore(db).appendStep(runId, { role: 'user', content: 'how are the disks?' });
}

test('a Console session can repeat a check once per question without tripping the duplicate breaker', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const turn = (id: string) => [
    { role: 'assistant' as const, content: null, tool_calls: [toolCall(id, 'shell', { target: 'web-1', command: 'df -h' })] },
    { role: 'assistant' as const, content: 'Disk is fine.' },
  ];
  const llm = new ScriptedLLM([...turn('a1'), ...turn('a2'), ...turn('a3'), ...turn('a4'), ...turn('a5')]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);
  asSession(db, runId);
  const store = new RunStore(db);

  await engine.runToCompletion(runId);
  for (let i = 0; i < 4; i += 1) {
    store.appendStep(runId, { role: 'user', content: 'and now?' });
    store.resumeWithInput(runId, 60_000);
    await engine.runToCompletion(runId);
  }
  assert.equal(spy.executions.length, 5, 'the same read on five separate questions must all run');
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'succeeded');
});

test('each follow-up turn gets its own wall-clock deadline', () => {
  const db = freshDb();
  const runId = seedRun(db, SPEC);
  const before = Date.now();
  new RunStore(db).resumeWithInput(runId, 30 * 60_000);
  const deadline = db.select().from(runs).where(eq(runs.id, runId)).get()?.deadlineAt?.getTime() ?? 0;
  assert.ok(deadline >= before + 30 * 60_000 - 1000 && deadline <= Date.now() + 30 * 60_000 + 1000);
});

test('a reply cut off by the output limit is continued, and the continuation is not the operator', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: 'Here is the full analysis. First,', __finishReason: 'length' } as never,
    { role: 'assistant', content: 'second, the disk is at 41%. Done.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);

  await engine.runToCompletion(runId);

  assert.equal(llm.calls.length, 2, 'the engine asked it to continue once');
  const nudge = llm.calls[1]!.at(-1)!;
  assert.equal(nudge.role, 'user');
  assert.match(String(nudge.content), /cut off by the output length limit/);
  assert.equal(new RunStore(db).lastUserSeq(runId), null, 'an engine message never counts as the operator');
  assert.equal(db.select().from(runs).where(eq(runs.id, runId)).get()?.status, 'succeeded');
});

test('continuation is capped, so a model that keeps getting cut off cannot loop', async () => {
  const db = freshDb();
  const cut = { role: 'assistant', content: 'and more,', __finishReason: 'length' } as never;
  const llm = new ScriptedLLM([cut, cut, cut, { role: 'assistant', content: 'unreachable' }]);
  const engine = makeEngine(db, llm, [new SpyTool().def()]);
  const runId = seedRun(db, SPEC);
  await engine.runToCompletion(runId);
  assert.equal(llm.calls.length, 3, 'two continuations, then the turn ends');
});

test('a tool call whose arguments were cut off is refused with the reason, not run', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 't1', type: 'function', function: { name: 'shell', arguments: '{"target":"web-1","command":"cat <<EOF > /tmp/big' } }],
      __finishReason: 'length',
    } as never,
    { role: 'assistant', content: 'I will split it.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);
  await engine.runToCompletion(runId);

  assert.deepEqual(spy.executions, []);
  const call = db.select().from(toolCalls).where(eq(toolCalls.toolCallId, 't1')).get();
  assert.equal(call?.state, 'blocked');
  assert.match(String((call?.resultJson as { text?: string })?.text), /output length limit/);
});

test('an approval does not carry over when the target is repointed before it runs', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })] },
    { role: 'assistant', content: 'The target changed, so the restart did not run.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);
  await engine.runToCompletion(runId);
  const call = db.select().from(toolCalls).where(eq(toolCalls.toolCallId, 'c1')).get()!;
  assert.equal(call.state, 'awaiting_approval');
  assert.ok(call.targetFingerprint, 'the fingerprint is recorded at classification');

  // Someone flips the target to prod after the approval was requested, then it is approved.
  db.update(targets).set({ env: 'prod' }).where(eq(targets.slug, 'web-1')).run();
  db.update(toolCalls).set({ state: 'approved' }).where(eq(toolCalls.id, call.id)).run();
  db.update(runs).set({ status: 'queued' }).where(eq(runs.id, runId)).run();
  await engine.runToCompletion(runId);

  assert.deepEqual(spy.executions, [], 'the approved action must not run against a changed target');
  const after = db.select().from(toolCalls).where(eq(toolCalls.id, call.id)).get();
  assert.match(String((after?.resultJson as { text?: string })?.text), /changed after/);
});

test('pinning the host key on first contact does not invalidate an approval', async () => {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'shell', { target: 'web-1', command: 'systemctl restart nginx' })] },
    { role: 'assistant', content: 'Restarted.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def()]);
  const runId = seedRun(db, SPEC);
  await engine.runToCompletion(runId);
  const t = db.select().from(targets).where(eq(targets.slug, 'web-1')).get()!;
  db.update(targets).set({ config: { ...(t.config as object), hostKeyFingerprint: 'SHA256:abc' } as never }).where(eq(targets.id, t.id)).run();
  db.update(toolCalls).set({ state: 'approved' }).where(eq(toolCalls.toolCallId, 'c1')).run();
  db.update(runs).set({ status: 'queued' }).where(eq(runs.id, runId)).run();
  await engine.runToCompletion(runId);
  assert.deepEqual(spy.executions, ['systemctl restart nginx']);
});
