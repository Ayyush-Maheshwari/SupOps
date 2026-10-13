import type { Content, ContentText, TDocumentDefinitions } from 'pdfmake/interfaces';
import { CLIENT_STATUS_LABEL, callDuration } from '../client-report.ts';
import type { CallMeta, ClientReport, ClientReportStatus } from '../client-report.ts';

/**
 * The client report as a PDF: the same look as the run reports, without the internal
 * parts (approvals, model, tokens, the command appendix). Screenshots from the call
 * are kept, as the client's own evidence, but only the few chosen for the report.
 */

const INK = '#0F172A';
const TEXT = '#334155';
const MUTED = '#64748B';
const FAINT = '#94A3B8';
const LINE = '#E2E8F0';
const PANEL = '#F5F7FB';
const BRAND = '#0A84FF';
const BRAND_DEEP = '#0B4FA8';
const PAGE_W = 595.28;
const MX = 44;
const W = PAGE_W - MX * 2;

const STATUS_COLOR: Record<ClientReportStatus, { fg: string; bg: string }> = {
  resolved: { fg: '#047857', bg: '#D1FAE5' },
  mitigated: { fg: '#B45309', bg: '#FEF3C7' },
  open: { fg: '#B91C1C', bg: '#FEE2E2' },
};

const safe = (s: string): string => s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '');
const fmt = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

function heading(title: string): Content {
  return {
    stack: [
      { text: title.toUpperCase(), bold: true, fontSize: 8, color: BRAND_DEEP, characterSpacing: 1.1 },
      { canvas: [{ type: 'line', x1: 0, y1: 3, x2: W, y2: 3, lineWidth: 0.6, lineColor: LINE }] },
    ],
    margin: [0, 14, 0, 6],
    headlineLevel: 1,
  } as unknown as Content;
}

const para = (text: string): Content => ({ text: safe(text), fontSize: 10, color: INK, lineHeight: 1.35 }) as Content;

function bullets(items: string[]): Content {
  return { ul: items.map((i) => ({ text: safe(i), fontSize: 9.5, color: INK, lineHeight: 1.3, margin: [0, 0, 0, 3] })), markerColor: BRAND } as unknown as Content;
}

/**
 * `images` are the screenshots chosen for the report (see reportScreenshots), each with
 * its number in the call; `totalShots` is how many the call took, so the reader knows
 * these are a selection.
 */
export function buildClientPdfDefinition(
  r: ClientReport,
  meta: CallMeta,
  images: Array<{ dataUrl: string; n?: number; caption?: string }> = [],
  totalShots = images.length,
): TDocumentDefinitions {
  const status = STATUS_COLOR[r.status];
  const facts = [meta.projectName, fmt(meta.startedAt), callDuration(meta), meta.engineer ? `Engineer: ${meta.engineer}` : ''].filter(Boolean);
  const content: Content[] = [];

  content.push({
    table: {
      widths: [PAGE_W],
      body: [[{
        stack: [
          { canvas: [{ type: 'rect', x: 0, y: 0, w: PAGE_W, h: 4, color: BRAND }] },
          {
            // Sent to the client by your team: their name, not a vendor's logo.
            columns: [
              { text: safe(meta.projectName), bold: true, fontSize: 11, color: INK },
              { text: 'SUPPORT CALL REPORT', bold: true, fontSize: 7.5, color: BRAND_DEEP, characterSpacing: 1.2, alignment: 'right', margin: [0, 2, 0, 0] },
            ],
            margin: [MX, 18, MX, 0],
          },
          { text: safe(r.title), font: 'Display', bold: true, fontSize: 20, color: INK, lineHeight: 1.12, margin: [MX, 16, MX, 0] },
          ...(r.summary ? [{ text: safe(r.summary), fontSize: 10.5, color: TEXT, lineHeight: 1.35, margin: [MX, 6, MX, 0] }] : []),
          {
            columns: [
              {
                table: { body: [[{ text: CLIENT_STATUS_LABEL[r.status].toUpperCase(), bold: true, fontSize: 7.5, color: status.fg, fillColor: status.bg, margin: [6, 2, 6, 2] }]] },
                layout: 'noBorders',
                width: 'auto',
              },
              { text: facts.join('   ·   '), fontSize: 7.5, color: MUTED, margin: [10, 3, 0, 0] },
            ],
            margin: [MX, 12, MX, 20],
          },
        ],
        fillColor: PANEL,
        border: [false, false, false, false],
      }]],
    },
    layout: { defaultBorder: false, paddingLeft: () => 0, paddingRight: () => 0, paddingTop: () => 0, paddingBottom: () => 0 },
    margin: [-MX, -48, -MX, 6],
  } as unknown as Content);

  if (r.issue) content.push(heading('The issue'), para(r.issue));
  if (r.checks.length) content.push(heading('What we checked'), bullets(r.checks));
  if (r.cause) content.push(heading('Cause'), para(r.cause));
  if (r.actions.length) content.push(heading('What was done'), bullets(r.actions));
  if (r.recommendations.length) content.push(heading('Recommendations'), bullets(r.recommendations));
  if (r.followUps.length) content.push(heading('Follow-up'), bullets(r.followUps));

  if (images.length) {
    images.forEach((img, i) => {
      // The heading travels with the first screenshot, so it never sits alone at a page foot.
      content.push({
        stack: [
          ...(i === 0 ? [heading('Screens from the call')] : []),
          ...(i === 0 && totalShots > images.length
            ? [{ text: `${images.length} of the ${totalShots} screenshots taken during the call.`, fontSize: 8, color: MUTED, margin: [0, 0, 0, 6] }]
            : []),
          { image: img.dataUrl, fit: [W, 320], alignment: 'center' },
          {
            text: [
              { text: `Screenshot ${img.n ?? i + 1}`, bold: true, color: TEXT },
              ...(img.caption ? [{ text: `  ·  ${safe(img.caption)}` }] : []),
            ],
            fontSize: 8,
            color: MUTED,
            alignment: 'center',
            margin: [0, 4, 0, 0],
          },
        ],
        margin: [0, 2, 0, 10],
        unbreakable: true,
      } as unknown as Content);
    });
  }

  return {
    pageSize: 'A4',
    pageMargins: [MX, 48, MX, 50],
    defaultStyle: { font: 'Inter', fontSize: 9, color: TEXT, lineHeight: 1.2 },
    info: { title: r.title, author: meta.engineer ?? 'Support', subject: `Support call · ${meta.projectName}` },
    pageBreakBefore: (node) => {
      const n = node as { headlineLevel?: number; startPosition?: { verticalRatio?: number } };
      return n.headlineLevel === 1 && (n.startPosition?.verticalRatio ?? 0) > 0.85;
    },
    content,
    footer: (page: number, total: number) => ({
      stack: [
        { canvas: [{ type: 'line', x1: 0, y1: 0, x2: W, y2: 0, lineWidth: 0.6, lineColor: LINE }] },
        {
          columns: [
            { text: `${safe(meta.projectName)} · support call report`, fontSize: 7, color: FAINT, margin: [0, 6, 0, 0] } as ContentText,
            { text: `${page} / ${total}`, fontSize: 7, color: MUTED, alignment: 'right', width: 40, margin: [0, 6, 0, 0] },
          ],
        },
      ],
      margin: [MX, 14, MX, 0],
    }) as Content,
  };
}
