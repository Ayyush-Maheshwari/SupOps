import { eq, inArray, sql } from 'drizzle-orm';
import { saveImages, userContent } from './attachments.ts';
import { agents, knowledgeDocs, projects, runKnowledge, runs } from '@supops/db';
import type { RunTrigger } from '@supops/shared';
import { describeAutonomy } from '@supops/shared';
import {
  bindTools,
  effectiveToolKeys,
  mergePolicy,
  buildKnowledgeContext,
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
  /**
   * No human will be approving (health scans). Anything that needs approval is
   * refused rather than waited on, and `confirm_target` is dropped: the system chose
   * the targets, so there is nothing to confirm and nobody to confirm it.
   */
  unattended?: boolean;
  /** Verified images to send with the opening message (see services/attachments.ts). */
  images?: Parameters<typeof saveImages>[1];
  /** An approved runbook the agent should follow. */
  runbookId?: string | null;
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

  // Cluster targets are just another way to reach infrastructure: an agent allowed to
  // run commands on machines (ssh_exec) may run kubectl on clusters too. Agents saved
  // before cluster targets existed get it here rather than via a data migration.
  const resolved = registry.resolve(effectiveToolKeys(agent.toolKeys ?? null));
  const tools = bindTools(input.unattended ? resolved.filter((d) => d.key !== 'confirm_target') : resolved, targets);
  const targetSummaries = targets.map((t) => ({
    slug: t.slug,
    kind: t.kind,
    env: t.env as 'dev' | 'staging' | 'prod',
    description: t.description,
    ...(t.config.kind === 'ssh' && t.config.addresses?.length ? { addresses: t.config.addresses } : {}),
  }));

  const system = buildSystemPrompt(project.systemPromptExtra, agent.systemPrompt);

  // The project's policy combined with this agent's override (which may raise the
  // agent up to the project ceiling, and can otherwise only tighten).
  const merged = mergePolicy(project.riskPolicy, agent.riskPolicyOverride);
  const policySnapshot = input.unattended ? { ...merged, unattended: true } : merged;

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
      policySnapshot,
      deadlineAt: new Date(Date.now() + agent.budget.maxWallClockMs),
      startedBy: input.startedBy ?? null,
      startedAt: new Date(),
    })
    .returning()
    .get();

  // Seq 0 is the system prompt and seq 1 the opening user message, so the whole
  // conversation -- including its framing -- is reconstructible from these rows.
  engine.store.appendStep(run.id, { role: 'system', content: system });
  // Approved project knowledge in scope for these targets (drafts never reach a run).
  const knowledge = buildKnowledgeContext(db, {
    projectId,
    scope: { targetIds: targets.map((t) => t.id), kinds: [...new Set(targets.map((t) => t.kind))], envs: [...new Set(targets.map((t) => t.env))] },
    task,
    runbookId: input.runbookId ?? null,
  });

  const opening = buildOpeningMessage({
    projectName: project.name,
    targets: targetSummaries,
    task,
    scoped: !!targetIds?.length && targets.length < available.length,
    autonomy: input.unattended
      ? 'This run is unattended: only read-only actions run, and anything that would need approval is refused.'
      : describeAutonomy(policySnapshot, input.trigger ?? 'chat'),
    knowledge: knowledge.block,
  });
  const imageIds = input.images?.length ? saveImages(run.id, input.images, input.startedBy ?? null) : [];
  engine.store.appendStep(run.id, { role: 'user', content: userContent(opening, imageIds) });
  if (knowledge.used.length) {
    for (const u of knowledge.used) db.insert(runKnowledge).values({ runId: run.id, docId: u.docId, via: u.via }).run();
    db.update(knowledgeDocs)
      .set({ useCount: sql`${knowledgeDocs.useCount} + 1`, lastUsedAt: new Date() })
      .where(inArray(knowledgeDocs.id, knowledge.used.map((u) => u.docId)))
      .run();
  }

  worker.nudge();
  return { ok: true, run };
}
