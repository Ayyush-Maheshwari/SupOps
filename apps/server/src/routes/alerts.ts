import { Router } from 'express';
import { and, desc, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { agents, alerts } from '@supops/db';
import type { AlertStatus } from '@supops/shared';
import { loadTargets, scopeAlert } from '@supops/core';
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

interface ScopeNote {
  slugs: string[];
  reason: string;
  by: 'label' | 'text' | 'channel' | null;
}

/**
 * The run's task. `scope` names the machine(s) the alert resolved to and how, so
 * the agent starts there instead of rediscovering it -- the rest of the scope (the
 * jump, the machines behind it) is there so it can reach them, not to be swept.
 */
function buildAlertTask(alert: typeof alerts.$inferSelect, scope?: ScopeNote): string {
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
    scope?.by === 'channel'
      ? `SupOps narrowed this run using ${scope.reason}; the alert does not name a machine, so work out which one it is about from the alert before checking anything.`
      : scope
        ? `SupOps matched this alert to ${scope.slugs.join(', ')} using ${scope.reason}. Start there; if the evidence points to another machine in scope, say so and confirm it first.`
        : '',
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

  // Scope the run the way a person would in Investigate (see scopeAlert): the machine
  // the alert names, plus its jump or the machines behind it so they are reachable.
  // No match leaves the scope empty, which gives the run every target.
  const available = loadTargets(db, alert.projectId);
  const scope = scopeAlert(
    { labels: alert.labels as Record<string, string> | null, title: alert.title, summary: alert.summary, channelName: alert.channelName },
    available,
  );
  const matches = scope.targets;
  const targetIds = matches.length > 0 ? matches.map((t) => t.id) : undefined;
  // Name what the alert itself pointed at, not the jump or siblings added for reach.
  const named = scope.matched.slice(0, 6).map((t) => t.slug);

  const result = startRun({
    projectId: alert.projectId,
    agentId: triage.id,
    task: buildAlertTask(alert, scope.reason ? { slugs: named, reason: scope.reason, by: scope.by } : undefined),
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
