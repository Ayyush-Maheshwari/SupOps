import { createHash } from 'node:crypto';
import type { AlertSeverity } from '@supops/shared';

export interface ParsedAlert {
  title: string;
  severity: AlertSeverity;
  status: 'firing' | 'resolved';
  summary: string | null;
  labels: Record<string, string>;
  /** Stable across repeats of the same alert in the same channel. */
  fingerprint: string;
}

/**
 * A Slack message, reduced to the fields we read. Alertmanager's Slack integration
 * posts through an incoming webhook, so the shape varies with whatever template the
 * operator configured -- most put the useful text in `attachments`, some use the
 * newer `blocks`, a few only set top-level `text`. We read all three, best-effort,
 * and always keep the raw event elsewhere so a miss here is recoverable later.
 */
export interface SlackMessage {
  channel?: string;
  text?: string;
  attachments?: Array<{
    color?: string;
    title?: string;
    title_link?: string;
    text?: string;
    fallback?: string;
    fields?: Array<{ title?: string; value?: string }>;
  }>;
  blocks?: Array<{ type?: string; text?: { text?: string }; fields?: Array<{ text?: string }> }>;
}

const SEVERITY_BY_COLOR: Record<string, AlertSeverity> = {
  danger: 'critical',
  '#ff0000': 'critical',
  warning: 'warning',
  '#ffa500': 'warning',
  good: 'info',
  '#36a64f': 'info',
};

const KNOWN_SEVERITIES: AlertSeverity[] = ['critical', 'warning', 'info'];

/** Map the many words templates use to our three tiers. */
function normalizeSeverity(raw: string | undefined): AlertSeverity | null {
  if (!raw) return null;
  const v = raw.toLowerCase().trim();
  if (/^(critical|crit|fatal|error|err|emergency|page|p1|sev1|high)$/.test(v)) return 'critical';
  if (/^(warning|warn|major|minor|p2|sev2|medium)$/.test(v)) return 'warning';
  if (/^(info|informational|notice|low|p3|p4|sev3|sev4)$/.test(v)) return 'info';
  return null;
}

/** Label keys, in order, that different templates use to carry severity. */
const SEVERITY_KEYS = ['severity', 'alert', 'level', 'priority', 'urgency', 'sev'];

/** Flatten every scrap of human-readable text in the message into one blob. */
function collectText(msg: SlackMessage): string {
  const parts: string[] = [];
  if (msg.text) parts.push(msg.text);
  for (const a of msg.attachments ?? []) {
    if (a.title) parts.push(a.title);
    if (a.text) parts.push(a.text);
    if (a.fallback) parts.push(a.fallback);
    for (const f of a.fields ?? []) {
      if (f.title || f.value) parts.push(`${f.title ?? ''} ${f.value ?? ''}`);
    }
  }
  for (const b of msg.blocks ?? []) {
    if (b.text?.text) parts.push(b.text.text);
    for (const f of b.fields ?? []) if (f.text) parts.push(f.text);
  }
  return parts.join('\n');
}

const clean = (v: string): string => v.trim().replace(/^[`"']|[`"']$/g, '');

/**
 * Labels come from two shapes, and real Alertmanager templates use both:
 *   1. Slack attachment/block *fields* -- structured `{ title, value }` pairs.
 *   2. `key = value` / `*key:* value` / `key: value` lines inside the text body.
 * We read the structured fields first (authoritative), then fill any gaps from the
 * text, so `alertname`, `instance`, `severity`, `job` etc. are captured whichever
 * way the template was written.
 */
function extractLabels(msg: SlackMessage, text: string): Record<string, string> {
  const labels: Record<string, string> = {};
  const put = (key: string, value: string) => {
    const k = key.toLowerCase().trim();
    const v = clean(value);
    if (k && v && !(k in labels)) labels[k] = v;
  };

  for (const a of msg.attachments ?? []) {
    for (const f of a.fields ?? []) if (f.title && f.value) put(f.title, f.value);
  }
  // Split on newlines AND bullet separators: many templates put every label on one
  // line as `… • *severity:* \`critical\` • *namespace:* \`x\``, so newline-splitting
  // alone leaves it all in one segment. Then strip Slack markdown (bold, code spans,
  // link/quote brackets) so `*severity:*` -> `severity:` before the key:value match.
  const line = /^([a-zA-Z][\w.-]*)\s*[:=]\s*(.+)$/;
  for (const seg of text.split(/[\n•·•·]+/)) {
    const stripped = seg
      .replace(/:[a-z0-9_'+-]+:/gi, '') // Slack emoji shortcodes like :warning:
      .replace(/[*_`<>]/g, '') // bold / code-span / link brackets
      .replace(/^[^A-Za-z]+/, '') // any leading punctuation/space up to the first letter
      .trim();
    const m = stripped.match(line);
    if (m) put(m[1]!, m[2]!);
  }
  return labels;
}

function firstMeaningfulLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[*_>`]/g, '').trim();
    if (line) return line;
  }
  return '';
}

export function parseAlertmanagerMessage(msg: SlackMessage, channelId: string): ParsedAlert {
  const text = collectText(msg);
  const lower = text.toLowerCase();
  const colors = (msg.attachments ?? []).map((a) => (a.color ?? '').toLowerCase());
  const labels = extractLabels(msg, text);

  const status: ParsedAlert['status'] =
    lower.includes('[resolved]') || lower.includes('resolved') || colors.includes('good')
      ? 'resolved'
      : 'firing';

  // Severity, most reliable source first:
  //  1. a known label key (severity/alert/level/priority/...), value normalised;
  //  2. the attachment colour (danger/warning/good);
  //  3. a last-resort scan for `severity|alert|priority: <word>` in the raw text,
  //     for templates whose label our line-parser could not isolate.
  let severity: AlertSeverity = 'unknown';
  for (const k of SEVERITY_KEYS) {
    const s = normalizeSeverity(labels[k]);
    if (s) { severity = s; break; }
  }
  if (severity === 'unknown') {
    for (const c of colors) {
      if (SEVERITY_BY_COLOR[c]) {
        severity = SEVERITY_BY_COLOR[c]!;
        break;
      }
    }
  }
  if (severity === 'unknown') {
    const m = lower.match(/\b(?:severity|alert|priority|level|urgency)\W{0,3}`?([a-z0-9]+)`?/);
    const s = normalizeSeverity(m?.[1]);
    if (s) severity = s;
  }

  const title =
    labels.alertname ||
    (msg.attachments ?? []).map((a) => a.title).find(Boolean)?.replace(/\[(FIRING|RESOLVED)[^\]]*\]/i, '').trim() ||
    firstMeaningfulLine(text) ||
    'Untitled alert';

  const titleLink = (msg.attachments ?? []).map((a) => a.title_link).find(Boolean);
  const summarySource =
    labels.summary ||
    labels.description ||
    (msg.attachments ?? []).map((a) => a.text).find(Boolean) ||
    (title !== firstMeaningfulLine(text) ? firstMeaningfulLine(text) : '');
  const summary = summarySource ? summarySource.trim().slice(0, 2000) : null;

  // The identity of the alert: same alertname on the same instance in the same
  // channel is the same alert, whether firing again or resolving.
  const instance = labels.instance || labels.host || labels.node || labels.hostname || '';
  const fingerprint = createHash('sha256')
    .update(`${title}|${instance}|${channelId}`)
    .digest('hex')
    .slice(0, 32);

  return {
    title: title.slice(0, 200),
    severity,
    status,
    summary,
    labels: titleLink ? { ...labels, _link: titleLink } : labels,
    fingerprint,
  };
}
