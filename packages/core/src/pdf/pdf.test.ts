import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Content } from 'pdfmake/interfaces';
import { inlineToPdf, markdownToPdf } from './markdown.ts';
import { buildRcaPdfDefinition } from './report-pdf.ts';
import { renderPdf } from './render.ts';
import type { ReportInput, ReportToolCall } from '../report.ts';

// --- inline formatting ----------------------------------------------------

test('bold, italic and inline code become distinct runs', () => {
  assert.deepEqual(inlineToPdf('**Status:** healthy'), [
    { text: 'Status:', bold: true },
    { text: ' healthy' },
  ]);

  const code = inlineToPdf('root is `/dev/root`');
  assert.equal(code[1]?.font, 'Courier', 'inline code must not render as prose');

  const italic = inlineToPdf('this is *important*');
  assert.equal(italic[1]?.italics, true);
});

/**
 * Observed in a real report: `**Root Partition (`/dev/nvme0n1p1`)**` rendered with
 * its backticks printed, because the outer emphasis matched first and its body was
 * emitted verbatim instead of being parsed again.
 */
test('emphasis containing inline code renders both, not literal backticks', () => {
  const runs = inlineToPdf('**Root Partition (`/dev/nvme0n1p1`)**:');
  assert.ok(!runs.some((r) => String(r.text).includes('`')), 'no backtick should survive');

  const code = runs.find((r) => r.font === 'Courier');
  assert.equal(code?.text, '/dev/nvme0n1p1');
  assert.equal(code?.bold, true, 'the outer emphasis still applies');
  assert.ok(runs.some((r) => r.text === 'Root Partition (' && r.bold));
});

test('italic containing bold nests correctly', () => {
  const runs = inlineToPdf('*very **important** indeed*');
  const inner = runs.find((r) => r.text === 'important');
  assert.equal(inner?.bold, true);
  assert.equal(inner?.italics, true);
});

test('a link keeps its text and target', () => {
  const [run] = inlineToPdf('[docs](https://example.com)');
  assert.equal(run?.text, 'docs');
  assert.equal(run?.link, 'https://example.com');
});

test('plain text passes through untouched', () => {
  assert.deepEqual(inlineToPdf('no markup here'), [{ text: 'no markup here' }]);
});

// --- block structure ------------------------------------------------------

const kinds = (c: Content[]) =>
  c.map((x) => {
    const o = x as unknown as Record<string, unknown>;
    if (o.table) return 'table';
    if (o.ul) return 'ul';
    if (o.ol) return 'ol';
    if (o.canvas) return 'hr';
    if (o.font === 'Courier') return 'code';
    return 'text';
  });

test('headings, lists, code and tables are recognised as distinct blocks', () => {
  const md = [
    '### Disk Usage',
    '',
    '- Root: 61% used',
    '- Swap: none configured',
    '',
    '```',
    'df -h',
    '```',
    '',
    '| Metric | Value |',
    '|---|---|',
    '| Used | 18G |',
  ].join('\n');

  assert.deepEqual(kinds(markdownToPdf(md)), ['text', 'ul', 'code', 'table']);
});

test('a wrapped list item stays one item rather than splitting', () => {
  const out = markdownToPdf('- Root filesystem is at 61%\n  which is healthy\n- Swap: none');
  const list = out[0] as unknown as { ul: Array<{ text: unknown[] }> };
  assert.equal(list.ul.length, 2);
  assert.ok(JSON.stringify(list.ul[0]).includes('which is healthy'));
});

test('fenced code keeps its exact whitespace', () => {
  const out = markdownToPdf('```\nline one\n    indented\n```');
  assert.equal((out[0] as { text: string }).text, 'line one\n    indented');
});

test('unrecognised markup degrades to readable text rather than disappearing', () => {
  const out = markdownToPdf('Some ~~odd~~ <span>markup</span> here');
  assert.ok(JSON.stringify(out).includes('markup'));
});

// --- the document itself ---------------------------------------------------

const call = (over: Partial<ReportToolCall> = {}): ReportToolCall => ({
  toolKey: 'ssh_exec',
  callIndex: 0,
  renderedCommand: 'df -h',
  argsJson: { target: 'uat', command: 'df -h', intent: 'check disk' },
  tier: 'read_only',
  riskJson: null,
  state: 'succeeded',
  resultJson: { ok: true, text: '[exit 0]\n/dev/root 30G 18G 12G 61% /' },
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
    title: 'Disk check on uat',
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
    { seq: 0, messageJson: { role: 'user', content: 'check disk' } },
    { seq: 1, messageJson: { role: 'assistant', content: '### Result\n\n- **Root**: 61% used\n- Healthy.' } },
  ],
  toolCalls: [call()],
  projectName: 'Default Project',
  agentName: 'Triage Agent',
  approverNames: {},
  ...over,
});

test('the definition renders to a real PDF', async () => {
  const pdf = await renderPdf(buildRcaPdfDefinition(input()));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'must be a valid PDF');
  assert.ok(pdf.length > 1500, `suspiciously small: ${pdf.length} bytes`);
});

test('a run with many actions still renders, paginated', async () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    call({ callIndex: i, renderedCommand: `journalctl -u svc-${i} --since "1 hour ago"` }),
  );
  const pdf = await renderPdf(buildRcaPdfDefinition(input({ toolCalls: many })));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.length > 5000);
});

test('output containing characters that would break a table still renders', async () => {
  const pdf = await renderPdf(
    buildRcaPdfDefinition(
      input({
        toolCalls: [
          call({
            renderedCommand: 'ps aux | grep "nginx" | awk \'{print $2}\'',
            resultJson: { ok: true, text: 'a|b|c\n\ttabbed\n<html>&amp;' },
          }),
        ],
      }),
    ),
  );
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('a run with no summary and no actions still produces a document', async () => {
  const pdf = await renderPdf(
    buildRcaPdfDefinition(input({ toolCalls: [], steps: [{ seq: 0, messageJson: { role: 'user', content: 'x' } }] })),
  );
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('the definition carries the facts a reader needs', () => {
  const def = buildRcaPdfDefinition(input());
  const json = JSON.stringify(def);
  assert.match(json, /Disk check on uat/);
  assert.match(json, /Triage Agent/);
  assert.match(json, /uat \(ssh, staging\)/);
  assert.match(json, /The agent's own account/);
  assert.match(json, /diagnostic only/);

  // The provenance note lives in the page footer, which is a function rather than
  // serialisable content -- so it has to be invoked to be checked.
  const footer = def.footer as (page: number, total: number) => { columns: Array<{ text: string }> };
  const rendered = footer(1, 2);
  assert.match(rendered.columns[0]!.text, /SupOps · run/);
  assert.equal(rendered.columns[1]!.text, '1 / 2', 'pages should be numbered');
});

test('a model-written body becomes the report, with a factual action record appended', () => {
  const def = buildRcaPdfDefinition(input(), '## Summary\n\nDisk was fine.\n\n## Root cause\n\nNone found.');
  const json = JSON.stringify(def);
  assert.match(json, /Disk was fine/); // the model's narrative is rendered
  assert.match(json, /SupOps/); // branded header/footer
  // The mechanical "Evidence" dump is NOT included when a model body is used.
  assert.doesNotMatch(json, /## Evidence|The agent's own account/);
});
