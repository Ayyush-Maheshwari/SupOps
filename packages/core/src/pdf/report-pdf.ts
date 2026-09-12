import type { Content, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { RiskTier } from '@supops/shared';
import type { ReportInput, ReportToolCall } from '../report.ts';
import { essentialEvidence, recordedFindings } from '../report.ts';
import { markdownToPdf } from './markdown.ts';
import { BRAND_LOCKUP_DATA_URI } from './brand-logo.ts';

const INK = '#111827';

const MUTED = '#6b7280';
const LINE = '#e5e7eb';
/** SupOps brand blue (the UI's --blue = rgb(10,132,255)), readable on white for print. */
const BRAND = '#0A84FF';

/** Finding severity colours, matching the UI's severity palette. */
const SEVERITY_COLOR: Record<string, string> = {
  critical: '#b91c1c',
  warning: '#b45309',
  info: '#0891b2',
};

/** Risk colours carry meaning; keep them recognisable from the UI. */
const TIER_COLOR: Record<RiskTier, string> = {
  read_only: '#6b7280',
  low: '#0891b2',
  medium: '#b45309',
  high: '#b91c1c',
  forbidden: '#7f1d1d',
};

/**
 * Build the incident document as a print-ready PDF.
 *
 * Rendered from the same structured input as the Markdown version rather than by
 * converting one to the other: a Markdown-to-PDF pass loses the distinction between
 * an agent's claim and an execution record, which is the one thing this document
 * exists to preserve. Only the agent's own summary is Markdown, and it is the only
 * part that gets parsed.
 */
export function buildRcaPdfDefinition(input: ReportInput, aiBody?: string | null): TDocumentDefinitions {
  const { run, toolCalls, projectName, agentName } = input;

  const executed = toolCalls.filter((c) => c.state === 'succeeded' || c.state === 'failed');
  const changed = executed.filter((c) => c.tier && c.tier !== 'read_only');
  const denied = toolCalls.filter((c) => c.state === 'denied' || c.state === 'expired');
  const blocked = toolCalls.filter((c) => c.state === 'blocked');
  const decisions = toolCalls.filter((c) => c.decidedBy || c.decisionComment);
  const unknown = toolCalls.filter((c) => c.state === 'unknown_outcome');

  const docKind = input.kind === 'health' ? 'Health report' : 'Incident report';
  const content: Content[] = [];

  const finish = (): TDocumentDefinitions => ({
    pageSize: 'A4',
    pageMargins: [40, 42, 40, 46],
    defaultStyle: { font: 'Helvetica', fontSize: 9.5, color: INK, lineHeight: 1.25 },
    info: { title: `${docKind}: ${run.title}`, author: 'SupOps', subject: projectName },
    content,
    footer: (page, total) => ({
      columns: [
        {
          text: `SupOps · run ${run.id} · generated ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`,
          fontSize: 6.5,
          color: MUTED,
        },
        { text: `${page} / ${total}`, alignment: 'right', fontSize: 7, color: MUTED, width: 40 },
      ],
      margin: [40, 12, 40, 0],
    }),
  });

  // The SupOps app logo (light-background lockup), embedded as a data URI. It reads
  // on white directly, so it sits on the page with no band. A thin brand rule closes
  // the header.
  content.push({ image: BRAND_LOCKUP_DATA_URI, width: 150, margin: [0, 4, 0, 8] });
  content.push({
    canvas: [{ type: 'line', x1: 0, y1: 0, x2: 515, y2: 0, lineWidth: 2, lineColor: BRAND }],
    margin: [0, 0, 0, 14],
  });

  content.push({ text: docKind, fontSize: 9, color: BRAND, bold: true, characterSpacing: 0.5, margin: [0, 0, 0, 2] });
  content.push({ text: run.title, fontSize: 17, bold: true, color: INK, margin: [0, 0, 0, 10] });

  // --- facts ---------------------------------------------------------------
  const facts: Array<[string, Content]> = [
    ['Status', { text: statusLabel(run.status) + (run.statusReason ? ` — ${run.statusReason}` : '') }],
    ['Started', { text: run.startedAt.toISOString() }],
  ];
  if (run.endedAt) {
    facts.push(['Duration', { text: humanDuration(run.endedAt.getTime() - run.startedAt.getTime()) }]);
  }
  facts.push(['Project', { text: projectName }]);
  facts.push(['Agent', { text: `${agentName} (${run.model})` }]);
  facts.push([
    'Targets in scope',
    {
      text: run.targetsSnapshot.map((t) => `${t.slug} (${t.kind}, ${t.env})`).join(', ') || 'none',
      font: 'Courier',
      fontSize: 8.5,
    },
  ]);
  facts.push([
    'Actions',
    {
      text: `${executed.length} executed, ${changed.length} state-changing` +
        (denied.length ? `, ${denied.length} refused` : '') +
        (blocked.length ? `, ${blocked.length} blocked` : ''),
    },
  ]);

  content.push({
    table: {
      widths: [110, '*'],
      body: facts.map(([k, v]) => [
        { text: k, bold: true, color: MUTED, fontSize: 9, margin: [0, 3, 0, 3] },
        { ...(v as object), fontSize: 9, margin: [0, 3, 0, 3] } as Content,
      ]),
    },
    layout: 'lightHorizontalLines',
    margin: [0, 0, 0, 14],
  });

  // --- model-written report (share-ready): render it, then findings, the command
  //     record, and the essential evidence -- so a read-only sweep is not reduced to
  //     just prose with no numbers behind it.
  if (aiBody && aiBody.trim()) {
    content.push(...markdownToPdf(aiBody.trim()));

    const findings = recordedFindings(toolCalls);
    if (findings.length) {
      content.push(sectionHeading('Findings', true));
      content.push({
        ul: findings.map((f) => ({
          text: [
            { text: f.severity, bold: true, color: SEVERITY_COLOR[f.severity] ?? MUTED },
            { text: `  ${f.target}  `, font: 'Courier', fontSize: 7.5, color: MUTED },
            { text: f.finding.replace(/\s*\n+\s*/g, ' ') },
          ],
        })),
        fontSize: 9,
        margin: [0, 0, 0, 10],
      } as unknown as Content);
    }

    const notable = toolCalls.filter((c) => (c.tier && c.tier !== 'read_only') || c.isError || c.decidedBy);
    const executed = toolCalls.filter(
      (c) => c.toolKey !== 'record_finding' && (c.state === 'succeeded' || c.state === 'failed'),
    );
    const record = (notable.length ? notable : executed).slice(0, 30);
    if (record.length) {
      content.push(sectionHeading(notable.length ? 'Action record' : 'Commands run', true));
      content.push({
        table: {
          headerRows: 1,
          widths: [14, '*', 55, 48, 62, 66],
          body: [
            ['#', 'Command', 'Target', 'Risk', 'Outcome', 'Approved by'].map((h) => ({
              text: h, bold: true, fontSize: 8, color: MUTED, fillColor: '#f9fafb',
              margin: [3, 4, 3, 4] as [number, number, number, number],
            })),
            ...record.map((c, i) => [
              cell(String(i + 1), { fontSize: 8, color: MUTED }),
              cell(truncate(flatten(c.renderedCommand ?? c.toolKey), 90), { font: 'Courier', fontSize: 7.5 }),
              cell(typeof c.argsJson.target === 'string' ? c.argsJson.target : '—', { font: 'Courier', fontSize: 7.5 }),
              cell(c.tier ?? '—', { fontSize: 8, color: c.tier ? TIER_COLOR[c.tier] : MUTED, bold: true }),
              cell(outcomeLabel(c), { fontSize: 8, bold: c.state === 'unknown_outcome' }),
              cell(approverLabel(c, input.approverNames), { fontSize: 8, color: MUTED }),
            ]),
          ],
        },
        layout: 'lightHorizontalLines',
        margin: [0, 0, 0, 12],
      });
    }

    const evidence = essentialEvidence(input);
    if (evidence.length) {
      content.push(sectionHeading('Evidence', true));
      evidence.forEach((c) => {
        const block: Content[] = [];
        const target = typeof c.argsJson.target === 'string' ? `  on ${c.argsJson.target}` : '';
        block.push({
          text: [
            { text: c.toolKey, bold: true, fontSize: 9.5 },
            { text: `  ${outcomeLabel(c)}${target}`, fontSize: 8, color: c.isError ? TIER_COLOR.high : MUTED },
          ],
          margin: [0, 0, 0, 3],
        });
        block.push(codeBlock(c.renderedCommand ?? c.toolKey));
        if (c.resultJson?.text) {
          const body = c.resultJson.text.trimEnd();
          block.push(codeBlock(body.length > 2000 ? `${body.slice(0, 2000)}\n… [truncated]` : body));
        }
        content.push({ stack: block, unbreakable: block.length < 4, margin: [0, 0, 0, 8] });
      });
    }

    content.push({
      text: 'Written by SupOps from this run\'s execution record. The tables and evidence above are that record; verify the narrative against them.',
      fontSize: 7.5, italics: true, color: MUTED, margin: [0, 4, 0, 0],
    });
    return finish();
  }

  // --- the agent's own account --------------------------------------------
  content.push(sectionHeading('Summary'));
  const summary = finalAssistantMessage(input.steps);
  if (summary) {
    content.push({
      text: "The agent's own account. Verify it against the execution record below.",
      italics: true,
      color: MUTED,
      fontSize: 8.5,
      margin: [0, 0, 0, 6],
    });
    content.push(...markdownToPdf(summary.trim()));
  } else {
    content.push({ text: 'The agent did not produce a closing summary.', italics: true, color: MUTED, fontSize: 9.5 });
  }

  // --- what actually happened ----------------------------------------------
  content.push(sectionHeading('What was done', true));
  if (toolCalls.length === 0) {
    content.push({ text: 'No actions were attempted.', italics: true, color: MUTED, fontSize: 9.5 });
  } else {
    content.push({
      table: {
        headerRows: 1,
        widths: [14, '*', 55, 48, 62, 66],
        body: [
          ['#', 'Action', 'Target', 'Risk', 'Outcome', 'Approved by'].map((h) => ({
            text: h,
            bold: true,
            fontSize: 8,
            color: MUTED,
            fillColor: '#f9fafb',
            margin: [3, 4, 3, 4] as [number, number, number, number],
          })),
          ...toolCalls.map((c, i) => [
            cell(String(i + 1), { fontSize: 8, color: MUTED }),
            cell(truncate(flatten(c.renderedCommand ?? c.toolKey), 110), { font: 'Courier', fontSize: 7.5 }),
            cell(typeof c.argsJson.target === 'string' ? c.argsJson.target : '—', { font: 'Courier', fontSize: 7.5 }),
            cell(c.tier ?? '—', { fontSize: 8, color: c.tier ? TIER_COLOR[c.tier] : MUTED, bold: true }),
            cell(outcomeLabel(c), { fontSize: 8, bold: c.state === 'unknown_outcome' }),
            cell(approverLabel(c, input.approverNames), { fontSize: 8, color: MUTED }),
          ]),
        ],
      },
      layout: 'lightHorizontalLines',
      margin: [0, 0, 0, 12],
    });
  }

  // --- evidence -------------------------------------------------------------
  if (toolCalls.length > 0) {
    content.push(sectionHeading('Evidence', true));
    toolCalls.forEach((c, i) => {
      const block: Content[] = [];
      block.push({
        text: [
          { text: `${i + 1}. ${c.toolKey}`, bold: true, fontSize: 10 },
          { text: `  ${outcomeLabel(c)}`, fontSize: 8.5, color: c.isError ? TIER_COLOR.high : MUTED },
        ],
        margin: [0, 0, 0, 4],
      });
      block.push(codeBlock(c.renderedCommand ?? JSON.stringify(c.argsJson)));

      const intent = str(c.argsJson.intent);
      const effect = str(c.argsJson.expected_effect);
      if (intent) block.push(labelled('Intent (stated by the agent)', intent));
      if (effect) block.push(labelled('Expected effect', effect));

      if (c.tier && c.tier !== 'read_only' && c.riskJson) {
        const reasons = c.riskJson.contributions.filter((x) => x.tier !== 'read_only');
        if (reasons.length) {
          block.push({
            text: `Assessed ${c.tier} because:`,
            bold: true,
            fontSize: 8.5,
            color: MUTED,
            margin: [0, 2, 0, 2],
          });
          block.push({
            ul: reasons.map((r) => ({
              text: [
                { text: r.reason },
                ...(r.ruleId ? [{ text: `  (${r.ruleId})`, color: MUTED, font: 'Courier', fontSize: 7.5 }] : []),
              ],
            })),
            fontSize: 8.5,
            margin: [0, 0, 0, 4],
          } as unknown as Content);
        }
      }

      if (c.decisionComment) block.push(labelled('Reviewer note', c.decisionComment));
      if (c.startedAt && c.finishedAt) {
        block.push(
          labelled('Ran at', `${c.startedAt.toISOString()} (${humanDuration(c.finishedAt.getTime() - c.startedAt.getTime())})`),
        );
      }
      if (c.resultJson) {
        block.push({ text: 'Output', bold: true, fontSize: 8.5, color: MUTED, margin: [0, 3, 0, 2] });
        block.push(codeBlock(c.resultJson.text.trimEnd()));
      }

      // Keeping each action together avoids a page break splitting a command from
      // the output that proves what it did.
      content.push({ stack: block, unbreakable: block.length < 6, margin: [0, 0, 0, 10] });
    });
  }

  // --- human decisions ------------------------------------------------------
  if (decisions.length) {
    content.push(sectionHeading('Human decisions', true));
    content.push({
      ul: decisions.map((c) => ({
        text: [
          { text: c.state === 'denied' ? 'rejected' : 'approved', bold: true },
          { text: ` by ${approverLabel(c, input.approverNames)}: ` },
          { text: flatten(c.renderedCommand ?? c.toolKey), font: 'Courier', fontSize: 8 },
          ...(c.decisionComment ? [{ text: ` — "${c.decisionComment}"`, italics: true, color: MUTED }] : []),
        ],
      })),
      fontSize: 9,
      margin: [0, 0, 0, 10],
    } as unknown as Content);
  }

  // --- caveats --------------------------------------------------------------
  const caveats: string[] = [];
  if (changed.length === 0) caveats.push('This run made no state-changing actions; it was diagnostic only.');
  if (denied.length) caveats.push(`${denied.length} proposed action(s) were refused and did not run.`);
  if (blocked.length) caveats.push(`${blocked.length} proposed action(s) were blocked by policy and did not run.`);
  if (unknown.length) {
    caveats.push(
      'One or more commands have an unknown outcome: the worker stopped after dispatching them ' +
        'but before recording a result. They may or may not have taken effect.',
    );
  }
  caveats.push(
    "Command results above are raw output captured at the time. Nothing in this document re-verifies the system's current state.",
  );

  content.push(sectionHeading('Caveats', true));
  content.push({ ul: caveats, fontSize: 9, color: MUTED, margin: [0, 0, 0, 6] } as unknown as Content);

  return finish();
}

// --------------------------------------------------------------------------

const sectionHeading = (text: string, spaced = false): Content => ({
  text,
  fontSize: 11.5,
  bold: true,
  margin: [0, spaced ? 10 : 0, 0, 5],
});

const cell = (text: string, style: Record<string, unknown>): Content =>
  ({ text, margin: [3, 4, 3, 4], ...style }) as Content;

const codeBlock = (text: string): Content => ({
  table: {
    widths: ['*'],
    body: [[{
      text,
      font: 'Courier',
      fontSize: 7.5,
      color: '#1f2937',
      preserveLeadingSpaces: true,
      margin: [5, 4, 5, 4] as [number, number, number, number],
    }]],
  },
  layout: {
    hLineWidth: () => 0.5,
    vLineWidth: () => 0.5,
    hLineColor: () => LINE,
    vLineColor: () => LINE,
    fillColor: () => '#f9fafb',
  },
  margin: [0, 0, 0, 5],
});

const labelled = (label: string, value: string): Content => ({
  text: [
    { text: `${label}: `, bold: true, color: MUTED, fontSize: 8.5 },
    { text: value, fontSize: 8.5 },
  ],
  margin: [0, 0, 0, 3],
});

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null);
const flatten = (s: string): string => s.replace(/\s*\n+\s*/g, ' ').trim();
const truncate = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function finalAssistantMessage(steps: ReportInput['steps']): string | null {
  for (let i = steps.length - 1; i >= 0; i -= 1) {
    const m = steps[i]!.messageJson;
    if (m.role === 'assistant' && typeof m.content === 'string' && m.content.trim()) return m.content;
  }
  return null;
}

const STATUS_LABELS: Record<string, string> = {
  succeeded: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled by an operator',
  awaiting_approval: 'Paused — awaiting approval',
  awaiting_input: 'Paused — awaiting input',
  suspended: 'Paused — provider backoff',
  halted: 'Halted by the kill switch',
  running: 'In progress',
  queued: 'Queued',
  expired: 'Expired',
};
const statusLabel = (s: string): string => STATUS_LABELS[s] ?? s;

function outcomeLabel(c: ReportToolCall): string {
  switch (c.state) {
    case 'succeeded': return 'succeeded';
    case 'failed': return 'failed';
    case 'denied': return 'rejected';
    case 'expired': return 'approval expired';
    case 'blocked': return 'blocked by policy';
    case 'unknown_outcome': return 'outcome unknown';
    case 'awaiting_approval': return 'awaiting approval';
    default: return c.state;
  }
}

function approverLabel(c: ReportToolCall, names: Record<string, string>): string {
  if (c.decidedBy) return names[c.decidedBy] ?? c.decidedBy;
  if (c.state === 'blocked') return 'n/a';
  return c.tier && c.tier !== 'read_only' && c.tier !== 'low' ? '—' : 'auto';
}

function humanDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  return `${m}m ${Math.round((ms % 60_000) / 1000)}s`;
}
