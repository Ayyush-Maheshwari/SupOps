import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agents, alerts } from '@supops/db';
import type { AlertStatus } from '@supops/shared';
import { loadTargets } from '@supops/core';
import { db } from '../context.ts';
import { startRun } from '../services/start-run.ts';

export const alertRoutes = Router();

/** List a project's alerts, newest first, with the facets the UI filters on. */
alertRoutes.get('/', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const status = typeof req.query.status === 'string' ? (req.query.status as AlertStatus) : null;
  const channel = typeof req.query.channel === 'string' ? req.query.channel : null;

  const where = [eq(alerts.projectId, projectId)];
  if (status) where.push(eq(alerts.status, status));
  if (channel) where.push(eq(alerts.channelId, channel));

  const rows = db
    .select()
    .from(alerts)
    .where(and(...where))
    .orderBy(desc(alerts.receivedAt))
    .limit(200)
    .all();

  // Facets are computed over the whole project, not the filtered view, so the chips
  // keep showing their counts after you click one.
  const byStatus = db
    .select({ status: alerts.status, n: sql<number>`count(*)` })
    .from(alerts)
    .where(eq(alerts.projectId, projectId))
    .groupBy(alerts.status)
    .all();
  const channels = db
    .selectDistinct({ channelId: alerts.channelId, channelName: alerts.channelName })
    .from(alerts)
    .where(eq(alerts.projectId, projectId))
    .all();

  res.json({
    alerts: rows,
    statusCounts: Object.fromEntries(byStatus.map((r) => [r.status, r.n])),
    channels: channels.filter((c) => c.channelId),
  });
});

/** Badge count: how many alerts are waiting on a decision. */
alertRoutes.get('/count', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : '';
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(alerts)
    .where(and(eq(alerts.projectId, projectId), eq(alerts.status, 'new')))
    .get();
  res.json({ new: row?.n ?? 0 });
});

/** The label keys we try, in order, when scoping the investigation to a host. */
const HOST_LABEL_KEYS = ['instance', 'host', 'node', 'hostname'];

function buildAlertTask(alert: typeof alerts.$inferSelect): string {
  const labels = (alert.labels as Record<string, string> | null) ?? {};
  const notable = Object.entries(labels)
    .filter(([k]) => !k.startsWith('_') && !['summary', 'description'].includes(k))
    .slice(0, 12)
    .map(([k, v]) => `${k}=${v}`)
    .join(', ');
  return [
    `An alert fired${alert.channelName ? ` in Slack ${alert.channelName}` : ''} (severity: ${alert.severity}).`,
    `Alert: ${alert.title}`,
    alert.summary ? `Details: ${alert.summary}` : '',
    notable ? `Labels: ${notable}` : '',
    'Investigate the root cause on the affected host and remediate where it is safe to do so. If remediation is risky, stop and explain what you would do.',
  ]
    .filter(Boolean)
    .join('\n');
}

/** Start a triage investigation from an alert, scoped to the matched host if we can find one. */
alertRoutes.post('/:id/investigate', (req, res) => {
  const alert = db.select().from(alerts).where(eq(alerts.id, req.params.id)).get();
  if (!alert) {
    res.status(404).json({ error: 'Alert not found' });
    return;
  }

  const triage =
    db.select().from(agents).where(and(eq(agents.projectId, alert.projectId), eq(agents.slug, 'triage'))).get() ??
    db.select().from(agents).where(eq(agents.projectId, alert.projectId)).get();
  if (!triage) {
    res.status(409).json({ error: 'This project has no agent to run the investigation.' });
    return;
  }

  // Scope the run to the smallest set of targets we can justify, in priority order:
  //   1. a target whose host/slug matches the alert's instance label (most precise)
  //   2. failing that, targets whose env or slug appears in the channel name -- e.g.
  //      "#nsdc-prod-alerts" scopes to the prod target, not every host
  //   3. failing both, all targets (the agent decides from the alert text)
  const available = loadTargets(db, alert.projectId);
  const labels = (alert.labels as Record<string, string> | null) ?? {};
  const hostValue = HOST_LABEL_KEYS.map((k) => labels[k]).find(Boolean)?.split(':')[0]?.trim();

  let matches = hostValue
    ? available.filter((t) => {
        const cfg = t.config as { host?: string };
        return t.slug === hostValue || cfg.host === hostValue;
      })
    : [];

  if (matches.length === 0 && alert.channelName) {
    const words = new Set(alert.channelName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
    matches = available.filter((t) => words.has(t.slug.toLowerCase()) || words.has(String(t.env).toLowerCase()));
  }

  const targetIds = matches.length > 0 ? matches.map((t) => t.id) : undefined;

  const result = startRun({
    projectId: alert.projectId,
    agentId: triage.id,
    task: buildAlertTask(alert),
    targetIds,
    trigger: 'alert',
    triggerPayload: { alertId: alert.id, fingerprint: alert.fingerprint },
    startedBy: req.user?.id ?? null,
  });
  if (!result.ok) {
    res.status(result.code).json({ error: result.error });
    return;
  }

  db.update(alerts)
    .set({ status: 'investigating', runId: result.run.id, decidedAt: new Date(), decidedBy: req.user?.id ?? null })
    .where(eq(alerts.id, alert.id))
    .run();

  res.status(201).json({ run: result.run, scopedTo: matches.map((t) => t.slug) });
});

const decisionBody = z.object({ projectId: z.string().optional() });

/** Ignore = gone. The Alerts view holds only what still needs a decision. */
alertRoutes.post('/:id/ignore', (req, res) => {
  decisionBody.safeParse(req.body);
  const removed = db.delete(alerts).where(eq(alerts.id, req.params.id)).returning().get();
  if (!removed) {
    res.status(404).json({ error: 'Alert not found' });
    return;
  }
  res.json({ ok: true });
});
