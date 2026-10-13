import { test } from 'node:test';
import assert from 'node:assert/strict';
import { eq } from 'drizzle-orm';
import { DEFAULT_RISK_POLICY, runs, toolCalls, trustedCommands } from '@supops/db';
import { ScriptedLLM, SpyTool, freshDb, makeEngine, seedRun, toolCall } from './harness.test-util.ts';

const SPEC = [{
  type: 'function' as const,
  function: {
    name: 'ssh_exec',
    description: 'test shell',
    parameters: { type: 'object' as const, properties: { target: { type: 'string' as const, enum: ['web-1'] }, command: { type: 'string' as const } }, required: ['target', 'command'] },
  },
}];

/** One run that proposes `command` on web-1 (a staging target), with a trust rule in place. */
async function run(command: string, rule: Partial<typeof trustedCommands.$inferInsert> | null, opts: { unattended?: boolean } = {}) {
  const db = freshDb();
  const spy = new SpyTool();
  const llm = new ScriptedLLM([
    { role: 'assistant', content: null, tool_calls: [toolCall('c1', 'ssh_exec', { target: 'web-1', command })] },
    { role: 'assistant', content: 'Done.' },
  ]);
  const engine = makeEngine(db, llm, [spy.def('ssh_exec')]);
  const runId = seedRun(db, SPEC);
  const projectId = db.select().from(runs).where(eq(runs.id, runId)).get()!.projectId;
  if (opts.unattended) db.update(runs).set({ policySnapshot: { ...DEFAULT_RISK_POLICY, unattended: true } }).where(eq(runs.id, runId)).run();
  if (rule) {
    db.insert(trustedCommands).values({ projectId, toolKey: 'ssh_exec', matchKind: 'exact', canonical: command, envs: ['staging'], status: 'active', ...rule } as typeof trustedCommands.$inferInsert).run();
  }
  await engine.runToCompletion(runId);
  const call = db.select().from(toolCalls).where(eq(toolCalls.runId, runId)).get()!;
  const ruleRow = db.select().from(trustedCommands).get();
  return { spy, call, status: db.select().from(runs).where(eq(runs.id, runId)).get()!.status, ruleRow };
}

test('a trusted command runs without waiting, and keeps its honest tier', async () => {
  const r = await run('systemctl restart nginx', {});
  assert.deepEqual(r.spy.executions, ['systemctl restart nginx']);
  assert.equal(r.call.state, 'succeeded');
  assert.equal(r.call.tier, 'medium', 'trust skips the wait; it never lowers the risk');
  assert.ok(r.call.riskJson?.trusted, 'the call records which trust let it through');
  assert.equal(r.ruleRow?.hits, 1);
  assert.equal(r.status, 'succeeded');
});

test('no trust, a rule for other environments, or an untrusted rule: it waits', async () => {
  for (const rule of [null, { envs: ['prod' as const] }, { status: 'revoked' as const }, { status: 'suggested' as const }]) {
    const r = await run('systemctl restart nginx', rule);
    assert.deepEqual(r.spy.executions, [], JSON.stringify(rule));
    assert.equal(r.call.state, 'awaiting_approval', JSON.stringify(rule));
  }
});

test('trust never applies to a forbidden action or an automatic run', async () => {
  const forbidden = await run('rm -rf /', {});
  assert.equal(forbidden.call.state, 'blocked');
  assert.deepEqual(forbidden.spy.executions, []);
  const unattended = await run('systemctl restart nginx', {}, { unattended: true });
  assert.equal(unattended.call.state, 'blocked', 'an unattended run promised not to change anything');
  assert.deepEqual(unattended.spy.executions, []);
});
