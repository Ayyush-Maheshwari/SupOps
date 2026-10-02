import type { Content, ContentText, TDocumentDefinitions } from 'pdfmake/interfaces';
import type { RiskTier } from '@supops/shared';
import type { ReportInput, ReportToolCall } from '../report.ts';
import type { ReportDoc, Status, Tone } from '../report-doc.ts';
import {
  extractAgentDiagrams,
  OUTCOME_META, REPORT_TYPE_LABEL, TOOL_LABEL, approvalLedger, displayCommand, isCommand, citedCalls, fmtShort, fmtUtc, humanDuration, runFacts, trimOutput,
} from '../report-doc.ts';
import { inlineToPdf } from './markdown.ts';
import { BRAND_LOCKUP_DATA_URI } from './brand-logo.ts';

/*
 * The run report, designed as a document rather than printed as a transcript.
 *
 * Page one answers "what happened and what do I do" without reading a paragraph:
 * a header with the verdict, headline numbers as tiles, the risk profile of what
 * ran, the root cause, and a numbered chain from evidence to conclusion that names
 * the commands behind each step. Detail follows in order of usefulness, and the raw
 * evidence is an appendix, trimmed to the lines that matter.
 */

// ---- palette ----------------------------------------------------------------
const INK = '#0F172A';
const TEXT = '#334155';
const MUTED = '#64748B';
const FAINT = '#94A3B8';
const LINE = '#E2E8F0';
const PANEL = '#F5F7FB';
const BRAND = '#0A84FF';
const BRAND_DEEP = '#0B4FA8';

const TONE: Record<Tone, { fg: string; bg: string }> = {
  good: { fg: '#047857', bg: '#E7F7EF' },
  warn: { fg: '#C26A00', bg: '#FEF4E2' },
  bad: { fg: '#B91C1C', bg: '#FDECEC' },
  neutral: { fg: '#475569', bg: '#EEF2F6' },
};
/** Priority / confidence colours: high red, medium amber, low blue -- everywhere a pill appears. */
const LEVEL: Record<'high' | 'medium' | 'low', { fg: string; bg: string }> = {
  high: { fg: '#B91C1C', bg: '#FBD5D5' },
  medium: { fg: '#A95A00', bg: '#FDE5BE' },
  low: { fg: '#075985', bg: '#D3ECFB' },
};
const CONFIDENCE: Record<'confirmed' | 'likely' | 'unconfirmed', { fg: string; bg: string }> = {
  confirmed: { fg: '#FFFFFF', bg: '#047857' },
  likely: { fg: '#FFFFFF', bg: '#C26A00' },
  unconfirmed: { fg: '#FFFFFF', bg: '#64748B' },
};

const STATUS_TONE: Record<Status | 'unreachable', Tone> = {
  ok: 'good', warn: 'warn', crit: 'bad', info: 'neutral', unreachable: 'bad',
};
const STATUS_WORD: Record<Status | 'unreachable', string> = {
  ok: 'OK', warn: 'Warning', crit: 'Critical', info: 'Info', unreachable: 'Unreachable',
};
const TIER_COLOR: Record<RiskTier, string> = {
  read_only: '#94A3B8',
  low: '#0EA5E9',
  medium: '#F59E0B',
  high: '#EF4444',
  forbidden: '#7F1D1D',
};
const TIER_LABEL: Record<RiskTier, string> = {
  read_only: 'Read-only', low: 'Low', medium: 'Medium', high: 'High', forbidden: 'Forbidden',
};

// ---- page geometry (A4, points) ---------------------------------------------
const PAGE_W = 595.28;
const MX = 44;
const W = PAGE_W - MX * 2;

// ---- text helpers -----------------------------------------------------------

/** Strip glyphs the embedded fonts don't carry (emoji, pictographs) so nothing prints as tofu. */
const safe = (s: string): string =>
  s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();

/** Prose that may carry **bold** / `code` from the writer. */
const rich = (s: string, style: Partial<ContentText> = {}): Content =>
  ({ text: inlineToPdf(safe(s)), ...style }) as Content;

const clip = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 1).trimEnd()}…`);

/**
 * Inter's line box at lineHeight 1 is ~1.21em (ascent .969 + descent .242). Digits and
 * capitals sit in the upper part of that box, and their optical centre lands almost
 * exactly on the box centre -- so centring the box centres the glyphs. The body's
 * lineHeight (1.2) must NOT apply here, or the extra gap pushes text below centre.
 */
const LINE_BOX = 1.21;

/** A rounded, filled label, sized to its text, with the text centred in it. */
function pill(label: string, fg: string, bg: string, size = 7): Content {
  const text = label.toUpperCase();
  const w = Math.ceil(text.length * size * 0.7 + text.length * 0.6 + 16);
  const h = Math.round(size * 2.1);
  return {
    width: w,
    // A fixed-width column: the shape and the text share exactly the same box, so
    // the text is centred on the pill, not on whatever cell the pill sits in.
    columns: [
      {
        width: w,
        stack: [
          { canvas: [{ type: 'rect', x: 0, y: 0, w, h, r: h / 2, color: bg }] },
          {
            text,
            font: 'Inter',
            bold: true,
            fontSize: size,
            lineHeight: 1,
            color: fg,
            characterSpacing: 0.6,
            alignment: 'center',
            relativePosition: { x: 0, y: -(h + size * LINE_BOX) / 2 },
          },
        ],
      },
      { width: '*', text: '' },
    ],
  } as unknown as Content;
}

/** A numbered disc for the evidence chain, number centred. */
function disc(n: number, color: string): Content {
  const d = 18;
  const size = 8.5;
  return {
    width: d,
    columns: [{
      width: d,
      stack: [
        { canvas: [{ type: 'ellipse', x: d / 2, y: d / 2, r1: d / 2, r2: d / 2, color }] },
        {
          text: String(n), bold: true, fontSize: size, lineHeight: 1, color: '#FFFFFF', alignment: 'center',
          relativePosition: { x: 0, y: -(d + size * LINE_BOX) / 2 },
        },
      ],
    }],
  } as unknown as Content;
}

const dot = (color: string, d = 7): Content =>
  ({ canvas: [{ type: 'ellipse', x: d / 2, y: d / 2 + 2, r1: d / 2, r2: d / 2, color }], width: d + 2 }) as unknown as Content;

/** A section label: small, spaced capitals with a hairline. */
function section(title: string, note?: string): Content {
  return {
    stack: [
      {
        columns: [
          { text: title.toUpperCase(), font: 'Inter', bold: true, fontSize: 8, color: BRAND_DEEP, characterSpacing: 1.1, width: 'auto' },
          ...(note ? [{ text: note, fontSize: 7.5, color: FAINT, alignment: 'right' as const }] : []),
        ],
      },
      { canvas: [{ type: 'line', x1: 0, y1: 4, x2: W, y2: 4, lineWidth: 0.6, lineColor: LINE }], margin: [0, 0, 0, 8] },
    ],
    margin: [0, 16, 0, 0],
    // Lets the page-break rule below keep a heading with what follows it.
    headlineLevel: 1,
  } as Content;
}

/** Tables with soft zebra rows and no heavy rules. */
const softTable = {
  hLineWidth: (i: number) => (i === 1 ? 0.8 : 0),
  vLineWidth: () => 0,
  hLineColor: () => LINE,
  fillColor: (row: number) => (row === 0 ? '#EEF2F7' : row % 2 === 0 ? '#FAFBFD' : null),
  paddingLeft: () => 6,
  paddingRight: () => 6,
  paddingTop: () => 4,
  paddingBottom: () => 4,
};

const STATE_WORD: Record<string, string> = {
  succeeded: 'succeeded', failed: 'failed', denied: 'rejected — did not run', expired: 'approval expired',
  blocked: 'blocked by policy', unknown_outcome: 'outcome unknown',
};

const th = (t: string): Content => ({ text: t.toUpperCase(), bold: true, fontSize: 6.8, color: MUTED, characterSpacing: 0.6 });

// ---- the document -----------------------------------------------------------

/**
 * Pictures that go in the PDF beyond what the structured report describes.
 *
 * `diagrams` maps a diagram's key (see `diagramKey`) to a PNG data URL the browser
 * rendered; a diagram with no PNG is printed as its source instead, so it is never
 * silently dropped. `images` are the screenshots the operator pasted into the run.
 */
export interface ReportVisuals {
  diagrams?: Map<string, string>;
  images?: Array<{ name: string | null; dataUrl: string; width: number | null; height: number | null }>;
}

export function buildRcaPdfDefinition(
  input: ReportInput,
  doc: ReportDoc,
  visuals: ReportVisuals = {},
): TDocumentDefinitions {
  const { run, toolCalls } = input;
  const facts = runFacts(input);
  const ledger = approvalLedger(input);
  const outcome = OUTCOME_META[doc.outcome];
  const tone = TONE[outcome.tone];
  const typeLabel = REPORT_TYPE_LABEL[doc.type];
  const cmd = (n: number): ReportToolCall | undefined => toolCalls[n - 1];
  const content: Content[] = [];

  // ---- header band (full bleed) ---------------------------------------------
  const targets = run.targetsSnapshot.filter((t) => !/^Behind\s/.test(t.description ?? '')).map((t) => t.slug);
  const meta = [
    input.projectName,
    fmtUtc(run.startedAt),
    `${targets.slice(0, 4).join(', ')}${targets.length > 4 ? ` +${targets.length - 4}` : ''}`,
    `${input.agentName} · ${run.model}`,
  ].filter(Boolean);

  content.push({
    table: {
      widths: [PAGE_W],
      body: [[{
        stack: [
          { canvas: [{ type: 'rect', x: 0, y: 0, w: PAGE_W, h: 4, color: BRAND }] },
          {
            columns: [
              { image: BRAND_LOCKUP_DATA_URI, width: 96 },
              {
                stack: [
                  { text: typeLabel.toUpperCase(), bold: true, fontSize: 7.5, color: BRAND_DEEP, characterSpacing: 1.2, alignment: 'right' },
                  { text: `Generated ${fmtUtc(new Date())}`, fontSize: 7, color: FAINT, alignment: 'right', margin: [0, 2, 0, 0] },
                ],
              },
            ],
            margin: [MX, 18, MX, 0],
          },
          { text: safe(doc.title), font: 'Display', bold: true, fontSize: 20, color: INK, lineHeight: 1.12, margin: [MX, 16, MX, 0] },
          rich(doc.headline, { fontSize: 10.5, color: TEXT, lineHeight: 1.35, margin: [MX, 6, MX, 0] } as Partial<ContentText>),
          {
            columns: [
              pill(outcome.label, tone.fg, tone.bg, 7.5),
              { text: meta.join('   ·   '), fontSize: 7.5, color: MUTED, margin: [10, 3, 0, 0] },
            ],
            margin: [MX, 12, MX, 20],
          },
        ],
        fillColor: PANEL,
        border: [false, false, false, false],
      }]],
    },
    layout: { defaultBorder: false, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
    margin: [-MX, -48, -MX, 14],
  } as Content);

  // ---- KPI tiles ------------------------------------------------------------
  const kpis: Array<[string, string, string?]> = [
    [facts.duration, 'Duration'],
    [String(facts.commands), 'Commands run', facts.failed ? `${facts.failed} failed` : undefined],
    [String(facts.changes), 'Changes made'],
    [String(facts.approvals), 'Approvals', facts.rejected ? `${facts.rejected} rejected` : facts.refused ? `${facts.refused} blocked` : undefined],
    [String(facts.targets), facts.targets === 1 ? 'Target' : 'Targets'],
    [String(facts.findings), 'Findings', facts.critical ? `${facts.critical} critical` : facts.warnings ? `${facts.warnings} warning` : undefined],
  ];
  content.push({
    table: {
      widths: kpis.map(() => '*'),
      body: [kpis.map(([v, label, sub]) => ({
        stack: [
          { text: v, font: 'Display', bold: true, fontSize: 16, color: INK },
          { text: label.toUpperCase(), fontSize: 6.5, color: MUTED, characterSpacing: 0.6, margin: [0, 2, 0, 0] },
          ...(sub ? [{ text: sub, fontSize: 6.8, color: TONE.bad.fg, margin: [0, 1, 0, 0] }] : []),
        ],
        fillColor: '#FFFFFF',
      }))],
    },
    layout: {
      hLineWidth: () => 0.8,
      vLineWidth: () => 0.8,
      hLineColor: () => LINE,
      vLineColor: () => LINE,
      paddingLeft: () => 9, paddingRight: () => 6, paddingTop: () => 8, paddingBottom: () => 8,
    },
  } as Content);

  // ---- risk profile bar -----------------------------------------------------
  const tierOrder: RiskTier[] = ['read_only', 'low', 'medium', 'high', 'forbidden'];
  const totalTier = tierOrder.reduce((s, t) => s + facts.tiers[t], 0);
  if (totalTier > 0) {
    let x = 0;
    const rects = tierOrder.filter((t) => facts.tiers[t] > 0).map((t) => {
      const w = Math.max(3, (facts.tiers[t] / totalTier) * W);
      const r = { type: 'rect', x, y: 0, w: Math.min(w, W - x), h: 6, color: TIER_COLOR[t] };
      x += w;
      return r;
    });
    content.push({
      stack: [
        {
          columns: [
            { text: 'RISK PROFILE OF ACTIONS', fontSize: 6.8, bold: true, color: MUTED, characterSpacing: 0.8, width: 'auto' },
            {
              text: tierOrder.filter((t) => facts.tiers[t] > 0).flatMap((t, i) => [
                ...(i ? [{ text: '    ' }] : []),
                { text: '■ ', color: TIER_COLOR[t] },
                { text: `${TIER_LABEL[t]} ${facts.tiers[t]}`, color: TEXT },
              ]),
              fontSize: 7,
              alignment: 'right',
            },
          ],
          margin: [0, 0, 0, 4],
        },
        { canvas: [{ type: 'rect', x: 0, y: 0, w: W, h: 6, r: 3, color: '#EEF2F6' }, ...rects] },
      ],
      margin: [0, 12, 0, 0],
    } as unknown as Content);
  }

  // ---- summary --------------------------------------------------------------
  if (doc.summary.length) {
    content.push(section('Summary'));
    content.push({
      ul: doc.summary.map((s) => rich(s, { margin: [0, 0, 0, 3] } as Partial<ContentText>)),
      markerColor: BRAND,
      fontSize: 9.5,
      color: TEXT,
      lineHeight: 1.3,
    } as unknown as Content);
  }

  // ---- key metrics ------------------------------------------------------------
  if (doc.metrics.length) {
    content.push(section('Key metrics'));
    const perRow = doc.metrics.length === 4 ? 4 : 3;
    for (let i = 0; i < doc.metrics.length; i += perRow) {
      const row = doc.metrics.slice(i, i + perRow);
      content.push({
        columns: [
          ...row.map((m) => {
            const t = TONE[STATUS_TONE[m.status]];
            return {
              table: {
                widths: [3, '*'],
                body: [[
                  { text: '', fillColor: t.fg },
                  {
                    stack: [
                      { text: safe(m.value), font: 'Display', bold: true, fontSize: 15, color: t.fg === TONE.neutral.fg ? INK : t.fg },
                      { text: safe(m.label), fontSize: 7.5, color: MUTED, margin: [0, 2, 0, 0] },
                    ],
                    fillColor: t.bg,
                  },
                ]],
              },
              layout: {
                defaultBorder: false,
                paddingLeft: (c: number) => (c === 0 ? 0 : 9), paddingRight: () => 6, paddingTop: () => 7, paddingBottom: () => 7,
              },
            };
          }),
          ...Array(perRow - row.length).fill({ text: '' }),
        ],
        columnGap: 8,
        margin: [0, 0, 0, 8],
      } as unknown as Content);
    }
  }

  // ---- root cause -----------------------------------------------------------
  if (doc.rootCause) {
    const conf = doc.rootCause.confidence;
    const ct = TONE[conf === 'confirmed' ? 'bad' : conf === 'likely' ? 'warn' : 'neutral'];
    content.push(section('Root cause'));
    content.push({
      table: {
        widths: [3, '*'],
        body: [[
          { text: '', fillColor: ct.fg },
          {
            stack: [
              { ...(pill(`${conf}`, CONFIDENCE[conf].fg, CONFIDENCE[conf].bg, 6.5) as object), margin: [0, 0, 0, 6] } as Content,
              rich(doc.rootCause.statement, { fontSize: 10.5, color: INK, lineHeight: 1.35 } as Partial<ContentText>),
            ],
            fillColor: ct.bg,
          },
        ]],
      },
      layout: { defaultBorder: false, paddingLeft: (c: number) => (c === 0 ? 0 : 12), paddingRight: () => 12, paddingTop: () => 10, paddingBottom: () => 10 },
    } as unknown as Content);
  }

  // ---- how it was established -----------------------------------------------
  if (doc.chain.length) {
    content.push(section('How it was established', 'commands referenced as #n are in the evidence appendix'));
    content.push({
      table: {
        widths: [22, '*'],
        body: doc.chain.map((c, i) => {
          const color = TONE[STATUS_TONE[c.status]].fg;
          const refs = c.evidence
            .map((n) => ({ n, c: cmd(n) }))
            .filter((r) => isCommand(r.c))
            .map((r) => [
              { text: `#${r.n} `, bold: true, color: BRAND_DEEP },
              { text: `${clip(safe(displayCommand(r.c!)), 64)}   `, color: MUTED },
            ])
            .flat();
          return [
            disc(i + 1, c.status === 'info' ? BRAND : color),
            {
              stack: [
                rich(c.finding, { fontSize: 9.5, color: INK, lineHeight: 1.3 } as Partial<ContentText>),
                ...(refs.length ? [{ text: refs, font: 'Mono', fontSize: 7, margin: [0, 3, 0, 0] }] : []),
              ],
            },
          ];
        }),
      },
      layout: {
        defaultBorder: false,
        hLineWidth: (i: number, node: { table: { body: unknown[] } }) => (i > 0 && i < node.table.body.length ? 0.6 : 0),
        hLineColor: () => '#EDF1F6',
        paddingLeft: () => 0, paddingRight: () => 4, paddingTop: () => 6, paddingBottom: () => 6,
      },
    } as unknown as Content);
  }

  // ---- changes made ---------------------------------------------------------
  if (doc.actions.length) {
    content.push(section('Changes made'));
    content.push({
      table: {
        headerRows: 1,
        widths: ['*', '*', 60, 34],
        body: [
          [th('Change'), th('Result'), th('Approved by'), th('Ref')],
          ...doc.actions.map((a) => {
            const c = a.evidence.map(cmd).find(Boolean);
            const who = c?.decidedBy ? (input.approverNames[c.decidedBy] ?? '—') : c?.tier && c.tier !== 'read_only' && c.tier !== 'low' ? '—' : 'auto';
            return [
              rich(a.action, { fontSize: 8.5, color: INK }),
              rich(a.result, { fontSize: 8.5, color: TEXT }),
              { text: who, fontSize: 8, color: MUTED },
              { text: a.evidence.map((n) => `#${n}`).join(' '), font: 'Mono', fontSize: 7, color: BRAND_DEEP },
            ];
          }),
        ],
      },
      layout: softTable,
    } as unknown as Content);
  }

  // ---- per-target status ----------------------------------------------------
  if (doc.targets.length) {
    const counts = { ok: 0, warn: 0, crit: 0, unreachable: 0 };
    for (const t of doc.targets) counts[t.status] += 1;
    content.push(section('Targets', `${counts.ok} ok · ${counts.warn} warning · ${counts.crit + counts.unreachable} critical/unreachable`));
    content.push({
      table: {
        headerRows: 1,
        widths: [12, 110, 62, '*'],
        body: [
          [{ text: '' }, th('Target'), th('Status'), th('Notes')],
          ...doc.targets.map((t) => {
            const tn = TONE[STATUS_TONE[t.status]];
            return [
              dot(tn.fg),
              { text: t.target, font: 'Mono', fontSize: 8, color: INK },
              { text: STATUS_WORD[t.status], bold: true, fontSize: 8, color: tn.fg },
              rich(t.note, { fontSize: 8.5, color: TEXT }),
            ];
          }),
        ],
      },
      layout: softTable,
    } as unknown as Content);
  }

  // ---- tables (agent-produced first) ----------------------------------------
  for (const t of doc.tables) {
    content.push(section(t.title, t.source === 'agent' ? 'from the agent’s analysis' : undefined));
    content.push({
      table: {
        headerRows: 1,
        widths: t.columns.map(() => '*'),
        body: [
          t.columns.map((c) => th(c)),
          ...t.rows.map((r) => r.map((c) => rich(c, { fontSize: 8, color: TEXT }))),
        ],
      },
      layout: softTable,
    } as unknown as Content);
  }

  // ---- diagrams the agent drew ----------------------------------------------
  for (const d of extractAgentDiagrams(input.steps)) {
    const png = visuals.diagrams?.get(d.key);
    content.push(section(d.title, 'diagram from the agent’s analysis'));
    content.push(
      png
        ? ({ image: png, fit: [W, 460], alignment: 'center', margin: [0, 2, 0, 4] } as Content)
        : ({
            table: {
              widths: ['*'],
              body: [[{ text: d.source, font: 'Mono', fontSize: 7, color: TEXT, preserveLeadingSpaces: true }]],
            },
            layout: { defaultBorder: false, fillColor: () => PANEL, paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 6, paddingBottom: () => 6 },
          } as unknown as Content),
    );
  }

  // ---- screenshots the operator attached ------------------------------------
  if (visuals.images?.length) {
    content.push(section('Attached screenshots', 'provided by the operator with the request'));
    for (const img of visuals.images) {
      content.push({
        stack: [
          { image: img.dataUrl, fit: [W, 340], alignment: 'center' },
          ...(img.name ? [{ text: safe(img.name), fontSize: 7.5, color: MUTED, alignment: 'center', margin: [0, 3, 0, 0] }] : []),
        ],
        margin: [0, 2, 0, 10],
        unbreakable: true,
      } as unknown as Content);
    }
  }

  // ---- recommendations ------------------------------------------------------
  if (doc.recommendations.length) {
    content.push(section('Recommendations'));
    content.push({
      table: {
        widths: [58, '*'],
        body: doc.recommendations.map((r) => [
          pill(r.priority, LEVEL[r.priority].fg, LEVEL[r.priority].bg, 6.5),
          rich(r.text, { fontSize: 9.5, color: INK, lineHeight: 1.3 } as Partial<ContentText>),
        ]),
      },
      layout: { defaultBorder: false, paddingLeft: () => 0, paddingRight: () => 4, paddingTop: () => 4, paddingBottom: () => 5 },
    } as unknown as Content);
  }

  // ---- approvals & sign-off -------------------------------------------------
  content.push(section('Approvals'));
  if (ledger.length) {
    content.push({
      table: {
        headerRows: 1,
        widths: ['*', '*', 52, 52, 110],
        body: [
          [th('Reviewer'), th('Risks reviewed'), th('Approved'), th('Rejected'), th('Last decision')],
          ...ledger.map((e) => [
            { text: e.name, bold: true, fontSize: 8.5, color: INK },
            { text: e.risks.length ? e.risks.join(', ') : '—', fontSize: 8, color: e.risks.length ? INK : FAINT },
            { text: String(e.approved), fontSize: 8.5, color: e.approved ? TONE.good.fg : FAINT },
            { text: String(e.rejected), fontSize: 8.5, color: e.rejected ? TONE.bad.fg : FAINT },
            { text: e.at ? fmtUtc(e.at) : '—', fontSize: 8, color: MUTED },
          ]),
        ],
      },
      layout: softTable,
    } as unknown as Content);
  } else {
    content.push({ text: 'No human approval was needed: every action ran within the project’s risk policy.', fontSize: 9, color: MUTED });
  }

  // ---- evidence appendix ----------------------------------------------------
  const cited = citedCalls(input, doc);
  if (cited.length) {
    content.push({ ...(section('Evidence', 'output trimmed to the essentials') as object), pageBreak: cited.length > 3 ? 'before' : undefined } as Content);
    for (const n of cited) {
      const c = toolCalls[n - 1]!;
      const target = typeof c.argsJson.target === 'string' ? c.argsJson.target : '';
      const dur = c.startedAt && c.finishedAt ? humanDuration(c.finishedAt.getTime() - c.startedAt.getTime()) : '';
      const ok = c.state === 'succeeded';
      const body = trimOutput(c.resultJson?.text ?? '');
      const block: Content[] = [
        {
          columns: [
            { text: `#${n}`, font: 'Display', bold: true, fontSize: 10, color: BRAND_DEEP, width: 26 },
            {
              text: [
                { text: TOOL_LABEL[c.toolKey] ?? c.toolKey, bold: true, color: INK },
                ...(target ? [{ text: `  ·  ${target}`, font: 'Mono', color: TEXT }] : []),
                ...(c.tier ? [{ text: `  ·  ${TIER_LABEL[c.tier]}`, color: TIER_COLOR[c.tier], bold: true }] : []),
                { text: `  ·  ${STATE_WORD[c.state] ?? c.state.replace('_', ' ')}`, color: ok ? TONE.good.fg : c.state === 'failed' || c.state === 'denied' ? TONE.bad.fg : MUTED },
                ...(dur ? [{ text: `  ·  ${dur}`, color: FAINT }] : []),
                ...(c.decidedBy
                  ? [{
                      text: `  ·  ${c.state === 'denied' || c.state === 'expired' ? 'rejected' : 'approved'} by ${input.approverNames[c.decidedBy] ?? 'unknown'}`,
                      color: c.state === 'denied' || c.state === 'expired' ? TONE.bad.fg : MUTED,
                    }]
                  : []),
              ],
              fontSize: 8,
              margin: [0, 1.5, 0, 0],
            },
          ],
          margin: [0, 0, 0, 4],
        },
        {
          table: { widths: ['*'], body: [[{ text: `$ ${displayCommand(c)}`, font: 'Mono', fontSize: 7.3, color: '#E2E8F0', preserveLeadingSpaces: true }]] },
          layout: { defaultBorder: false, fillColor: () => '#0F172A', paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 5, paddingBottom: () => 5 },
        },
        ...(body
          ? [{
              table: { widths: ['*'], body: [[{ text: body, font: 'Mono', fontSize: 7, color: TEXT, preserveLeadingSpaces: true, lineHeight: 1.2 }]] },
              layout: { defaultBorder: false, fillColor: () => PANEL, paddingLeft: () => 8, paddingRight: () => 8, paddingTop: () => 5, paddingBottom: () => 6 },
            }]
          : []),
      ];
      content.push({ stack: block, unbreakable: true, margin: [0, 0, 0, 10] } as Content);
    }
  }

  content.push({
    text: doc.written
      ? 'Narrative written by the SupOps report model from this run’s execution record; every number and command above is taken from that record.'
      : 'Assembled directly from this run’s execution record (the report model was unavailable).',
    fontSize: 7, color: FAINT, italics: true, margin: [0, 10, 0, 0],
  });

  // ---- page furniture -------------------------------------------------------
  const signoff = footerApprovals(ledger);
  return {
    pageSize: 'A4',
    pageMargins: [MX, 48, MX, 58],
    defaultStyle: { font: 'Inter', fontSize: 9, color: TEXT, lineHeight: 1.2 },
    info: { title: doc.title, author: 'SupOps', subject: `${typeLabel} · ${input.projectName}`, keywords: doc.type },
    // Never leave a section heading alone at the foot of a page.
    // A section heading that would start in the last ~15% of a page moves to the
    // next one with its content instead of sitting alone at the foot.
    pageBreakBefore: (node) => {
      const n = node as { headlineLevel?: number; startPosition?: { verticalRatio?: number } };
      return n.headlineLevel === 1 && (n.startPosition?.verticalRatio ?? 0) > 0.85;
    },
    content,
    header: (page: number) =>
      page === 1
        ? null
        : ({
            columns: [
              { text: clip(safe(doc.title), 90), fontSize: 7, color: MUTED },
              { text: typeLabel.toUpperCase(), fontSize: 6.5, bold: true, color: BRAND_DEEP, characterSpacing: 0.9, alignment: 'right', width: 'auto' },
            ],
            margin: [MX, 22, MX, 0],
          } as Content),
    footer: (page: number, total: number) => ({
      stack: [
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: W, y2: 0, lineWidth: 0.6, lineColor: LINE }] },
        {
          columns: [
            { text: signoff, fontSize: 7, color: TEXT, margin: [0, 6, 0, 0] },
            { text: `${page} / ${total}`, fontSize: 7, color: MUTED, alignment: 'right', width: 40, margin: [0, 6, 0, 0] },
          ],
        },
        { text: `SupOps · ${typeLabel} · generated ${fmtUtc(new Date())}`, fontSize: 6.3, color: FAINT, margin: [0, 2, 0, 0] },
      ],
      margin: [MX, 14, MX, 0],
    }) as Content,
  };
}

/** The footer line: every approver once, with the time of their last decision. */
function footerApprovals(ledger: ReturnType<typeof approvalLedger>): ContentText['text'] {
  if (!ledger.length) return [{ text: 'No approvals needed', bold: true, color: INK }, { text: ' — every action ran within policy.' }];
  const part = (label: string, list: typeof ledger) =>
    list.length
      ? [
          { text: `${label} `, color: MUTED },
          ...list.flatMap((e, i) => [
            ...(i ? [{ text: ', ', color: MUTED }] : []),
            { text: e.name, bold: true, color: INK },
            ...(e.at ? [{ text: ` (${fmtShort(e.at)})`, color: MUTED }] : []),
          ]),
        ]
      : [];
  const approved = part('Approved by', ledger.filter((e) => e.approved));
  const rejected = part('Rejected by', ledger.filter((e) => e.rejected));
  return [...approved, ...(approved.length && rejected.length ? [{ text: '   ·   ', color: FAINT }] : []), ...rejected];
}
