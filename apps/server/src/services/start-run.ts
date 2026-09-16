import { eq } from 'drizzle-orm';
import { agents, projects, runs } from '@supops/db';
import type { RunTrigger } from '@supops/shared';
import {
  bindTools,
  buildOpeningMessage,
  buildSystemPrompt,
  loadTargets,
} from '@supops/core';
import { db, engine, registry, settingsStore } from '../context.ts';
import { worker } from '../worker.ts';

export interface StartRunInput {
  projectId: string;
  agentId: string;
  task: string;
  /** Omit or leave empty for every enabled target in the project. */
  targetIds?: string[];
  /** Console sessions stay open after each turn instead of ending. */
  interactive?: boolean;
  /** Defaults to 'chat'. Alerts pass 'alert', schedules 'schedule', etc. */
  trigger?: RunTrigger;
  /** Stored verbatim on the run; defaults to `{ task }`. */
  triggerPayload?: unknown;
  /** The user who initiated it, if any (alerts and schedules may have none). */
  startedBy?: string | null;
}

export type StartRunResult =
  | { ok: true; run: typeof runs.$inferSelect }
  | { ok: false; code: 400 | 404 | 409; error: string };

/**
 * The single place a run is created.
 *
 * Extracted from the POST /runs route so the Console, Investigate, and alert-driven
 * paths all freeze the same snapshots and seed the same seq-0/seq-1 steps -- the
 * property that makes the audit trail mean anything. `trigger` is the only real
 * parameter that varies between callers.
 */
export function startRun(input: StartRunInput): StartRunResult {
  const { projectId, agentId, task, targetIds, interactive } = input;

  const project = db.select().from(projects).where(eq(projects.id, projectId)).get();
  const agent = db.select().from(agents).where(eq(agents.id, agentId)).get();
  if (!project || !agent) {
    return { ok: false, code: 404, error: 'Project or agent not found' };
  }
  if (project.killSwitch) {
    return { ok: false, code: 409, error: 'The kill switch is active for this project' };
  }

  const provider = settingsStore.resolve();
  const available = loadTargets(db, projectId);

  let targets = available;
  if (targetIds?.length) {
    const wanted = new Set(targetIds);
    targets = available.filter((t) => wanted.has(t.id));
    if (targets.length !== wanted.size) {
      return {
        ok: false,
        code: 400,
        error: 'One or more selected targets do not belong to this project, or are disabled.',
      };
    }
  }
  if (targets.length === 0) {
    return {
      ok: false,
      code: 400,
      error: 'This project has no enabled targets, so the agent would have nothing to inspect.',
    };
  }

  const tools = bindTools(registry.resolve(agent.toolKeys ?? null), targets);
  const targetSummaries = targets.map((t) => ({
    slug: t.slug,
    kind: t.kind,
    env: t.env as 'dev' | 'staging' | 'prod',
    description: t.description,
  }));

  const system = buildSystemPrompt(project.systemPromptExtra, agent.systemPrompt);

  // Everything the agent's world consists of is frozen here. A later edit to the
  // allowlist, the policy or a target cannot retroactively change what this run was
  // permitted to do -- which is what makes the audit trail mean anything.
  const run = db
    .insert(runs)
    .values({
      projectId,
      agentId,
      trigger: input.trigger ?? 'chat',
      interactive: interactive ?? false,
      triggerPayload: input.triggerPayload ?? { task },
      title: task.slice(0, 120),
      status: 'queued',
      // Resolve through the settings store, not the environment: a provider chosen in
      // the UI must apply to new runs, otherwise the setting appears to save and then
      // silently does nothing.
      providerBaseUrl: provider.baseUrl,
      model: agent.model ?? provider.model,
      systemSnapshot: system,
      toolsSnapshot: tools.map((t) => t.spec),
      targetsSnapshot: targetSummaries,
      policySnapshot: project.riskPolicy,
      deadlineAt: new Date(Date.now() + agent.budget.maxWallClockMs),
      startedBy: input.startedBy ?? null,
      startedAt: new Date(),
    })
    .returning()
    .get();

  // Seq 0 is the system prompt and seq 1 the opening user message, so the whole
  // conversation -- including its framing -- is reconstructible from these rows.
  engine.store.appendStep(run.id, { role: 'system', content: system });
  engine.store.appendStep(run.id, {
    role: 'user',
    content: buildOpeningMessage({
      projectName: project.name,
      targets: targetSummaries,
      task,
      scoped: !!targetIds?.length && targets.length < available.length,
    }),
  });

  worker.nudge();
  return { ok: true, run };
}
