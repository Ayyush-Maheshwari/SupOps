import type { ChatMessage } from '@supops/shared';
import { messageText } from '@supops/shared';

/**
 * What a call leaves behind. A live call (an engineer on a screen-share with a client
 * who gives no access) produces two documents:
 *
 *  - a client report: plain language for the client -- the issue, what was checked,
 *    the cause, what was done, what to do next. No approvals ledger, no model, no
 *    token counts, no internal tool trail;
 *  - a runbook draft for the team's Knowledge, so the next call like it starts from
 *    what this one learned (and documents stop going stale).
 *
 * Both are written by the model from the call transcript, and both fall back to a
 * mechanical version when the model is unavailable, so a call always ends with a
 * document.
 */

export type ClientReportStatus = 'resolved' | 'mitigated' | 'open';

export interface ClientReport {
  title: string;
  status: ClientReportStatus;
  summary: string;
  issue: string;
  checks: string[];
  cause: string;
  actions: string[];
  recommendations: string[];
  followUps: string[];
  /**
   * The screenshots worth showing the client, by their number in the transcript, with a
   * plain caption. A call can take dozens of captures; the report keeps only the few that
   * show the problem, the key finding and the fixed state, most important first. `null`
   * when the model gave no choice, so the caller falls back to a mechanical pick.
   */
  screenshots: ReportScreenshot[] | null;
}

export interface ReportScreenshot {
  n: number;
  caption: string;
}

/** At most this many screenshots go into a client report. */
export const MAX_REPORT_SCREENSHOTS = 4;

export interface CallMeta {
  projectName: string;
  engineer: string | null;
  startedAt: Date;
  endedAt: Date | null;
}

export const CLIENT_STATUS_LABEL: Record<ClientReportStatus, string> = {
  resolved: 'Resolved',
  mitigated: 'Mitigated, follow-up needed',
  open: 'Still open',
};

/**
 * The screenshots of a call in transcript order: `[screenshot n]` in the transcript is
 * `list[n - 1]`. Each is the image's URL (an attachment reference or a data URL).
 */
export function callScreenshots(steps: Array<{ messageJson: ChatMessage }>): string[] {
  const out: string[] = [];
  for (const s of steps) {
    const m = s.messageJson;
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    for (const p of m.content) if (p.type === 'image_url') out.push(p.image_url.url);
  }
  return out;
}

/**
 * Which screenshots to show when the model did not choose: all of a few, otherwise the
 * first (how it looked) and the last (how it was left).
 */
export function fallbackScreenshots(total: number): ReportScreenshot[] {
  if (total <= 0) return [];
  if (total <= 2) return Array.from({ length: total }, (_, i) => ({ n: i + 1, caption: '' }));
  return [
    { n: 1, caption: 'At the start of the call' },
    { n: total, caption: 'At the end of the call' },
  ];
}

/** The call as a readable transcript for the model: who said what, screenshots as markers. */
export function buildCallTranscript(steps: Array<{ messageJson: ChatMessage }>, maxChars = 40_000): string {
  const lines: string[] = [];
  let shot = 0;
  for (const s of steps) {
    const m = s.messageJson;
    if (m.role === 'system' || m.role === 'tool') continue;
    const parts = Array.isArray(m.content) ? m.content : [];
    const images = parts.filter((p) => p.type === 'image_url').length;
    const text = messageText(m.content).trim();
    if (m.role === 'user') {
      const marks = Array.from({ length: images }, () => `[screenshot ${++shot}]`).join(' ');
      lines.push(`ENGINEER: ${[text, marks].filter(Boolean).join(' ')}`);
    } else if (text) {
      lines.push(`SUPOPS: ${text}`);
    }
  }
  const all = lines.join('\n\n');
  // The end of a call (the fix and the recap) matters most: keep it whole when trimming.
  return all.length <= maxChars ? all : `[earlier part of the call omitted]\n\n${all.slice(all.length - maxChars)}`;
}

export const CLIENT_REPORT_PROMPT = `You write the report a support engineer sends a client after a troubleshooting call. You are given the call transcript: the ENGINEER relays what the client's screen showed (pasted output, screenshots) and SUPOPS is the assistant that suggested checks and fixes.

Write for the client: clear, factual, no blame, no internal jargon, no mention of SupOps, AI, models or tools. Use only what the transcript shows; if something was not established, say so plainly. Never invent hostnames, numbers or actions.

Return ONLY JSON:
{"title":"Disk space exhausted on web-1","status":"resolved","summary":"Two sentences: what happened and where it stands now.","issue":"What the client experienced and when, in one or two sentences.","checks":["What was checked and what it showed, one line each"],"cause":"The root cause in one or two plain sentences, or 'Not yet confirmed: <what is missing>'.","actions":["What was done during the call, by whom, one line each"],"recommendations":["What the client should do to prevent it, one line each"],"followUps":["Anything still open, with an owner if known"],"screenshots":[{"n":3,"caption":"Disk usage before the cleanup: / at 97%"}]}

status is one of: resolved (fixed and verified), mitigated (working again but the cause needs follow-up), open (not fixed).

screenshots: the transcript marks each screenshot as [screenshot n]. Pick at most ${MAX_REPORT_SCREENSHOTS}, most important first, that a client needs to see: the error or symptom, the finding that showed the cause, and the fixed state. Skip near-duplicates, setup screens and anything unrelated or showing secrets. Each caption is one plain sentence on what it shows. Use [] when none are worth including.`;

const str = (v: unknown, max = 600): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max = 12): string[] => (Array.isArray(v) ? v.map((x) => str(x, 400)).filter(Boolean).slice(0, max) : []);

/** The model's report, checked; a mechanical one when there is nothing usable. */
export function parseClientReport(raw: string | null, fallbackTitle: string): ClientReport {
  const json = raw?.match(/\{[\s\S]*\}/)?.[0];
  let o: Record<string, unknown> = {};
  try {
    if (json) o = JSON.parse(json) as Record<string, unknown>;
  } catch {
    o = {};
  }
  const status = ['resolved', 'mitigated', 'open'].includes(String(o.status)) ? (o.status as ClientReportStatus) : 'open';
  const report: ClientReport = {
    title: str(o.title, 140) || fallbackTitle,
    status,
    summary: str(o.summary),
    issue: str(o.issue),
    checks: list(o.checks),
    cause: str(o.cause),
    actions: list(o.actions),
    recommendations: list(o.recommendations),
    followUps: list(o.followUps),
    screenshots: Array.isArray(o.screenshots) ? pickScreenshots(o.screenshots) : null,
  };
  if (!report.summary && !report.issue && !report.checks.length) {
    report.summary = 'The details of this call could not be summarised automatically. The engineer will follow up with a written summary.';
  }
  return report;
}

function pickScreenshots(raw: unknown[]): ReportScreenshot[] {
  const out: ReportScreenshot[] = [];
  for (const x of raw) {
    const o = (x && typeof x === 'object' ? x : { n: x }) as Record<string, unknown>;
    const n = Number(o.n);
    if (!Number.isInteger(n) || n < 1 || out.some((s) => s.n === n)) continue;
    out.push({ n, caption: str(o.caption, 200) });
    if (out.length === 12) break;
  }
  return out;
}

/**
 * The screenshots a report shows, checked against how many the call has: the model's
 * choice (numbers it invented dropped), or the fallback when it gave none.
 */
export function reportScreenshots(r: ClientReport, total: number): ReportScreenshot[] {
  if (!r.screenshots) return fallbackScreenshots(total);
  // The model lists the most important first: cap in that order, then show in call order.
  return r.screenshots
    .filter((s) => s.n <= total)
    .slice(0, MAX_REPORT_SCREENSHOTS)
    .sort((a, b) => a.n - b.n);
}

const fmt = (d: Date): string => d.toISOString().replace('T', ' ').slice(0, 16) + ' UTC';

export function callDuration(meta: CallMeta): string {
  if (!meta.endedAt) return '';
  const mins = Math.max(1, Math.round((meta.endedAt.getTime() - meta.startedAt.getTime()) / 60_000));
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h ${mins % 60} min`;
}

export function buildClientReportMarkdown(r: ClientReport, meta: CallMeta): string {
  const out: string[] = [`# ${r.title}`, ''];
  const facts = [meta.projectName, fmt(meta.startedAt), callDuration(meta), meta.engineer ? `Engineer: ${meta.engineer}` : ''].filter(Boolean);
  out.push(`**Status:** ${CLIENT_STATUS_LABEL[r.status]}  `, facts.join(' · '), '');
  if (r.summary) out.push('## Summary', '', r.summary, '');
  if (r.issue) out.push('## The issue', '', r.issue, '');
  const section = (title: string, items: string[]) => {
    if (items.length) out.push(`## ${title}`, '', ...items.map((i) => `- ${i}`), '');
  };
  section('What we checked', r.checks);
  if (r.cause) out.push('## Cause', '', r.cause, '');
  section('What was done', r.actions);
  section('Recommendations', r.recommendations);
  section('Follow-up', r.followUps);
  return `${out.join('\n').trim()}\n`;
}

// ---- runbook from a call -------------------------------------------------------

export interface RunbookDraft {
  title: string;
  slug: string;
  body: string;
}

export const RUNBOOK_FROM_CALL_PROMPT = `You turn a troubleshooting call into a runbook for the support team, so the next engineer facing the same symptoms resolves it faster. You are given the call transcript.

Write only what the call established. Generalise host names to placeholders like <web-host> unless the runbook is clearly about one named system. Keep commands exactly as they were used.

Return ONLY JSON:
{"title":"Disk full on web servers","slug":"disk-full-web","body":"Markdown with these sections: ## Symptoms, ## Checks (each command in a bash block with what to look for), ## Likely causes, ## Fix (with verification and rollback), ## Prevention"}`;

const slugify = (s: string): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'call-runbook';

export function parseRunbookDraft(raw: string | null, fallbackTitle: string, transcript: string): RunbookDraft {
  const json = raw?.match(/\{[\s\S]*\}/)?.[0];
  let o: Record<string, unknown> = {};
  try {
    if (json) o = JSON.parse(json) as Record<string, unknown>;
  } catch {
    o = {};
  }
  const title = str(o.title, 160) || fallbackTitle;
  const body = str(o.body, 30_000) || `## What happened on the call\n\n${transcript.slice(0, 8000)}`;
  return { title, slug: slugify(str(o.slug, 80) || title), body };
}
