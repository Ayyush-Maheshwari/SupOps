import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRcaMarkdown, reportFilename } from './report.ts';
import type { ReportInput, ReportToolCall } from './report.ts';

const call = (over: Partial<ReportToolCall> = {}): ReportToolCall => ({
  toolKey: 'ssh_exec',
  callIndex: 0,
  renderedCommand: 'df -h',
  argsJson: { target: 'uat', command: 'df -h' },
  tier: 'read_only',
  riskJson: null,
  state: 'succeeded',
  resultJson: { ok: true, text: '[exit 0]\n/dev/root 30G 24G 5.9G 80% /' },
  isError: false,
  decidedBy: null,
  decisionComment: null,
  startedAt: new Date('2026-09-14T10:00:00Z'),
  finishedAt: new Date('2026-09-14T10:00:02Z'),
  ...over,
});

const input = (over: Partial<ReportInput> = {}): ReportInput => ({
  run: {
    id: 'run-1',
    title: 'Disk filling up on uat',
    status: 'succeeded',
    statusReason: null,
    model: 'gemini-3.5-flash-lite',
    iteration: 3,
    promptTokens: 100,
    completionTokens: 50,
    startedAt: new Date('2026-09-14T10:00:00Z'),
    endedAt: new Date('2026-09-14T10:02:30Z'),
    targetsSnapshot: [{ slug: 'uat', kind: 'ssh', env: 'staging', description: 'jump host' }],
  },
  steps: [
    { seq: 0, messageJson: { role: 'system', content: 'prompt' } },
    { seq: 1, messageJson: { role: 'user', content: 'disk filling up' } },
    { seq: 2, messageJson: { role: 'assistant', content: 'Root is at 80%. Logs are the cause.' } },
  ],
  toolCalls: [call()],
  projectName: 'Default Project',
  agentName: 'Triage Agent',
  approverNames: {},
  ...over,
});

test('the document records the facts a reader needs up front', () => {
  const md = buildRcaMarkdown(input());
  assert.match(md, /# Incident report: Disk filling up on uat/);
  assert.match(md, /\*\*Status\*\* \| Completed/);
  assert.match(md, /\*\*Duration\*\* \| 2m 30s/);
  assert.match(md, /`uat` \(ssh, staging\)/);
  assert.match(md, /Triage Agent \(gemini-3\.5-flash-lite\)/);
});

test("the agent's summary is included but explicitly attributed, not stated as fact", () => {
  const md = buildRcaMarkdown(input());
  assert.match(md, /Root is at 80%/);
  assert.match(md, /The agent's own account/);
  assert.match(md, /not from the agent's narrative/);
});

/**
 * The central property: the action table comes from the execution record. A model
 * that claims in prose to have restarted something it never restarted must not have
 * that claim laundered into a post-incident document.
 */
test('the action table reflects what executed, independent of the narrative', () => {
  const md = buildRcaMarkdown(
    input({
      steps: [
        { seq: 0, messageJson: { role: 'user', content: 'fix it' } },
        { seq: 1, messageJson: { role: 'assistant', content: 'I restarted nginx and it is healthy.' } },
      ],
      toolCalls: [call({ renderedCommand: 'df -h' })],
    }),
  );
  assert.match(md, /I restarted nginx/, 'the claim is still shown');
  assert.doesNotMatch(md.split('## Evidence')[0]!, /systemctl restart/, 'but never enters the action table');
  assert.match(md, /\| 1 \| `df -h` \| `uat` \| read_only \| succeeded \| auto \(within policy\) \|/);
});

test('a rejected action is recorded as not having run, with the reviewer note', () => {
  const md = buildRcaMarkdown(
    input({
      toolCalls: [
        call({
          renderedCommand: 'systemctl restart nginx',
          tier: 'medium',
          state: 'denied',
          resultJson: null,
          decidedBy: 'u1',
          decisionComment: 'mid-deploy',
        }),
      ],
      approverNames: { u1: 'alice' },
    }),
  );
  assert.match(md, /rejected by a human/);
  assert.match(md, /\*\*rejected\*\* by alice/);
  assert.match(md, /mid-deploy/);
  assert.match(md, /1 proposed action\(s\) were refused and did not run/);
});

test('an unknown outcome is called out prominently rather than buried', () => {
  const md = buildRcaMarkdown({
    ...input(),
    toolCalls: [call({ state: 'unknown_outcome', resultJson: null })],
  });
  assert.match(md, /\*\*outcome unknown\*\*/);
  assert.match(md, /may or may not have taken effect/);
});

test('a purely diagnostic run says so', () => {
  assert.match(buildRcaMarkdown(input()), /made no state-changing actions/);
});

test('the risk explanation is carried into the evidence section', () => {
  const md = buildRcaMarkdown(
    input({
      toolCalls: [
        call({
          renderedCommand: 'systemctl restart nginx',
          tier: 'medium',
          riskJson: {
            tier: 'medium',
            decision: 'approve',
            contributions: [
              { stage: 'arguments', tier: 'medium', ruleId: 'shell.systemctl.restart', reason: 'interrupts a running service' },
            ],
          },
        }),
      ],
    }),
  );
  assert.match(md, /Assessed medium because/);
  assert.match(md, /interrupts a running service/);
  assert.match(md, /shell\.systemctl\.restart/);
});

test('a pipe in a command cannot break the markdown table', () => {
  const md = buildRcaMarkdown(input({ toolCalls: [call({ renderedCommand: 'ps aux | grep nginx' })] }));
  const row = md.split('\n').find((l) => l.startsWith('| 1 |'))!;
  assert.equal(row.split(/(?<!\\)\|/).length - 1, 7, 'escaped pipe must not add a column');
});

test('the filename is safe and dated', () => {
  assert.equal(
    reportFilename({ title: 'Disk filling up on uat!! ', startedAt: new Date('2026-09-14T10:00:00Z') }),
    'rca-disk-filling-up-on-uat-2026-09-14.md',
  );
});

test('a very long action is truncated in the table but kept whole in the evidence', () => {
  const long = `record_finding(info): ${'x'.repeat(400)}`;
  const md = buildRcaMarkdown(input({ toolCalls: [call({ toolKey: 'record_finding', renderedCommand: long })] }));

  const row = md.split('\n').find((l) => l.startsWith('| 1 |'))!;
  assert.ok(row.length < 200, `table row should stay readable, was ${row.length} chars`);
  assert.match(row, /…/);

  // The full text must survive somewhere, or the document loses information.
  assert.ok(md.includes(long), 'the untruncated command belongs in the evidence section');
});
