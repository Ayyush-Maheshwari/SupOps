import { createHash } from 'node:crypto';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  DEFAULT_RUN_BUDGET,
  agents,
  healthChecks,
  healthIssues,
  runs,
  targets,
  toolCalls,
} from '@supops/db';
import type { HealthCheckSummary, RunBudget } from '@supops/db';
import type { HealthScanType } from '@supops/shared';
import { isTerminalRun } from '@supops/shared';
import type { ResolvedTarget } from '@supops/core';
import { BUILTIN_TOOL_KEYS, loadTargets } from '@supops/core';
import { db } from '../context.ts';
import { startRun } from './start-run.ts';

type HealthState = 'unknown' | 'ok' | 'degraded' | 'unreachable';

interface HealthIssueDraft {
  severity: 'warning' | 'critical';
  title: string;
  detail?: string;
}

/** Machines behind a jump live under their parent's umbrella -- never scanned as their own target. */
const isTopLevel = (t: ResolvedTarget): boolean =>
  !(t.config as { via?: { alias?: string } }).via?.alias;

const fingerprint = (targetId: string, title: string): string =>
  createHash('sha256').update(`${targetId}\n${title}`).digest('hex');

/** Upsert one drafted issue, deduped by (project, fingerprint) among still-open rows. */
function upsertIssue(
  projectId: string,
  checkId: string,
  targetId: string,
  draft: HealthIssueDraft,
): void {
  const fp = fingerprint(targetId, draft.title);
  const existing = db
    .select()
    .from(healthIssues)
    .where(and(eq(healthIssues.projectId, projectId), eq(healthIssues.fingerprint, fp)))
    .get();

  if (existing && existing.state !== 'resolved') {
    db.update(healthIssues)
      .set({ lastSeenAt: new Date(), severity: draft.severity, detail: draft.detail ?? null })
      .where(eq(healthIssues.id, existing.id))
      .run();
    return;
  }

  db.insert(healthIssues)
    .values({
      projectId,
      checkId,
      targetId,
      severity: draft.severity,
      title: draft.title,
      detail: draft.detail ?? null,
      fingerprint: fp,
      state: 'open',
      lastSeenAt: new Date(),
    })
    .run();
}

function setTargetHealth(targetId: string, state: HealthState): void {
  db.update(targets)
    .set({ healthState: state, lastCheckedAt: new Date() })
    .where(eq(targets.id, targetId))
    .run();
}

function finishCheck(checkId: string, summary: HealthCheckSummary): void {
  db.update(healthChecks)
    .set({ status: 'done', finishedAt: new Date(), summaryJson: summary })
    .where(eq(healthChecks.id, checkId))
    .run();
}

/**
 * Shared judgement guidance both health agents get. The important part: a stopped or
 * "failed" unit is not automatically a problem -- plenty are disabled on purpose. Only
 * flag what actually affects the system, so "degraded" reflects a real fault.
 */
const HEALTH_JUDGEMENT =
  'Use judgement about what is actually wrong. A service being stopped, disabled, or ' +
  'listed as failed is NOT automatically a problem -- many units are intentionally off ' +
  '(one-shots that already completed, unused daemons like isc-dhcp-server, refresh ' +
  'timers). Only raise a warning or critical when something genuinely affects the ' +
  'machine or a workload (disk nearly full, memory/CPU pressure, a crashing pod, a ' +
  'service that should be running but is not). When in doubt, note it as info, not a ' +
  'problem.';

/**
 * How to run commands without hanging. The session may hold a PTY (needed for sudo),
 * so a command that opens a pager waits forever and is killed at the timeout. This
 * bit each health run on `systemctl`.
 */
const NO_PAGER =
  'IMPORTANT -- never run a command that opens an interactive pager or a live UI; there ' +
  'is no terminal to page it and the command will hang until it is killed. Always use ' +
  'the non-paging form: `systemctl --no-pager --failed`, `journalctl --no-pager -p err ' +
  '-n 50`, `top -b -n1`. Never run a bare `systemctl`, `journalctl`, `less`, `more`, ' +
  '`top`, or anything that waits on a keypress.';

/** How to check Kubernetes pod health, when kubectl is on the host. */
const POD_SCAN =
  'If kubectl is available, scan pod state across ALL namespaces with ' +
  '`kubectl get pods -A` (kubectl does not page). Report the namespace count and every ' +
  'pod that is not Running/Completed or not fully Ready, naming its namespace, pod and ' +
  'status -- especially CrashLoopBackOff, ImagePullBackOff, Error, Pending and OOMKilled.';

export interface HealthAgentSpec {
  slug: string;
  name: string;
  systemPrompt: string;
  budget: RunBudget;
}

/** The two built-in health agents. Single source of truth for seed + lazy creation. */
export const HEALTH_AGENT_SPECS: Record<HealthScanType, HealthAgentSpec> = {
  quick: {
    slug: 'healthcheck-quick',
    name: 'Health Check (Quick)',
    // A light budget keeps Quick fast and cheap: a few commands per target.
    budget: { maxIterations: 14, maxToolCalls: 30, maxWallClockMs: 5 * 60_000, maxOutputBytesPerCall: 16_384 },
    systemPrompt:
      'You are running a QUICK health check -- a fast, light pass, not a deep ' +
      'investigation. For each target, take one look at the essentials: is it reachable, ' +
      'disk usage, memory pressure, CPU/load, failed services, and (where kubectl is ' +
      'present) namespaces and whether any pods are unhealthy. A handful of read-only ' +
      'commands per target is enough -- do not dig further.\n\n' +
      NO_PAGER + '\n\n' + POD_SCAN + '\n\n' +
      HEALTH_JUDGEMENT +
      '\n\nRead only -- never make a change. For each target call record_finding once: ' +
      'severity info when it is healthy (summarise the numbers you saw), warning or ' +
      'critical when something is genuinely wrong. Then stop.',
  },
  deep: {
    slug: 'healthcheck',
    name: 'Health Check (Deep)',
    budget: DEFAULT_RUN_BUDGET,
    systemPrompt:
      'You are running a DEEP health check -- a thorough investigation. For each target, ' +
      'assess reachability, disk, memory, CPU/load, services, and (where kubectl is ' +
      'present) namespaces and pod health -- and follow anything suspicious to its root ' +
      'cause: read the relevant logs, check dependent units, inspect the failing pods. ' +
      'Take the time to be sure.\n\n' +
      NO_PAGER + '\n\n' + POD_SCAN + '\n\n' +
      HEALTH_JUDGEMENT +
      '\n\nRead only -- never make a change. Use record_finding for each conclusion: ' +
      'severity info when healthy, warning or critical for real problems, with the ' +
      'evidence you gathered.',
  },
};

/**
 * Get a project's health agent, creating it if the project predates the feature.
 * Projects created before health mode existed only have triage/console, so a scan
 * would otherwise fail with "no health-check agent" -- this heals that transparently.
 */
function ensureScanAgent(projectId: string, type: HealthScanType): typeof agents.$inferSelect {
  const spec = HEALTH_AGENT_SPECS[type];
  const existing = db
    .select()
    .from(agents)
    .where(and(eq(agents.projectId, projectId), eq(agents.slug, spec.slug)))
    .get();

  // These are built-in agents, so the spec is authoritative: keep the stored prompt,
  // name and budget in sync with it. That is how a prompt fix (e.g. the pager rule)
  // reaches a project that created its health agents before the fix landed.
  if (existing) {
    if (existing.systemPrompt !== spec.systemPrompt || existing.name !== spec.name) {
      db.update(agents)
        .set({ name: spec.name, systemPrompt: spec.systemPrompt, budget: spec.budget })
        .where(eq(agents.id, existing.id))
        .run();
      return { ...existing, name: spec.name, systemPrompt: spec.systemPrompt, budget: spec.budget };
    }
    return existing;
  }

  return db
    .insert(agents)
    .values({
      projectId,
      slug: spec.slug,
      name: spec.name,
      role: 'triage',
      toolKeys: BUILTIN_TOOL_KEYS,
      systemPrompt: spec.systemPrompt,
      budget: spec.budget,
      createdAt: new Date(),
    })
    .returning()
    .get();
}

export type ScanResult =
  | { ok: true; check: typeof healthChecks.$inferSelect; runId: string }
  | { ok: false; code: 400 | 404 | 409; error: string };

const SCAN_TASK: Record<HealthScanType, string> = {
  quick:
    'Run a quick health check across the targets below. For each one, take a fast look at ' +
    'reachability, disk, memory, CPU/load, failed services and (where kubectl is present) ' +
    'pods and namespaces, then record a finding.',
  deep:
    'Run a deep health check across the targets below. For each one, investigate ' +
    'reachability, disk, memory, CPU/load, services and (where kubectl is present) pod ' +
    'health, follow anything suspicious to its root cause, and record your findings.',
};

/**
 * Launch a scan: one agent run over the in-scope top-level targets. Both Quick and
 * Deep are LLM runs -- Quick uses the light `healthcheck-quick` agent (small budget),
 * Deep the thorough `healthcheck` agent. The run's findings are harvested into issues
 * and per-target health when it finishes (see `reconcileChecks`).
 */
export function startScan(
  projectId: string,
  type: HealthScanType,
  trigger: 'manual' | 'schedule',
  startedBy: string | null,
  targetIds?: string[],
): ScanResult {
  const agent = ensureScanAgent(projectId, type);

  const wanted = targetIds?.length ? new Set(targetIds) : null;
  const topLevel = loadTargets(db, projectId)
    .filter(isTopLevel)
    .filter((t) => !wanted || wanted.has(t.id));
  if (topLevel.length === 0) {
    return { ok: false, code: 400, error: 'This project has no enabled targets to check.' };
  }

  const result = startRun({
    projectId,
    agentId: agent.id,
    task: SCAN_TASK[type],
    targetIds: topLevel.map((t) => t.id),
    trigger: 'health',
    startedBy,
  });
  if (!result.ok) return result;

  const check = db
    .insert(healthChecks)
    .values({ projectId, type, trigger, status: 'running', runId: result.run.id, startedBy })
    .returning()
    .get();
  return { ok: true, check, runId: result.run.id };
}

const SEVERITY_TO_STATE: Record<string, HealthState> = {
  info: 'ok',
  warning: 'degraded',
  critical: 'degraded',
};
const SEVERITY_RANK: Record<string, number> = { info: 0, warning: 1, critical: 2 };

/**
 * Harvest a finished scan run: turn its `record_finding` calls into issues and
 * per-target health, then mark the check done. Idempotent -- safe to call whenever a
 * running check's run has reached a terminal status.
 *
 * Health state comes entirely from the agent's judgement: a target the agent flagged
 * (warning/critical) is `degraded`, everything else it looked at is `ok`. So a service
 * that was intentionally stopped no longer makes a box "degraded" -- only a real fault
 * the agent decided to raise does.
 */
function harvestCheck(check: typeof healthChecks.$inferSelect): void {
  if (!check.runId) {
    finishCheck(check.id, { checked: 0, ok: 0, degraded: 0, unreachable: 0, issues: 0 });
    return;
  }

  const run = db.select().from(runs).where(eq(runs.id, check.runId)).get();
  const calls = db
    .select()
    .from(toolCalls)
    .where(and(eq(toolCalls.runId, check.runId), eq(toolCalls.toolKey, 'record_finding')))
    .all();

  const bySlug = new Map(loadTargets(db, check.projectId).map((t) => [t.slug, t]));
  // Worst severity seen per target, so one target with several findings gets one state.
  const worst = new Map<string, string>();
  const summary: HealthCheckSummary = { checked: 0, ok: 0, degraded: 0, unreachable: 0, issues: 0 };

  for (const call of calls) {
    const args = (call.argsJson as { target?: string; finding?: string; severity?: string }) ?? {};
    const target = args.target ? bySlug.get(args.target) : undefined;
    const severity = args.severity ?? 'info';
    if (!target || !args.finding) continue;

    const prev = worst.get(target.id);
    if (!prev || (SEVERITY_RANK[severity] ?? 0) > (SEVERITY_RANK[prev] ?? 0)) {
      worst.set(target.id, severity);
    }

    if (severity === 'warning' || severity === 'critical') {
      upsertIssue(check.projectId, check.id, target.id, {
        severity,
        title: args.finding.split('\n')[0]!.slice(0, 120),
        detail: args.finding,
      });
      summary.issues += 1;
    }
  }

  // Every target the run was scoped to counts as checked; those the agent did not
  // flag are healthy.
  const snapshot = (run?.targetsSnapshot as Array<{ slug: string }> | null) ?? [];
  const scoped = snapshot
    .map((s) => bySlug.get(s.slug))
    .filter((t): t is NonNullable<typeof t> => !!t);

  for (const target of scoped) {
    const state = SEVERITY_TO_STATE[worst.get(target.id) ?? 'info'] ?? 'ok';
    setTargetHealth(target.id, state);
    summary.checked += 1;
    if (state === 'degraded') summary.degraded += 1;
    else summary.ok += 1;
  }

  finishCheck(check.id, summary);
}

/**
 * Reconcile any running checks whose run has finished. Called each scheduler tick --
 * the durable equivalent of an engine completion hook.
 */
export function reconcileChecks(): void {
  const running = db
    .select()
    .from(healthChecks)
    .where(eq(healthChecks.status, 'running'))
    .all();
  if (running.length === 0) return;

  const runIds = running.map((c) => c.runId).filter((r): r is string => !!r);
  const runRows = runIds.length
    ? db.select({ id: runs.id, status: runs.status }).from(runs).where(inArray(runs.id, runIds)).all()
    : [];
  const statusById = new Map(runRows.map((r) => [r.id, r.status]));

  for (const check of running) {
    const status = check.runId ? statusById.get(check.runId) : undefined;
    // No run row (deleted) or a terminal run -> harvest and close it out.
    if (!check.runId || !status || isTerminalRun(status)) harvestCheck(check);
  }
}

export type InvestigateResult =
  | { ok: true; runId: string }
  | { ok: false; code: 400 | 404 | 409; error: string };

/** Start a scoped triage investigation from one open issue. */
export function investigateIssue(issueId: string, startedBy: string | null): InvestigateResult {
  const issue = db.select().from(healthIssues).where(eq(healthIssues.id, issueId)).get();
  if (!issue) return { ok: false, code: 404, error: 'Issue not found' };

  const triage =
    db
      .select()
      .from(agents)
      .where(and(eq(agents.projectId, issue.projectId), eq(agents.slug, 'triage')))
      .get() ?? db.select().from(agents).where(eq(agents.projectId, issue.projectId)).get();
  if (!triage) return { ok: false, code: 409, error: 'This project has no agent to investigate with.' };

  const result = startRun({
    projectId: issue.projectId,
    agentId: triage.id,
    task: [
      `A health check flagged a ${issue.severity} issue.`,
      `Issue: ${issue.title}`,
      issue.detail ? `Details: ${issue.detail}` : '',
      'Investigate the root cause on the affected host and explain what is wrong. Only remediate if it is clearly safe; otherwise stop and describe what you would do.',
    ]
      .filter(Boolean)
      .join('\n'),
    targetIds: [issue.targetId],
    trigger: 'health',
    triggerPayload: { healthIssueId: issue.id },
    startedBy,
  });
  if (!result.ok) return result;

  db.update(healthIssues)
    .set({ state: 'investigating', runId: result.run.id })
    .where(eq(healthIssues.id, issue.id))
    .run();
  return { ok: true, runId: result.run.id };
}

/** The Health page payload: latest check, per-target health, open issues, schedule. */
export function healthOverview(projectId: string) {
  const latest = db
    .select()
    .from(healthChecks)
    .where(eq(healthChecks.projectId, projectId))
    .orderBy(desc(healthChecks.startedAt))
    .limit(1)
    .get();

  // Only `open` issues are "waiting on you". Once investigated, an issue becomes a
  // run and drops off this list -- it lives in Runs from then on.
  const issues = db
    .select()
    .from(healthIssues)
    .where(and(eq(healthIssues.projectId, projectId), eq(healthIssues.state, 'open')))
    .orderBy(desc(healthIssues.lastSeenAt))
    .all();

  return { latest: latest ?? null, issues };
}
