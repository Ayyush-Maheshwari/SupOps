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
    // The fallback is a plain-text copy of the rest; reading both doubles every label.
    if (a.fallback && !a.text && !a.fields?.length) parts.push(a.fallback);
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
  return extractLabelBlocks(msg, text).merged;
}

/**
 * Keys that identify one alert. When one of them repeats inside a message, the
 * message is a grouped notification (`[FIRING:3] ...`) listing several alerts, and a
 * new alert's labels start there.
 */
const IDENTITY_KEYS = new Set(['alertname', 'instance', 'host', 'hostname', 'node', 'pod']);

/**
 * Labels per alert in the message, plus every label merged (first value wins). A
 * message about one alert has one block; a grouped notification has one per alert.
 */
function extractLabelBlocks(msg: SlackMessage, text: string): { blocks: Array<Record<string, string>>; merged: Record<string, string> } {
  const merged: Record<string, string> = {};
  const blocks: Array<Record<string, string>> = [{}];
  const put = (key: string, value: string, split: boolean) => {
    const k = key.toLowerCase().trim();
    const v = clean(value);
    if (!k || !v) return;
    if (!(k in merged)) merged[k] = v;
    let cur = blocks[blocks.length - 1]!;
    if (split && k in cur && cur[k] !== v && IDENTITY_KEYS.has(k)) {
      cur = {};
      blocks.push(cur);
    }
    if (!(k in cur)) cur[k] = v;
  };

  for (const a of msg.attachments ?? []) {
    for (const f of a.fields ?? []) if (f.title && f.value) put(f.title, f.value, false);
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
    if (m) put(m[1]!, m[2]!, true);
  }
  return { blocks: blocks.filter((b) => Object.keys(b).length), merged };
}

function firstMeaningfulLine(text: string): string {
  for (const raw of text.split('\n')) {
    const line = raw.replace(/[*_>`]/g, '').trim();
    if (line) return line;
  }
  return '';
}

/**
 * Status from what Alertmanager's templates actually mark it with: the
 * `[RESOLVED]`/`[FIRING:n]` tag, a `status` label, or the attachment colour. Never
 * from the word "resolved" anywhere in the text -- "host could not be resolved" is a
 * firing alert.
 */
function alertStatus(text: string, labels: Record<string, string>, colors: string[]): ParsedAlert['status'] {
  if (/\[\s*resolved\b/i.test(text)) return 'resolved';
  if (/\[\s*firing\b/i.test(text)) return 'firing';
  const st = (labels.status ?? '').toLowerCase();
  if (st === 'resolved') return 'resolved';
  if (st === 'firing') return 'firing';
  return colors.includes('good') ? 'resolved' : 'firing';
}

/**
 * Every alert in a Slack message. Usually one; a grouped Alertmanager notification
 * (`[FIRING:3] HighCPU`) lists several, and each becomes its own alert so each
 * machine is matched and tracked separately.
 */
export function parseAlertmanagerMessages(msg: SlackMessage, channelId: string): ParsedAlert[] {
  const base = parseAlertmanagerMessage(msg, channelId);
  const text = collectText(msg);
  const { blocks, merged } = extractLabelBlocks(msg, text);
  const ident = (b: Record<string, string>) => [b.alertname ?? '', b.instance || b.host || b.node || b.hostname || '', b.pod ?? ''].join('|');
  const distinct = new Map<string, Record<string, string>>();
  for (const b of blocks) {
    const full = { ...merged, ...b };
    if (!distinct.has(ident(full))) distinct.set(ident(full), full);
  }
  if (distinct.size <= 1) return [base];
  return [...distinct.values()].map((labels) => {
    const title = labels.alertname || base.title;
    const instance = labels.instance || labels.host || labels.node || labels.hostname || '';
    const severity = SEVERITY_KEYS.map((k) => normalizeSeverity(labels[k])).find(Boolean) ?? base.severity;
    return {
      ...base,
      title: title.slice(0, 200),
      severity,
      summary: (labels.summary || labels.description || base.summary || '').slice(0, 2000) || null,
      labels: base.labels._link ? { ...labels, _link: base.labels._link } : labels,
      fingerprint: createHash('sha256').update(`${title}|${instance}|${channelId}`).digest('hex').slice(0, 32),
    };
  });
}

export function parseAlertmanagerMessage(msg: SlackMessage, channelId: string): ParsedAlert {
  const text = collectText(msg);
  const lower = text.toLowerCase();
  const colors = (msg.attachments ?? []).map((a) => (a.color ?? '').toLowerCase());
  const labels = extractLabels(msg, text);

  const status = alertStatus(text, labels, colors);

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
