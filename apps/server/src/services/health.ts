import { createHash } from 'node:crypto';
import { and, desc, eq, inArray, notInArray } from 'drizzle-orm';
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
import { KIND_META, isTerminalRun } from '@supops/shared';
import type { TargetKind } from '@supops/shared';
import type { ResolvedTarget } from '@supops/core';
import { BUILTIN_TOOL_KEYS, asSeverity, judgeHealth, loadTargets } from '@supops/core';
import type { IssueDraft, ScanFinding } from '@supops/core';
import { db } from '../context.ts';
import { startRun } from './start-run.ts';

type HealthState = 'unknown' | 'ok' | 'degraded' | 'unreachable';

/** Machines behind a jump live under their parent's umbrella -- never scanned as their own target. */
const isTopLevel = (t: ResolvedTarget): boolean =>
  !(t.config as { via?: { alias?: string } }).via?.alias &&
  // Only kinds a scan knows how to check: a Prometheus connection is not a host.
  (KIND_META[t.kind as TargetKind]?.healthScan ?? false);

const fingerprint = (targetId: string, title: string): string =>
  createHash('sha256').update(`${targetId}\n${title}`).digest('hex');

/**
 * Upsert one drafted issue, deduped by (project, fingerprint) among still-open rows.
 * Returns the fingerprint so the caller knows what this scan saw.
 */
function upsertIssue(projectId: string, checkId: string, draft: IssueDraft): string {
  const { targetId } = draft;
  const fp = fingerprint(targetId, draft.title);
  const existing = db
    .select()
    .from(healthIssues)
    .where(and(eq(healthIssues.projectId, projectId), eq(healthIssues.fingerprint, fp)))
    .get();

  if (existing && existing.state !== 'resolved') {
    db.update(healthIssues)
      .set({ lastSeenAt: new Date(), severity: draft.severity, detail: draft.detail })
      .where(eq(healthIssues.id, existing.id))
      .run();
    return fp;
  }

  db.insert(healthIssues)
    .values({
      projectId,
      checkId,
      targetId,
      severity: draft.severity,
      title: draft.title,
      detail: draft.detail,
      fingerprint: fp,
      state: 'open',
      lastSeenAt: new Date(),
    })
    .run();
  return fp;
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
 * Shared judgement guidance both health agents get. The line that matters is essential
 * vs. non-essential: only an essential problem degrades a target, so a box with a few
 * pending updates or an unused failed unit still reads as healthy.
 */
const HEALTH_JUDGEMENT =
  'Grade every finding by whether it is ESSENTIAL -- whether it affects what the machine ' +
  'or its workloads actually do.\n' +
  '- warning or critical (essential; the target shows as degraded): disk or inodes at ' +
  '90% or more, memory pressure or OOM kills, load well above the core count for a ' +
  'sustained period, a service that is enabled or expected to run but is down (sshd, ' +
  'the web server, the database, the workload the host exists for), crash-looping or ' +
  'not-Ready pods, NotReady nodes, a read-only or failing filesystem or disk.\n' +
  '- notice (non-essential; worth mentioning, the target stays healthy): pending ' +
  'package updates, a reboot-required flag, disabled, unused or one-shot units sitting ' +
  'in failed (e.g. isc-dhcp-server, a completed refresh timer), disk between 70% and ' +
  '89%, benign log noise, a certificate expiring in more than 14 days.\n' +
  '- info: the target is healthy -- summarise the numbers you saw.\n' +
  'If you could not connect to a target at all, record one finding for it with ' +
  'reachable set to false. When unsure whether something is essential, use notice.';

/**
 * How to run commands without hanging. The session may hold a PTY (needed for sudo),
 * so a command that opens a pager waits forever and is killed at the timeout. This
 * bit each health run on `systemctl`.
 */
const NO_PAGER =
  'This check runs unattended: any command that would need approval is refused, so ' +
  'stick to standard read-only commands (df, free, uptime, systemctl --failed, ' +
  'journalctl, kubectl get). The targets are already chosen for you -- start checking ' +
  'right away. ' +
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

/** How to check a cluster target (kind k8s), which has no shell -- only k8s_kubectl. */
const CLUSTER_SCAN_QUICK =
  'For a Kubernetes cluster target (kind k8s) use k8s_kubectl: `get nodes -o wide` (every ' +
  'node Ready?), `get pods -A` (or per allowed namespace with -n) for pods not ' +
  'Running/Completed or not fully Ready, `get events -A --field-selector type=Warning` ' +
  'for recent warnings, and `top nodes` if metrics-server answers. Record one finding per cluster.';
const CLUSTER_SCAN_DEEP =
  CLUSTER_SCAN_QUICK.replace(' Record one finding per cluster.', '') +
  ' Then go deeper: `get deploy,sts,ds -A` for desired-vs-ready mismatches, pods with high ' +
  'restart counts, `describe` and `logs --tail=200` (add --previous for crash loops) on anything ' +
  'failing, `get pvc -A` for Pending/Lost volumes, `get hpa -A` for pinned autoscalers, and ' +
  '`top pods -A` for resource pressure.';

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
      'investigation. For each target, take one look at the essentials for its kind ' +
      '(the task lists what to check for each kind in scope). A handful of read-only ' +
      'commands per target is enough -- do not dig further.\n\n' +
      NO_PAGER + '\n\n' +
      HEALTH_JUDGEMENT +
      '\n\nRead only -- never make a change. For each target call record_finding: one ' +
      'info finding when it is healthy, plus one finding per notice or essential problem. ' +
      'Then stop.',
  },
  deep: {
    slug: 'healthcheck',
    name: 'Health Check (Deep)',
    budget: DEFAULT_RUN_BUDGET,
    systemPrompt:
      'You are running a DEEP health check -- a thorough investigation. For each target, ' +
      'assess the essentials for its kind (the task lists them) and follow anything ' +
      'suspicious to its root cause: read the relevant logs, check what it depends on, ' +
      'inspect whatever is failing. Take the time to be sure.\n\n' +
      NO_PAGER + '\n\n' +
      HEALTH_JUDGEMENT +
      '\n\nRead only -- never make a change. Use record_finding for each conclusion, ' +
      'graded as above, with the evidence you gathered.',
  },
};

/**
 * Get a project's health agent, creating it if the project predates the feature.
 * Projects created before health mode existed only have triage/console, so a scan
 * would otherwise fail with "no health-check agent" -- this heals that transparently.
 */
export function ensureScanAgent(projectId: string, type: HealthScanType): typeof agents.$inferSelect {
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

/** What to check, per kind of target. Only the kinds a scan actually covers go in its task. */
const MACHINE_SCAN =
  'Machines (kind ssh): reachability, disk usage, memory pressure, CPU/load and failed services. ' + POD_SCAN;
const SCAN_FRAGMENTS: Record<string, Record<HealthScanType, string>> = {
  ssh: { quick: MACHINE_SCAN, deep: MACHINE_SCAN },
  k8s: { quick: CLUSTER_SCAN_QUICK, deep: CLUSTER_SCAN_DEEP },
};

/**
 * The scan's task, built from the kinds it covers. Kind-specific steps used to sit
 * in the health agents' instructions for every scan; a scan of plain VMs read pages
 * of Kubernetes guidance, and new kinds of target had nowhere to go.
 */
export function buildScanTask(type: HealthScanType, kinds: string[]): string {
  const intro =
    type === 'quick'
      ? 'Run a quick health check across the targets below and record a finding for each.'
      : 'Run a deep health check across the targets below, follow anything suspicious to its root cause, and record your findings.';
  const parts = [...new Set(kinds)].sort().map((k) => SCAN_FRAGMENTS[k]?.[type]).filter(Boolean);
  return parts.length ? `${intro}\n\nWhat to check:\n- ${parts.join('\n- ')}` : intro;
}

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
    task: buildScanTask(type, topLevel.map((t) => t.kind)),
    targetIds: topLevel.map((t) => t.id),
    trigger: 'health',
    startedBy,
    // Scans are read-only and often run on a timer with nobody watching: they must
    // never stop to wait for an approval.
    unattended: true,
  });
  if (!result.ok) return result;

  const check = db
    .insert(healthChecks)
    .values({ projectId, type, trigger, status: 'running', runId: result.run.id, startedBy })
    .returning()
    .get();
  return { ok: true, check, runId: result.run.id };
}

/**
 * Harvest a finished scan run: turn its `record_finding` calls into issues and
 * per-target health, then mark the check done. Idempotent -- safe to call whenever a
 * running check's run has reached a terminal status.
 *
 * The state comes from `judgeHealth`: only essential findings (warning/critical)
 * degrade a target; notices are kept as notes. When the run finished cleanly, open
 * issues it no longer saw on the targets it covered are resolved. A failed or
 * cancelled run is partial evidence: it resolves nothing and only updates the
 * targets it actually reported on.
 */
function harvestCheck(check: typeof healthChecks.$inferSelect): void {
  if (!check.runId) {
    finishCheck(check.id, { checked: 0, ok: 0, degraded: 0, unreachable: 0, issues: 0, notes: 0 });
    return;
  }

  const run = db.select().from(runs).where(eq(runs.id, check.runId)).get();
  const calls = db
    .select()
    .from(toolCalls)
    .where(and(eq(toolCalls.runId, check.runId), eq(toolCalls.toolKey, 'record_finding')))
    .all();

  const bySlug = new Map(loadTargets(db, check.projectId).map((t) => [t.slug, t]));
  const findings: ScanFinding[] = [];
  for (const call of calls) {
    const args = (call.argsJson as { target?: string; finding?: string; severity?: string; reachable?: boolean }) ?? {};
    const target = args.target ? bySlug.get(args.target) : undefined;
    if (!target || !args.finding) continue;
    findings.push({
      targetId: target.id,
      severity: asSeverity(args.severity),
      finding: args.finding,
      ...(args.reachable === false ? { reachable: false } : {}),
    });
  }

  // Every target the run was scoped to counts as checked.
  const snapshot = (run?.targetsSnapshot as Array<{ slug: string }> | null) ?? [];
  const scoped = snapshot
    .map((s) => bySlug.get(s.slug)?.id)
    .filter((id): id is string => !!id);

  // A run that did not finish cleanly only speaks for the targets it reported on:
  // silence from a crashed or cancelled run is not evidence of health.
  const clean = run?.status === 'succeeded';
  const covered = clean ? scoped : scoped.filter((id) => findings.some((f) => f.targetId === id));

  const { states, issues, summary } = judgeHealth(findings, covered);
  const seen = issues.map((draft) => upsertIssue(check.projectId, check.id, draft));
  for (const [targetId, state] of states) setTargetHealth(targetId, state);

  if (clean && scoped.length) {
    const stale = [
      eq(healthIssues.projectId, check.projectId),
      eq(healthIssues.state, 'open'),
      inArray(healthIssues.targetId, scoped),
    ];
    if (seen.length) stale.push(notInArray(healthIssues.fingerprint, seen));
    db.update(healthIssues)
      .set({ state: 'resolved', resolvedAt: new Date() })
      .where(and(...stale))
      .run();
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
