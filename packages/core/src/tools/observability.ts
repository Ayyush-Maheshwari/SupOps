import { z } from 'zod';
import type { RiskContribution } from '@supops/shared';
import type { ObservabilityAuth, ObservabilityConfig } from '@supops/db';
import type { ExecContext, ResolvedTarget, ToolDef } from './types.ts';
import { errOutput, okOutput, truncateOutput } from './output.ts';
import { safeGet } from './executors/http.ts';

/**
 * Read-only query tools for observability backends: metrics (Prometheus), logs
 * (Loki, Elasticsearch/OpenSearch) and alerts (Alertmanager). Each builds a fixed API
 * request -- no free-form paths -- caps the time window and the size of the answer,
 * and condenses the response so the agent sees numbers, not pages of JSON.
 */

const READ: RiskContribution[] = [
  { stage: 'arguments', tier: 'read_only', ruleId: 'observability.query', reason: 'a read-only query against an observability API' },
];

const obsConfig = (t: ResolvedTarget) => t.config as unknown as ObservabilityConfig;

function authHeaders(target: ResolvedTarget): Record<string, string> {
  const headers: Record<string, string> = {};
  const cfg = obsConfig(target);
  if (cfg.kind === 'loki' && cfg.tenantId) headers['X-Scope-OrgID'] = cfg.tenantId;
  if (!target.secret) return headers;
  let auth: ObservabilityAuth;
  try {
    auth = JSON.parse(target.secret) as ObservabilityAuth;
  } catch {
    auth = { type: 'bearer', token: target.secret };
  }
  if (auth.type === 'bearer') headers.authorization = `Bearer ${auth.token}`;
  if (auth.type === 'basic') headers.authorization = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`;
  return headers;
}

/** `now`, `now-1h`, `now-30m`, RFC3339 or unix seconds -> epoch ms. */
export function parseTime(v: string | undefined, now = Date.now()): number | null {
  if (!v || v === 'now') return now;
  const rel = /^now-(\d+)([smhd])$/.exec(v.trim());
  if (rel) return now - Number(rel[1]) * { s: 1e3, m: 6e4, h: 3.6e6, d: 8.64e7 }[rel[2] as 's']!;
  if (/^\d{9,10}(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000);
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** Resolve and cap a window. Returns an error message when the window is unusable. */
type Window = { error: string } | { start: number; end: number };
type CallResult = { error: string } | { json: unknown; truncated: boolean };

export function timeWindow(start: string | undefined, end: string | undefined, defaultStart: string, maxHours: number, now = Date.now()): Window {
  const e = parseTime(end, now);
  const s = parseTime(start ?? defaultStart, now);
  if (e === null || s === null) return { error: 'start/end must be "now", "now-1h" style, RFC3339 or unix seconds' };
  if (s >= e) return { error: 'start must be before end' };
  if (e - s > maxHours * 3.6e6) return { error: `the window may be at most ${maxHours}h for this connection; narrow start/end` };
  return { start: s, end: e };
}

async function call(ctx: ExecContext, path: string, query: Record<string, string | number | undefined>, jsonBody?: unknown, method?: 'GET' | 'POST' | 'DELETE' | 'PUT'): Promise<CallResult> {
  const cfg = obsConfig(ctx.target);
  // Grafana: Prometheus API paths go through the datasource proxy for one datasource.
  if (cfg.kind === 'grafana') {
    if (!cfg.datasourceUid || !/^[A-Za-z0-9_-]+$/.test(cfg.datasourceUid)) return { error: 'this Grafana connection has no valid Prometheus datasource uid' };
    path = `/api/datasources/proxy/uid/${cfg.datasourceUid}${path}`;
  }
  try {
    const r = await safeGet({
      baseUrl: cfg.baseUrl,
      path,
      query,
      headers: authHeaders(ctx.target),
      allowPrivateNetwork: cfg.allowPrivateNetwork,
      insecureSkipVerify: cfg.insecureSkipVerify,
      timeoutMs: ctx.timeoutMs,
      maxBytes: 4 * 1024 * 1024,
      signal: ctx.signal,
      jsonBody,
      ...(method ? { method } : {}),
    });
    if (r.status >= 400) return { error: `HTTP ${r.status}: ${r.body.slice(0, 500)}` };
    try {
      return { json: JSON.parse(r.body) as unknown, truncated: r.truncated };
    } catch {
      return { error: `the backend did not return JSON${r.truncated ? ' (response too large)' : ''}` };
    }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

const done = (ctx: ExecContext, text: string) => {
  const t = truncateOutput(text, ctx.maxOutputBytes);
  return okOutput(t.text, { truncated: t.truncated, originalBytes: t.originalBytes });
};

const labelsOf = (m: Record<string, string>) =>
  `{${Object.entries(m).filter(([k]) => k !== '__name__').map(([k, v]) => `${k}="${v}"`).join(', ')}}`;
const num = (v: string) => (Number.isFinite(Number(v)) ? Number(Number(v).toPrecision(6)) : v);

/** Prometheus result -> one line per series: labels and the numbers that matter. */
export function condensePrometheus(data: { resultType?: string; result?: unknown }, limit: number): string {
  const rows = Array.isArray(data.result) ? data.result : [];
  const out: string[] = [];
  if (data.resultType === 'vector') {
    for (const r of rows.slice(0, limit) as Array<{ metric: Record<string, string>; value: [number, string] }>) {
      out.push(`${r.metric.__name__ ?? ''}${labelsOf(r.metric)} = ${num(r.value[1])}`);
    }
  } else if (data.resultType === 'matrix') {
    for (const r of rows.slice(0, limit) as Array<{ metric: Record<string, string>; values: Array<[number, string]> }>) {
      const vals = r.values.map((v) => Number(v[1])).filter(Number.isFinite);
      const first = r.values[0]?.[1];
      const last = r.values[r.values.length - 1]?.[1];
      out.push(
        `${r.metric.__name__ ?? ''}${labelsOf(r.metric)}: ${r.values.length} points, first ${first === undefined ? '-' : num(first)}, ` +
          `last ${last === undefined ? '-' : num(last)}, min ${vals.length ? num(String(Math.min(...vals))) : '-'}, max ${vals.length ? num(String(Math.max(...vals))) : '-'}`,
      );
    }
  } else if (data.resultType === 'scalar' || data.resultType === 'string') {
    out.push(`${data.resultType}: ${JSON.stringify(data.result)}`);
  }
  if (rows.length > limit) out.push(`... ${rows.length - limit} more series (narrow the query or raise limit_series)`);
  return out.length ? out.join('\n') : '(no series matched)';
}

// ---- query_metrics -----------------------------------------------------------

const metricsArgs = z.object({
  target: z.string(),
  operation: z.enum(['instant', 'range', 'series', 'labels', 'label_values', 'targets', 'rules', 'alerts']),
  query: z.string().max(2000).optional(),
  label: z.string().max(200).regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  start: z.string().max(40).optional(),
  end: z.string().max(40).optional(),
  step: z.string().max(10).regex(/^\d+[smh]?$/).optional(),
  limit_series: z.number().int().min(1).max(200).optional(),
});

export const queryMetricsTool: ToolDef<z.infer<typeof metricsArgs>> = {
  key: 'query_metrics',
  kind: 'http',
  description:
    'Query a Prometheus-compatible metrics backend (read-only). operation: instant (PromQL at a time), ' +
    'range (PromQL over start..end; result is summarised per series as first/last/min/max), series, labels, ' +
    'label_values (needs label), targets (scrape health), rules, alerts (firing/pending). Times accept ' +
    '"now", "now-1h", RFC3339 or unix seconds. Prefer rate()/increase() over raw counters and aggregate with sum by (...).',
  parameters: {
    operation: { type: 'string', enum: ['instant', 'range', 'series', 'labels', 'label_values', 'targets', 'rules', 'alerts'], description: 'What to fetch.' },
    query: { type: 'string', description: 'PromQL (instant/range), or a series selector (series).' },
    label: { type: 'string', description: 'Label name for label_values.' },
    start: { type: 'string', description: 'Range start, default now-1h.' },
    end: { type: 'string', description: 'Range end, default now.' },
    step: { type: 'string', description: 'Range step, e.g. 60s; chosen automatically if omitted.' },
    limit_series: { type: 'integer', description: 'Most series to return (default 50, max 200).' },
  },
  required: ['operation'],
  argsSchema: metricsArgs,
  baselineRisk: 'read_only',
  targetKinds: ['prometheus', 'grafana'],
  mutating: false,
  timeoutMs: 30_000,
  render: (a, t) => `[${t.slug}] ${a.operation}${a.query ? ` ${a.query}` : ''}${a.label ? ` ${a.label}` : ''}${a.operation === 'range' ? ` · ${a.start ?? 'now-1h'} → ${a.end ?? 'now'}` : ''}`,
  classifyArgs: () => READ,
  execute: async (a, ctx) => {
    const cfg = obsConfig(ctx.target);
    const limit = a.limit_series ?? 50;
    if ((a.operation === 'instant' || a.operation === 'range' || a.operation === 'series') && !a.query) {
      return errOutput(`operation "${a.operation}" needs a query`);
    }
    if (a.operation === 'label_values' && !a.label) return errOutput('label_values needs a label');

    if (a.operation === 'range') {
      const w = timeWindow(a.start, a.end, 'now-1h', cfg.maxRangeHours ?? 168);
      if ('error' in w) return errOutput(w.error);
      // At most ~11,000 points per series (Prometheus' own limit).
      const minStep = Math.max(15, Math.ceil((w.end - w.start) / 1000 / 11_000));
      const r = await call(ctx, '/api/v1/query_range', { query: a.query, start: w.start / 1000, end: w.end / 1000, step: a.step ?? `${minStep}s` });
      if ('error' in r) return errOutput(r.error);
      return done(ctx, condensePrometheus((r.json as { data: never }).data ?? {}, limit));
    }
    if (a.operation === 'instant') {
      const at = parseTime(a.end);
      const r = await call(ctx, '/api/v1/query', { query: a.query, ...(a.end && at ? { time: at / 1000 } : {}) });
      if ('error' in r) return errOutput(r.error);
      return done(ctx, condensePrometheus((r.json as { data: never }).data ?? {}, limit));
    }
    const path =
      a.operation === 'series' ? '/api/v1/series'
      : a.operation === 'labels' ? '/api/v1/labels'
      : a.operation === 'label_values' ? `/api/v1/label/${a.label}/values`
      : a.operation === 'targets' ? '/api/v1/targets'
      : a.operation === 'rules' ? '/api/v1/rules'
      : '/api/v1/alerts';
    const r = await call(ctx, path, a.operation === 'series' ? { 'match[]': a.query } : a.operation === 'targets' ? { state: 'active' } : {});
    if ('error' in r) return errOutput(r.error);
    const data = (r.json as { data?: unknown }).data;
    if (a.operation === 'targets') {
      const ts = ((data as { activeTargets?: Array<{ labels: Record<string, string>; health: string; lastError?: string }> })?.activeTargets ?? []);
      const down = ts.filter((t) => t.health !== 'up');
      return done(ctx, `${ts.length} targets, ${down.length} not up` + (down.length ? `\n${down.slice(0, limit).map((t) => `${labelsOf(t.labels)}: ${t.health}${t.lastError ? ` -- ${t.lastError}` : ''}`).join('\n')}` : ''));
    }
    return done(ctx, JSON.stringify(data, null, 1).slice(0, ctx.maxOutputBytes * 2));
  },
};

// ---- query_logs ----------------------------------------------------------------

const logsArgs = z.object({
  target: z.string(),
  query: z.string().min(1).max(2000),
  index: z.string().max(200).optional(),
  start: z.string().max(40).optional(),
  end: z.string().max(40).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

/** Does an index name match one of the allowed patterns (globs with *)? Empty list allows any. */
export function indexAllowed(index: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return true;
  return patterns.some((p) => new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(index));
}

export const queryLogsTool: ToolDef<z.infer<typeof logsArgs>> = {
  key: 'query_logs',
  kind: 'http',
  description:
    'Search logs (read-only). Loki: query is LogQL, e.g. {app="api"} |= "error". Elasticsearch/OpenSearch: ' +
    'query is Lucene query_string syntax, e.g. level:error AND service:api, and index names the index pattern. ' +
    'Default window is the last 15 minutes; newest lines first; at most 500 lines.',
  parameters: {
    query: { type: 'string', description: 'LogQL (Loki) or query_string (Elasticsearch).' },
    index: { type: 'string', description: 'Elasticsearch index or pattern, e.g. logs-*.' },
    start: { type: 'string', description: 'Default now-15m.' },
    end: { type: 'string', description: 'Default now.' },
    limit: { type: 'integer', description: 'Most lines (default 100, max 500).' },
  },
  required: ['query'],
  argsSchema: logsArgs,
  baselineRisk: 'read_only',
  targetKinds: ['loki', 'elasticsearch'],
  mutating: false,
  timeoutMs: 30_000,
  render: (a, t) => `[${t.slug}] ${a.index ? `${a.index}: ` : ''}${a.query} · ${a.start ?? 'now-15m'} → ${a.end ?? 'now'} · limit ${a.limit ?? 100}`,
  classifyArgs: () => READ,
  execute: async (a, ctx) => {
    const cfg = obsConfig(ctx.target);
    const w = timeWindow(a.start, a.end, 'now-15m', cfg.maxRangeHours ?? 24);
    if ('error' in w) return errOutput(w.error);
    const limit = a.limit ?? 100;

    if (cfg.kind === 'loki') {
      const r = await call(ctx, '/loki/api/v1/query_range', {
        query: a.query, start: `${w.start}000000`, end: `${w.end}000000`, limit, direction: 'backward',
      });
      if ('error' in r) return errOutput(r.error);
      const streams = ((r.json as { data?: { result?: Array<{ stream: Record<string, string>; values: Array<[string, string]> }> } }).data?.result ?? []);
      const lines = streams
        .flatMap((s) => s.values.map(([ts, line]) => ({ ts: Number(ts.slice(0, 13)), stream: s.stream, line })))
        .sort((x, y) => y.ts - x.ts)
        .slice(0, limit)
        .map((l) => `${new Date(l.ts).toISOString()} ${labelsOf(l.stream)} ${l.line.slice(0, 500)}`);
      return done(ctx, lines.length ? lines.join('\n') : '(no log lines matched)');
    }

    if (!a.index) return errOutput('Elasticsearch queries need an index (or index pattern)');
    if (!/^[A-Za-z0-9_.*,-]+$/.test(a.index) || !a.index.split(',').every((i) => indexAllowed(i, cfg.indices))) {
      return errOutput(`index "${a.index}" is not allowed on this connection${cfg.indices?.length ? ` (allowed: ${cfg.indices.join(', ')})` : ''}`);
    }
    const r = await call(ctx, `/${a.index}/_search`, {}, {
      size: limit,
      sort: [{ '@timestamp': { order: 'desc', unmapped_type: 'date' } }],
      query: {
        bool: {
          must: [{ query_string: { query: a.query } }],
          filter: [{ range: { '@timestamp': { gte: new Date(w.start).toISOString(), lte: new Date(w.end).toISOString() } } }],
        },
      },
    });
    if ('error' in r) return errOutput(r.error);
    const hits = ((r.json as { hits?: { total?: { value?: number }; hits?: Array<{ _index: string; _source: Record<string, unknown> }> } }).hits);
    const lines = (hits?.hits ?? []).map((h) => {
      const src = h._source;
      const msg = (src.message ?? src.msg ?? src.log ?? JSON.stringify(src)) as string;
      return `${src['@timestamp'] ?? ''} [${h._index}] ${String(msg).slice(0, 500)}`;
    });
    return done(ctx, `${hits?.total?.value ?? lines.length} matches${lines.length ? `\n${lines.join('\n')}` : ''}`);
  },
};

// ---- alerts ----------------------------------------------------------------------

const alertsArgs = z.object({
  target: z.string(),
  operation: z.enum(['list_alerts', 'list_silences', 'create_silence', 'expire_silence']),
  filter: z.string().max(500).optional(),
  /** create_silence: matchers like 'alertname="DiskFull",instance="db1"'. */
  matchers: z.string().max(1000).optional(),
  /** create_silence: how long to mute, e.g. 2h, 30m, 1d. */
  duration: z.string().max(10).regex(/^\d+[mhd]$/).optional(),
  /** create_silence: why (recorded on the silence). */
  comment: z.string().max(500).optional(),
  /** expire_silence: the silence id. */
  silence_id: z.string().max(100).optional(),
  intent: z.string().max(500).optional(),
  expected_effect: z.string().max(500).optional(),
});

/** Parse `name="v",other="w"` (or name=v) into Alertmanager matcher objects. */
export function parseMatchers(s: string): Array<{ name: string; value: string; isRegex: boolean; isEqual: boolean }> {
  const out: Array<{ name: string; value: string; isRegex: boolean; isEqual: boolean }> = [];
  for (const part of s.split(',')) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(=~|!=|!~|=)\s*"?([^"]*)"?\s*$/.exec(part);
    if (!m) continue;
    out.push({ name: m[1]!, value: m[3]!, isRegex: m[2]!.includes('~'), isEqual: !m[2]!.startsWith('!') });
  }
  return out;
}

const DURATION_MS: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
const durationMs = (d: string) => Number(d.slice(0, -1)) * DURATION_MS[d.slice(-1)]!;

/**
 * Silencing alerts hides problems, so it is gated. A silence that matches nothing
 * (so would mute every alert) or lasts over a day is refused outright; otherwise it
 * is medium (and prod raises it a tier, as for any change).
 */
function classifySilence(args: { operation: string; matchers?: string; duration?: string }): RiskContribution[] {
  if (args.operation !== 'create_silence' && args.operation !== 'expire_silence') return READ;
  if (args.operation === 'expire_silence') {
    return [{ stage: 'arguments', tier: 'low', ruleId: 'alerts.expire_silence', reason: 'ending a silence re-enables the alerts it muted', category: 'integrity' }];
  }
  const matchers = parseMatchers(args.matchers ?? '');
  if (!matchers.length || matchers.every((m) => m.value === '' && m.isRegex)) {
    return [{ stage: 'arguments', tier: 'forbidden', ruleId: 'alerts.silence.matchless', reason: 'a silence with no specific matcher would mute every alert', category: 'integrity' }];
  }
  if (args.duration && durationMs(args.duration) > 86_400_000) {
    return [{ stage: 'arguments', tier: 'forbidden', ruleId: 'alerts.silence.toolong', reason: 'a silence longer than 24h hides problems for too long; create a shorter one', category: 'integrity' }];
  }
  return [{ stage: 'arguments', tier: 'medium', ruleId: 'alerts.create_silence', reason: 'creating a silence mutes matching alerts', category: 'integrity' }];
}

export const alertsTool: ToolDef<z.infer<typeof alertsArgs>> = {
  key: 'alerts',
  kind: 'http',
  description:
    'Alertmanager. Read: list_alerts (active alerts), list_silences. Change (needs approval): ' +
    'create_silence (mute alerts matching `matchers` for `duration`, with a `comment`), expire_silence ' +
    '(end one by silence_id). Matchers look like alertname="DiskFull",instance="db1".',
  parameters: {
    operation: { type: 'string', enum: ['list_alerts', 'list_silences', 'create_silence', 'expire_silence'], description: 'What to do.' },
    filter: { type: 'string', description: 'List filter, e.g. severity="critical".' },
    matchers: { type: 'string', description: 'create_silence: which alerts to mute, e.g. alertname="DiskFull",instance="db1".' },
    duration: { type: 'string', description: 'create_silence: how long, e.g. 2h (max 24h).' },
    comment: { type: 'string', description: 'create_silence: why.' },
    silence_id: { type: 'string', description: 'expire_silence: the silence id.' },
  },
  required: ['operation'],
  argsSchema: alertsArgs,
  baselineRisk: 'read_only',
  targetKinds: ['alertmanager'],
  mutating: true,
  timeoutMs: 20_000,
  render: (a, t) =>
    a.operation === 'create_silence'
      ? `[${t.slug}] SILENCE ${a.matchers ?? '(none)'} for ${a.duration ?? '?'}: ${a.comment ?? ''}`
      : a.operation === 'expire_silence'
        ? `[${t.slug}] end silence ${a.silence_id ?? '?'}`
        : `[${t.slug}] ${a.operation}${a.filter ? ` ${a.filter}` : ''}`,
  classifyArgs: (a) => classifySilence(a),
  execute: async (a, ctx) => {
    const filter = a.filter ? { filter: a.filter } : {};
    if (a.operation === 'list_alerts') {
      const r = await call(ctx, '/api/v2/alerts', { active: 'true', ...filter });
      if ('error' in r) return errOutput(r.error);
      const list = (r.json as Array<{ labels: Record<string, string>; status: { state: string }; startsAt: string; annotations?: Record<string, string> }>) ?? [];
      return done(ctx, list.length
        ? `${list.length} alerts\n${list.slice(0, 100).map((x) => `${x.labels.alertname ?? '?'} ${labelsOf(x.labels)} ${x.status.state} since ${x.startsAt}${x.annotations?.summary ? ` -- ${x.annotations.summary}` : ''}`).join('\n')}`
        : 'No active alerts.');
    }
    if (a.operation === 'list_silences') {
      const r = await call(ctx, '/api/v2/silences', filter);
      if ('error' in r) return errOutput(r.error);
      const list = ((r.json as Array<{ id: string; status: { state: string }; matchers: Array<{ name: string; value: string }>; endsAt: string; comment: string; createdBy: string }>) ?? [])
        .filter((s) => s.status.state !== 'expired');
      return done(ctx, list.length
        ? list.map((s) => `${s.id} ${s.status.state} until ${s.endsAt} by ${s.createdBy}: ${s.matchers.map((m) => `${m.name}="${m.value}"`).join(',')} -- ${s.comment}`).join('\n')
        : 'No active silences.');
    }
    if (a.operation === 'expire_silence') {
      if (!a.silence_id) return errOutput('expire_silence needs a silence_id');
      const r = await call(ctx, `/api/v2/silence/${encodeURIComponent(a.silence_id)}`, {}, undefined, 'DELETE');
      return 'error' in r ? errOutput(r.error) : okOutput(`Silence ${a.silence_id} ended.`);
    }
    // create_silence
    const matchers = parseMatchers(a.matchers ?? '');
    const now = Date.now();
    const r = await call(ctx, '/api/v2/silences', {}, {
      matchers: matchers.map((m) => ({ name: m.name, value: m.value, isRegex: m.isRegex, isEqual: m.isEqual })),
      startsAt: new Date(now).toISOString(),
      endsAt: new Date(now + durationMs(a.duration ?? '1h')).toISOString(),
      createdBy: 'supops',
      comment: a.comment ?? 'created by SupOps',
    });
    if ('error' in r) return errOutput(r.error);
    const id = (r.json as { silenceID?: string; id?: string }).silenceID ?? (r.json as { id?: string }).id ?? '?';
    return okOutput(`Silence created (${id}) for ${a.duration ?? '1h'}.`);
  },
};
