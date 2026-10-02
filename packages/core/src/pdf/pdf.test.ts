import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Content } from 'pdfmake/interfaces';
import { inlineToPdf, markdownToPdf } from './markdown.ts';
import { buildRcaPdfDefinition } from './report-pdf.ts';
import { renderPdf } from './render.ts';
import type { ReportInput, ReportToolCall } from '../report.ts';
import { approvalLedger, buildReportMarkdown, extractAgentDiagrams, extractAgentTables, fallbackReportDoc, parseReportDoc } from '../report-doc.ts';
import { diagramKey, repairMermaid } from '@supops/shared';

// --- inline formatting ----------------------------------------------------

test('bold, italic and inline code become distinct runs', () => {
  assert.deepEqual(inlineToPdf('**Status:** healthy'), [
    { text: 'Status:', bold: true },
    { text: ' healthy' },
  ]);

  const code = inlineToPdf('root is `/dev/root`');
  assert.equal(code[1]?.font, 'Mono', 'inline code must not render as prose');

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

  const code = runs.find((r) => r.font === 'Mono');
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
    if (o.font === 'Mono') return 'code';
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

const writer = (over: Record<string, unknown> = {}) => JSON.stringify({
  title: 'Root filesystem on uat at 61% — healthy',
  type: 'health_check',
  outcome: 'healthy',
  headline: 'The root filesystem on **uat** is at 61% with 12G free.',
  summary: ['Checked disk on `uat`.', 'No mount above 80%.'],
  metrics: [{ label: 'Root /', value: '61%', status: 'ok' }, { label: 'Free', value: '12G', status: 'ok' }],
  rootCause: null,
  chain: [{ finding: 'Root is at 61%.', evidence: [1], status: 'ok' }],
  actions: [],
  targets: [{ target: 'uat', status: 'ok', note: 'disk 61%' }],
  tables: [],
  recommendations: [{ priority: 'low', text: 'Review again next week.' }],
  ...over,
});

const pdfOf = (i: ReportInput, raw: string | null = writer()) => buildRcaPdfDefinition(i, parseReportDoc(raw, i));

test('the definition renders to a real PDF with the embedded fonts', async () => {
  const pdf = await renderPdf(pdfOf(input()));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-', 'must be a valid PDF');
  assert.ok(pdf.length > 5000, `suspiciously small: ${pdf.length} bytes`);
  assert.ok(pdf.includes('Inter'), 'Inter should be embedded');
});

test('a run with many actions still renders, paginated', async () => {
  const many = Array.from({ length: 30 }, (_, i) =>
    call({ callIndex: i, renderedCommand: `journalctl -u svc-${i} --since "1 hour ago"` }),
  );
  const raw = writer({ chain: [{ finding: 'Checked all units.', evidence: [1, 5, 9, 12, 20, 29], status: 'info' }] });
  const pdf = await renderPdf(pdfOf(input({ toolCalls: many }), raw));
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('awkward output, emoji and a garbage model reply still render', async () => {
  const i = input({
    toolCalls: [call({
      renderedCommand: 'ps aux | grep "nginx" | awk \'{print $2}\'',
      resultJson: { ok: true, text: 'a|b|c\n\ttabbed\n<html>&amp; ✅ done 🚀' },
    })],
  });
  assert.equal((await renderPdf(pdfOf(i, 'sorry, I cannot help'))).subarray(0, 5).toString(), '%PDF-');
  assert.equal((await renderPdf(pdfOf(i, writer({ headline: 'All good ✅🚀' })))).subarray(0, 5).toString(), '%PDF-');
});

test('a run with no summary and no actions still produces a document', async () => {
  const i = input({ toolCalls: [], steps: [{ seq: 0, messageJson: { role: 'user', content: 'x' } }] });
  assert.equal((await renderPdf(pdfOf(i, null))).subarray(0, 5).toString(), '%PDF-');
});

test('the writer rewrites the title and classifies the run; the user text is not the title', () => {
  const i = input({ run: { ...input().run, title: 'chek disk usgae on uat pls' } });
  const doc = parseReportDoc('```json\n' + writer() + '\n```', i);
  assert.equal(doc.title, 'Root filesystem on uat at 61% — healthy');
  assert.equal(doc.type, 'health_check');
  assert.equal(doc.outcome, 'healthy');
  assert.deepEqual(doc.chain[0]!.evidence, [1]);
});

test('invalid fields fall back to the execution record instead of failing', () => {
  const doc = parseReportDoc(writer({ type: 'banana', outcome: 7, chain: 'nope', metrics: [{ label: '', value: '' }] }), input());
  assert.equal(doc.type, 'query');
  assert.equal(doc.outcome, 'completed');
  assert.deepEqual(doc.metrics, []);
  // A citation to a command that does not exist is dropped, not printed.
  const bad = parseReportDoc(writer({ chain: [{ finding: 'x', evidence: [1, 99, '#1'], status: 'ok' }] }), input());
  assert.deepEqual(bad.chain[0]!.evidence, [1]);
});

test('with no model at all, a tidy mechanical report is produced', () => {
  const doc = fallbackReportDoc(input({ run: { ...input().run, title: 'check disk usage?' } }));
  assert.equal(doc.written, false);
  assert.equal(doc.title, 'Check disk usage');
});

test('tables the agent wrote during the run are carried into the report', () => {
  const steps = [
    { seq: 1, messageJson: { role: 'assistant' as const, content: 'Pods:\n\n**Unhealthy pods**\n\n| Pod | Status | Restarts |\n|---|---|---|\n| api-1 | CrashLoopBackOff | 14 |\n| web-2 | Running | 0 |\n\nDone.' } },
  ];
  const tables = extractAgentTables(steps);
  assert.equal(tables.length, 1);
  assert.equal(tables[0]!.title, 'Unhealthy pods');
  assert.deepEqual(tables[0]!.columns, ['Pod', 'Status', 'Restarts']);
  assert.deepEqual(tables[0]!.rows[0], ['api-1', 'CrashLoopBackOff', '14']);

  const i = input({ steps });
  const doc = parseReportDoc(writer(), i);
  assert.equal(doc.tables[0]!.source, 'agent');
  assert.match(JSON.stringify(buildRcaPdfDefinition(i, doc)), /CrashLoopBackOff/);
});

test('the footer names who approved and when, and never shows the run id', () => {
  const i = input({
    approverNames: { u1: 'Alice', u2: 'Bob' },
    toolCalls: [
      call(),
      call({ tier: 'medium', renderedCommand: 'systemctl restart nginx', decidedBy: 'u1', decidedAt: new Date('2026-09-14T10:01:00Z') }),
      call({ tier: 'high', renderedCommand: 'rm -rf /var/cache/x', state: 'denied', decidedBy: 'u2', decidedAt: new Date('2026-09-14T10:01:30Z') }),
    ],
  });
  const ledger = approvalLedger(i);
  assert.deepEqual(ledger.map((e) => [e.name, e.approved, e.rejected]), [['Alice', 1, 0], ['Bob', 0, 1]]);

  const def = buildRcaPdfDefinition(i, parseReportDoc(writer(), i));
  const footer = JSON.stringify((def.footer as (p: number, t: number) => unknown)(1, 3));
  assert.match(footer, /Approved by/);
  assert.match(footer, /Alice/);
  assert.match(footer, /10:01 UTC/);
  assert.match(footer, /Rejected by/);
  assert.match(footer, /Bob/);
  assert.match(footer, /1 \/ 3/);
  assert.doesNotMatch(footer + JSON.stringify(def.content), /run-1/, 'the run id is not printed');
});

test('the Markdown export has the same structure', () => {
  const i = input();
  const md = buildReportMarkdown(i, parseReportDoc(writer(), i));
  assert.match(md, /^# Root filesystem on uat at 61% — healthy/);
  assert.match(md, /\*\*Health check\*\* · \*\*Healthy\*\*/);
  assert.match(md, /## How it was established/);
  assert.match(md, /#1 df -h/);
  assert.match(md, /No approvals were needed/);
  assert.doesNotMatch(md, /run-1/);
});

// --- diagrams and screenshots -----------------------------------------------

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAQAAAADCAIAAAA7ljmRAAAAFElEQVR4nGPkavnPAANMDEgAhQMAOQgBkzO+AQoAAAAASUVORK5CYII=';
const JPEG = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAQDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDNooor9JPgD//Z';
const FLOW = 'graph TD\n  subgraph vm [VM: mongo2 (Primary)]\n    DB[(MongoDB)]\n  end\n  App --> DB';
const withDiagram = () => input({
  steps: [
    { seq: 0, messageJson: { role: 'user', content: 'draw the mongo topology' } },
    { seq: 1, messageJson: { role: 'assistant', content: '### Topology\n\n```mermaid\n' + FLOW + '\n```' } },
    // Redrawn later: the latest version wins, and it is not listed twice.
    { seq: 2, messageJson: { role: 'assistant', content: '### Topology\n\n```mermaid\n' + FLOW + '\n```\nDone.' } },
  ],
});

test('diagrams the agent drew are found once each, repaired, with their heading', () => {
  const d = extractAgentDiagrams(withDiagram().steps);
  assert.equal(d.length, 1);
  assert.equal(d[0]!.title, 'Topology');
  assert.match(d[0]!.source, /subgraph vm \["VM: mongo2 \(Primary\)"\]/);
  assert.equal(d[0]!.key, diagramKey(repairMermaid(FLOW)));
});

test('a browser-rendered diagram and pasted screenshots are embedded in the PDF', async () => {
  const i = withDiagram();
  const key = diagramKey(repairMermaid(FLOW));
  const def = buildRcaPdfDefinition(i, parseReportDoc(writer(), i), {
    diagrams: new Map([[key, PNG]]),
    images: [
      { name: 'grafana.png', dataUrl: PNG, width: 4, height: 3 },
      { name: null, dataUrl: JPEG, width: 4, height: 3 },
    ],
  });
  const json = JSON.stringify(def);
  assert.equal(json.split(PNG).length - 1, 2, 'the diagram and the PNG screenshot');
  assert.ok(json.includes(JPEG), 'the JPEG screenshot');
  assert.match(json, /ATTACHED SCREENSHOTS/i);
  assert.match(json, /grafana\.png/);
  const pdf = await renderPdf(def);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
});

test('a diagram with no rendered image is printed as its source, never dropped', async () => {
  const i = withDiagram();
  const def = buildRcaPdfDefinition(i, parseReportDoc(writer(), i));
  assert.match(JSON.stringify(def), /MongoDB/);
  assert.equal((await renderPdf(def)).subarray(0, 5).toString(), '%PDF-');
});

test('the Markdown export keeps diagrams as mermaid fences', () => {
  const i = withDiagram();
  const md = buildReportMarkdown(i, parseReportDoc(writer(), i));
  assert.match(md, /## Topology\n\n```mermaid\ngraph TD/);
  assert.equal(md.split('```mermaid').length - 1, 1);
});

test('a user turn with images still reads as text everywhere reports look', () => {
  const i = input({
    steps: [
      { seq: 0, messageJson: { role: 'user', content: [{ type: 'text', text: 'what is this error?' }, { type: 'image_url', image_url: { url: 'supops-attachment:abc' } }] } },
      { seq: 1, messageJson: { role: 'assistant', content: 'It is an OOM kill.' } },
    ],
  });
  const doc = parseReportDoc(null, i);
  assert.ok(buildReportMarkdown(i, doc).length > 0);
});
