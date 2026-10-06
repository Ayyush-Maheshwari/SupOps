import { createHash } from 'node:crypto';
import type { AlertSeverity } from '@supops/shared';
import type { ResolvedTarget } from '../tools/types.ts';
import { obsRequest } from '../tools/observability.ts';

/**
 * Firing alerts read straight from a connection, in one shape whatever the source:
 * Alertmanager's v2 API, Grafana's built-in Alertmanager (same API, for
 * Grafana-managed rules), or Prometheus' own rule alerts. Unlike the Slack relay,
 * these carry every label, a stable fingerprint, and disappear when they resolve.
 */
export interface SourceAlert {
  fingerprint: string;
  title: string;
  severity: AlertSeverity;
  summary: string | null;
  labels: Record<string, string>;
  startsAt: number | null;
  /** A link back to the source (generatorURL), when it gave one. */
  link: string | null;
}

export function normalizeSeverity(raw: string | undefined): AlertSeverity {
  const v = (raw ?? '').toLowerCase().trim();
  if (/^(critical|crit|fatal|error|err|emergency|page|p1|sev1|high|disaster)$/.test(v)) return 'critical';
  if (/^(warning|warn|major|minor|p2|sev2|medium|average)$/.test(v)) return 'warning';
  if (/^(info|informational|notice|low|p3|p4|sev3|sev4|none)$/.test(v)) return 'info';
  return 'unknown';
}

const sevOf = (labels: Record<string, string>) =>
  normalizeSeverity(labels.severity ?? labels.priority ?? labels.level);

const labelFingerprint = (labels: Record<string, string>) =>
  createHash('sha256')
    .update(Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`).join(','))
    .digest('hex')
    .slice(0, 32);

const time = (v: unknown) => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(t) ? null : t;
};

interface AmAlert {
  fingerprint?: string;
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  startsAt?: string;
  generatorURL?: string;
  status?: { state?: string };
}

/** Alertmanager v2 `/api/v2/alerts`: only active (not silenced or inhibited) ones count. */
export function fromAlertmanager(list: unknown): SourceAlert[] {
  if (!Array.isArray(list)) return [];
  return (list as AmAlert[])
    .filter((a) => a.labels && (a.status?.state ?? 'active') === 'active')
    .map((a) => {
      const labels = a.labels!;
      return {
        fingerprint: a.fingerprint || labelFingerprint(labels),
        title: (labels.alertname ?? 'Alert').slice(0, 200),
        severity: sevOf(labels),
        summary: (a.annotations?.summary ?? a.annotations?.description ?? a.annotations?.message ?? null)?.slice(0, 2000) ?? null,
        labels,
        startsAt: time(a.startsAt),
        link: a.generatorURL || null,
      };
    });
}

interface PromAlert {
  labels?: Record<string, string>;
  annotations?: Record<string, string>;
  state?: string;
  activeAt?: string;
}

/** Prometheus `/api/v1/alerts`: firing only (pending alerts have not met their `for` yet). */
export function fromPrometheus(json: unknown): SourceAlert[] {
  const list = (json as { data?: { alerts?: PromAlert[] } })?.data?.alerts;
  if (!Array.isArray(list)) return [];
  return list
    .filter((a) => a.labels && a.state === 'firing')
    .map((a) => {
      const labels = a.labels!;
      return {
        fingerprint: labelFingerprint(labels),
        title: (labels.alertname ?? 'Alert').slice(0, 200),
        severity: sevOf(labels),
        summary: (a.annotations?.summary ?? a.annotations?.description ?? null)?.slice(0, 2000) ?? null,
        labels,
        startsAt: time(a.activeAt),
        link: null,
      };
    });
}

/** Read the firing alerts from one connection. */
export async function fetchConnectionAlerts(target: ResolvedTarget, signal?: AbortSignal): Promise<{ alerts: SourceAlert[] } | { error: string }> {
  if (target.kind === 'alertmanager') {
    const r = await obsRequest(target, '/api/v2/alerts', { query: { active: 'true', silenced: 'false', inhibited: 'false' }, signal });
    return 'error' in r ? r : { alerts: fromAlertmanager(r.json) };
  }
  if (target.kind === 'grafana') {
    const r = await obsRequest(target, '/api/alertmanager/grafana/api/v2/alerts', { query: { active: 'true', silenced: 'false', inhibited: 'false' }, signal, direct: true });
    return 'error' in r ? r : { alerts: fromAlertmanager(r.json) };
  }
  if (target.kind === 'prometheus') {
    const r = await obsRequest(target, '/api/v1/alerts', { signal });
    return 'error' in r ? r : { alerts: fromPrometheus(r.json) };
  }
  return { error: `${target.kind} connections have no alerts to read` };
}
