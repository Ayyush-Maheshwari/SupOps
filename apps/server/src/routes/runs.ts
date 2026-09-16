import { Router } from 'express';
import { and, asc, desc, eq, inArray, lt, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  agents,
  projects,
  runEvents,
  runSteps,
  runs,
  toolCalls,
  users,
} from '@supops/db';
import {
  reportSystemPrompt,
  buildRcaPdfDefinition,
  buildRunDigest,
  buildShareableMarkdown,
  renderPdf,
  reportFilename,
} from '@supops/core';
import { db, engine, llm } from '../context.ts';
import { worker } from '../worker.ts';
import { startRun } from '../services/start-run.ts';

export const runRoutes = Router();

runRoutes.get('/', (req, res) => {
  const projectId = String(req.query.projectId ?? '');
  const rows = projectId
    ? db.select().from(runs).where(eq(runs.projectId, projectId)).orderBy(desc(runs.startedAt)).limit(100).all()
    : db.select().from(runs).orderBy(desc(runs.startedAt)).limit(100).all();

  // Fetch every run's actions in ONE query rather than per row. The list view draws
  // a risk fingerprint for each run, and an N+1 here would make the page cost grow
  // with history.
  const ids = rows.map((r) => r.id);
  const actionsByRun = new Map<string, Array<{ tier: string | null; state: string; toolKey: string; command: string | null }>>();
  // Which machines a run actually touched -- so the list shows those, not the whole
  // frozen scope (which, for a jump, is every VM behind it and drowns the row).
  const actedByRun = new Map<string, Set<string>>();
  if (ids.length) {
    for (const c of db
      .select({
        runId: toolCalls.runId,
        tier: toolCalls.tier,
        state: toolCalls.state,
        toolKey: toolCalls.toolKey,
        command: toolCalls.renderedCommand,
        target: sql<string | null>`json_extract(${toolCalls.argsJson}, '$.target')`,
      })
      .from(toolCalls)
      .where(inArray(toolCalls.runId, ids))
      .orderBy(asc(toolCalls.createdAt))
      .all()) {
      const list = actionsByRun.get(c.runId) ?? [];
      list.push({ tier: c.tier, state: c.state, toolKey: c.toolKey, command: c.command });
      actionsByRun.set(c.runId, list);
      if (c.target) {
        const set = actedByRun.get(c.runId) ?? new Set<string>();
        set.add(c.target);
        actedByRun.set(c.runId, set);
      }
    }
  }

  // The snapshots are large and only useful on the detail view.
  res.json(
    rows.map(({ systemSnapshot, toolsSnapshot, targetsSnapshot, ...r }) => {
      const snapshot = targetsSnapshot ?? [];
      const acted = [...(actedByRun.get(r.id) ?? [])];
      // Show what was actually touched; if nothing ran, show the direct/jump targets
      // (snapshot entries that are not "Behind <jump>" machines) rather than all VMs.
      const primaries = snapshot.filter((t) => !/^Behind\s/.test(t.description ?? '')).map((t) => t.slug);
      // Always show the jump/direct target(s); add any behind-a-jump VMs actually
      // acted on. This keeps the entry point visible even when the work happened on
      // a VM one hop away.
      const base = primaries.length ? primaries : snapshot.map((t) => t.slug);
      const targets = [...new Set([...base, ...acted])];
      return { ...r, targets, actions: actionsByRun.get(r.id) ?? [] };
    }),
  );
});

const startBody = z.object({
  projectId: z.string().min(1),
  agentId: z.string().min(1),
  task: z.string().min(1).max(10_000),
  /** Console sessions stay open after each turn instead of ending. */
  interactive: z.boolean().optional(),
  /**
   * Restrict this run to specific targets. Omit or leave empty for every target in
   * the project. Scoping is enforced by building the tool schemas from only these
   * targets, so anything outside the selection is unrepresentable in a tool call --
   * not merely discouraged by the prompt.
   */
  targetIds: z.array(z.string()).optional(),
});

runRoutes.post('/', (req, res) => {
  const parsed = startBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Invalid run' });
    return;
  }
  const { projectId, agentId, task, targetIds, interactive } = parsed.data;

  const result = startRun({
    projectId,
    agentId,
    task,
    targetIds,
    interactive,
    trigger: 'chat',
    startedBy: req.user?.id ?? null,
  });
  if (!result.ok) {
    res.status(result.code).json({ error: result.error });
    return;
  }
  res.status(201).json(result.run);
});

/** Everything the run detail view needs, in one round trip. */
runRoutes.get('/:id', (req, res) => {
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  const calls = db.select().from(toolCalls).where(eq(toolCalls.runId, run.id)).orderBy(asc(toolCalls.callIndex)).all();
  res.json({
    run,
    steps: db.select().from(runSteps).where(eq(runSteps.runId, run.id)).orderBy(asc(runSteps.seq)).all(),
    // Resolve approver ids to names so the run page can show WHO decided each action,
    // not an opaque id.
    toolCalls: withApproverNames(calls),
    events: db.select().from(runEvents).where(eq(runEvents.runId, run.id)).orderBy(asc(runEvents.seq)).all(),
  });
});

/** Attach `decidedByName` to any decided tool calls, resolving ids to display names. */
function withApproverNames<T extends { decidedBy: string | null }>(calls: T[]): Array<T & { decidedByName: string | null }> {
  const ids = [...new Set(calls.map((c) => c.decidedBy).filter((x): x is string => !!x))];
  const names = new Map<string, string>();
  if (ids.length) {
    for (const u of db.select().from(users).where(inArray(users.id, ids)).all()) {
      names.set(u.id, u.name || u.email);
    }
  }
  return calls.map((c) => ({ ...c, decidedByName: c.decidedBy ? (names.get(c.decidedBy) ?? c.decidedBy) : null }));
}

/**
 * Decided-approval history for a project, newest first -- the at-a-glance "which
 * account approved what" an admin wants. Read straight from the execution record.
 */
runRoutes.get('/approvals/history', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }
  const rows = db
    .select({ toolCall: toolCalls, runId: runs.id, runTitle: runs.title })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.runId, runs.id))
    .where(and(eq(runs.projectId, projectId), inArray(toolCalls.state, ['approved', 'denied', 'succeeded', 'failed'])))
    .orderBy(desc(toolCalls.decidedAt))
    .limit(100)
    .all()
    .filter((r) => r.toolCall.decidedBy);

  const named = withApproverNames(rows.map((r) => r.toolCall));
  res.json(
    rows.map((r, i) => ({
      id: r.toolCall.id,
      runId: r.runId,
      runTitle: r.runTitle,
      toolKey: r.toolCall.toolKey,
      renderedCommand: r.toolCall.renderedCommand,
      tier: r.toolCall.tier,
      verdict: r.toolCall.state === 'denied' || r.toolCall.state === 'expired' ? 'denied' : 'approved',
      decidedByName: named[i]!.decidedByName,
      decidedAt: r.toolCall.decidedAt,
      decisionComment: r.toolCall.decisionComment,
    })),
  );
});

/** Replay for a reconnecting client. */
runRoutes.get('/:id/events', (req, res) => {
  const after = Number(req.query.after ?? -1);
  res.json(engine.store.listEvents(req.params.id, Number.isFinite(after) ? after : -1));
});

runRoutes.post('/:id/cancel', (req, res) => {
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  engine.cancel(run.id);
  res.json({ ok: true });
});

/**
 * The approval queue, scoped to one project. Without the `projectId` filter this
 * returned every waiting call in the database, so approvals raised in one project
 * showed up in every other project's badge and could never be cleared from there.
 * Calls whose parent run is no longer active are dropped too: a run cancelled or
 * failed while a call sat pending leaves a row nobody can resolve.
 */
const ACTIVE_FOR_APPROVAL = ['running', 'awaiting_approval', 'suspended', 'queued'] as const;

runRoutes.get('/approvals/pending', (req, res) => {
  const projectId = typeof req.query.projectId === 'string' ? req.query.projectId : null;
  if (!projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }

  const rows = db
    .select({ toolCall: toolCalls, run: runs })
    .from(toolCalls)
    .innerJoin(runs, eq(toolCalls.runId, runs.id))
    .where(
      and(
        eq(toolCalls.state, 'awaiting_approval'),
        eq(runs.projectId, projectId),
        inArray(runs.status, [...ACTIVE_FOR_APPROVAL]),
      ),
    )
    .all();

  res.json(
    rows.map(({ toolCall, run }) => {
      const { systemSnapshot, toolsSnapshot, targetsSnapshot, ...rest } = run;
      return { toolCall, run: rest };
    }),
  );
});

const decisionBody = z.object({
  decision: z.enum(['approve', 'deny']),
  comment: z.string().max(1000).optional(),
});

/**
 * The moment the product exists for. A human decides, the call flips state, and the
 * run goes back in the queue -- where the engine rebuilds the entire conversation
 * from SQLite and carries on. The decision may be minutes or days later, across any
 * number of restarts; nothing about the resume path cares.
 */
runRoutes.post('/tool-calls/:id/decision', (req, res) => {
  const parsed = decisionBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'decision must be "approve" or "deny"' });
    return;
  }

  const call = db.select().from(toolCalls).where(eq(toolCalls.id, req.params.id)).get();
  if (!call) {
    res.status(404).json({ error: 'Tool call not found' });
    return;
  }
  if (call.state !== 'awaiting_approval') {
    res.status(409).json({ error: `This call is already ${call.state}; it cannot be decided again` });
    return;
  }

  const approved = parsed.data.decision === 'approve';
  db.transaction((tx) => {
    tx.update(toolCalls)
      .set({
        state: approved ? 'approved' : 'denied',
        decidedBy: req.user?.id ?? null,
        decidedAt: new Date(),
        decisionComment: parsed.data.comment ?? null,
        ...(approved ? {} : { isError: true, finishedAt: new Date() }),
      })
      .where(and(eq(toolCalls.id, call.id), eq(toolCalls.state, 'awaiting_approval')))
      .run();

    tx.update(runs)
      .set({ status: 'queued', statusReason: null })
      .where(eq(runs.id, call.runId))
      .run();
  });

  engine.store.appendEvent(call.runId, {
    type: 'approval_decided',
    toolCallId: call.toolCallId,
    decision: approved ? 'approved' : 'denied',
    by: req.user?.name ?? 'operator',
  });

  worker.nudge();
  res.json({ ok: true, state: approved ? 'approved' : 'denied' });
});

/**
 * Active runs must be stopped before they can be removed. `awaiting_input` is not
 * here: a parked session has nothing in flight, and refusing to delete it left old
 * console sessions permanently stuck in the list with no way to clear them.
 */
const ACTIVE_STATUSES = ['queued', 'running', 'awaiting_approval', 'suspended'] as const;

/**
 * Bulk-remove finished runs.
 *
 * Deliberately refuses to touch anything still in flight: deleting a run that is
 * mid-command would orphan a dispatched tool call and lose the record of what was
 * already done to a machine. Cancel it first. Steps, tool calls and events cascade.
 */
runRoutes.post('/prune', (req, res) => {
  const { projectId, olderThanDays } = req.body ?? {};
  if (typeof projectId !== 'string' || !projectId) {
    res.status(400).json({ error: 'projectId is required' });
    return;
  }

  const filters = [
    eq(runs.projectId, projectId),
    notInArray(runs.status, [...ACTIVE_STATUSES]),
  ];
  if (typeof olderThanDays === 'number' && olderThanDays > 0) {
    filters.push(lt(runs.startedAt, new Date(Date.now() - olderThanDays * 86_400_000)));
  }

  const doomed = db.select({ id: runs.id }).from(runs).where(and(...filters)).all();
  if (doomed.length === 0) {
    res.json({ deleted: 0 });
    return;
  }

  db.delete(runs).where(inArray(runs.id, doomed.map((r) => r.id))).run();
  res.json({ deleted: doomed.length });
});

runRoutes.delete('/:id', (req, res) => {
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  if ((ACTIVE_STATUSES as readonly string[]).includes(run.status)) {
    res.status(409).json({
      error: `This run is ${run.status}. Cancel it before deleting, so nothing is left mid-flight.`,
    });
    return;
  }

  db.delete(runs).where(eq(runs.id, run.id)).run();
  res.json({ ok: true });
});

/**
 * The incident document for a run.
 *
 * Served as Markdown so it can be pasted into a ticket, a wiki or a postmortem
 * template without conversion, and so the download and the clipboard copy are
 * byte-identical -- the browser never assembles its own version.
 */
runRoutes.get('/:id/report', async (req, res) => {
  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }

  const project = db.select().from(projects).where(eq(projects.id, run.projectId)).get();
  const agent = db.select().from(agents).where(eq(agents.id, run.agentId)).get();
  const steps = db
    .select()
    .from(runSteps)
    .where(and(eq(runSteps.runId, run.id), eq(runSteps.state, 'committed')))
    .orderBy(asc(runSteps.seq))
    .all();
  const calls = db
    .select()
    .from(toolCalls)
    .where(eq(toolCalls.runId, run.id))
    .orderBy(asc(toolCalls.createdAt))
    .all();

  // Resolve approver ids to names so the document reads as a record of who decided
  // what, rather than a list of opaque identifiers.
  const approverIds = [...new Set(calls.map((c) => c.decidedBy).filter((x): x is string => !!x))];
  const approverNames: Record<string, string> = {};
  if (approverIds.length) {
    for (const u of db.select().from(users).where(inArray(users.id, approverIds)).all()) {
      approverNames[u.id] = u.name || u.email;
    }
  }

  const reportInput = {
    run: {
      id: run.id,
      title: run.title,
      status: run.status,
      statusReason: run.statusReason,
      model: run.model,
      iteration: run.iteration,
      promptTokens: run.promptTokens,
      completionTokens: run.completionTokens,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      targetsSnapshot: run.targetsSnapshot,
    },
    steps: steps.map((s) => ({ seq: s.seq, messageJson: s.messageJson })),
    toolCalls: calls.map((c) => ({
      toolKey: c.toolKey,
      callIndex: c.callIndex,
      renderedCommand: c.renderedCommand,
      argsJson: c.argsJson,
      tier: c.tier,
      riskJson: c.riskJson,
      state: c.state,
      resultJson: c.resultJson,
      isError: c.isError,
      decidedBy: c.decidedBy,
      decisionComment: c.decisionComment,
      startedAt: c.startedAt,
      finishedAt: c.finishedAt,
    })),
    projectName: project?.name ?? 'Unknown project',
    agentName: agent?.name ?? 'Unknown agent',
    approverNames,
    // Health runs (scheduled or manual scans, and issue investigations) get the
    // thorough per-target report; everything else the concise incident RCA.
    kind: (run.trigger === 'health' ? 'health' : 'incident') as 'health' | 'incident',
  };

  const base = reportFilename({ title: run.title, startedAt: run.startedAt });

  // Let the model write the shareable narrative -- selecting what matters and
  // arranging it -- from a factual digest of the run. Falls back to the mechanical
  // document if the provider is unavailable, so a report is always produced.
  let aiBody: string | null = null;
  try {
    const result = await llm.complete(
      [
        { role: 'system', content: reportSystemPrompt(reportInput.kind) },
        { role: 'user', content: buildRunDigest(reportInput) },
      ],
      [],
      // A health sweep across several targets needs more room than a single RCA.
      { maxTokens: reportInput.kind === 'health' ? 3000 : 1800, temperature: 0.2 },
    );
    aiBody = typeof result.message.content === 'string' ? result.message.content : null;
  } catch (err) {
    console.warn('report: model summary unavailable, using mechanical document:', err instanceof Error ? err.message : err);
  }

  // PDF is the shareable artefact; Markdown is what you paste into a ticket. Both
  // are built from the same structured input rather than one from the other, so a
  // formatting quirk in one cannot silently change what the other reports.
  if (req.query.format === 'pdf') {
    const pdf = await renderPdf(buildRcaPdfDefinition(reportInput, aiBody));
    const filename = base.replace(/\.md$/, '.pdf');
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', String(pdf.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.end(pdf);
    return;
  }

  const markdown = buildShareableMarkdown(reportInput, aiBody);
  if (req.query.download === '1') {
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${base}"`);
    res.send(markdown);
    return;
  }
  res.json({ filename: base, markdown });
});

const messageBody = z.object({ message: z.string().min(1).max(10_000) });

/**
 * Continue an open session.
 *
 * Appends a user turn and puts the run back in the queue. No new resume machinery is
 * needed: the conversation was always a pure function of the database, so the engine
 * rebuilds the whole history and carries on -- across a restart if need be.
 */
runRoutes.post('/:id/message', (req, res) => {
  const parsed = messageBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const run = db.select().from(runs).where(eq(runs.id, req.params.id)).get();
  if (!run) {
    res.status(404).json({ error: 'Run not found' });
    return;
  }
  // A follow-up is allowed once the run has finished a turn -- an interactive
  // Console session parked at `awaiting_input`, or any run (an investigation
  // included) that reached `succeeded`. The whole conversation replays from the
  // steps, so continuing an investigation just adds another turn on top of it.
  if (run.status !== 'awaiting_input' && run.status !== 'succeeded') {
    res.status(409).json({
      error: `This run is ${run.status}. You can follow up once it has finished.`,
    });
    return;
  }

  engine.store.appendStep(run.id, { role: 'user', content: parsed.data.message });
  engine.store.resumeWithInput(run.id);
  worker.nudge();

  res.status(201).json({ ok: true });
});
