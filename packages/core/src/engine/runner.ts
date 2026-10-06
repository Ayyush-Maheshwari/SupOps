import { and, asc, eq } from 'drizzle-orm';
import type { ChatMessage, ToolCallRequest, ToolMessage } from '@supops/shared';
import { isTerminalToolCall, tierAtMost } from '@supops/shared';
import type { Db, RunBudget } from '@supops/db';
import { DEFAULT_MAX_OUTPUT_TOKENS, DEFAULT_SESSION_TOOL_CALLS, agents, projects, toolCalls as toolCallsTable } from '@supops/db';
import type { LLMClient } from '../llm/client.ts';
import { backoffMs } from '../llm/client.ts';
import { FatalLLMError, RetryableLLMError } from '../llm/errors.ts';
import type { ResolvedTool } from '../tools/types.ts';
import { bindTools, effectiveToolKeys, type ToolRegistry } from '../tools/registry.ts';
import { assessRisk } from '../risk/index.ts';
import type { EventSink, OutputSink } from './events.ts';
import { nullOutputSink } from './events.ts';
import { executeToolCall, ToolExecutionRefused } from './execute.ts';
import { DEFAULT_CONTEXT_TOKENS, fitToContext } from './context.ts';
import { signatureOf } from '../learning/signature.ts';
import { hashArgs, targetFingerprint } from './canonical.ts';
import { loadTargets } from './targets.ts';
import { isNetworkTarget, netCheckTool, NETWORK_TARGET } from '../tools/net-check.ts';
import { RunStore, type RunRow, type ToolCallRow } from './store.ts';

const LEASE_TTL_MS = 60_000;
/** Three identical attempts is a wedged agent, not persistence. */
const DUPLICATE_LIMIT = 3;
/** Automatic "continue" prompts after a reply was cut off, per turn. */
const MAX_CONTINUATIONS = 2;
/**
 * Give up after this many consecutive provider failures. A free-tier daily quota can
 * take hours to reset, and a run that silently retries forever is indistinguishable
 * from one that is hung -- better to fail with a message that names the cause.
 */
const MAX_PROVIDER_RETRIES = 8;

export interface EngineOptions {
  db: Db;
  llm: LLMClient;
  registry: ToolRegistry;
  sink: EventSink;
  /** Optional live command output. Omitted, execution is unchanged. */
  output?: OutputSink;
  workerId: string;
}

export class Engine {
  readonly store: RunStore;
  private db: Db;
  private llm: LLMClient;
  private registry: ToolRegistry;
  private sink: EventSink;
  private output: OutputSink;
  private workerId: string;
  private aborts = new Map<string, AbortController>();

  constructor(opts: EngineOptions) {
    this.db = opts.db;
    this.store = new RunStore(opts.db);
    this.llm = opts.llm;
    this.registry = opts.registry;
    this.sink = opts.sink;
    this.output = opts.output ?? nullOutputSink;
    this.workerId = opts.workerId;
  }

  /** Cooperative cancellation for an in-flight tool call. */
  cancel(runId: string): void {
    this.aborts.get(runId)?.abort();
    this.store.setStatus(runId, 'cancelled', 'cancelled by an operator');
    this.event(runId, { type: 'status', status: 'cancelled', reason: 'cancelled by an operator' });
  }

  /**
   * Drive a run until it can make no further progress without waiting for
   * something -- a human decision, a backoff timer, or the end of the task.
   *
   * The loop is written so that every iteration starts by re-reading state from the
   * database. That is what makes a crash survivable: there is no progress held in a
   * local variable that a restart would lose.
   */
  async runToCompletion(runId: string): Promise<void> {
    if (!this.store.acquireLease(runId, this.workerId, LEASE_TTL_MS)) return;

    const abort = new AbortController();
    this.aborts.set(runId, abort);
    const heartbeat = setInterval(
      () => this.store.heartbeat(runId, this.workerId, LEASE_TTL_MS),
      LEASE_TTL_MS / 4,
    );

    try {
      for (;;) {
        const progressed = await this.tick(runId, abort.signal);
        if (!progressed) break;
      }
    } finally {
      clearInterval(heartbeat);
      this.aborts.delete(runId);
      this.store.releaseLease(runId, this.workerId);
    }
  }

  /** One unit of progress. Returns false when the run is waiting or finished. */
  private async tick(runId: string, signal: AbortSignal): Promise<boolean> {
    const run = this.store.getRun(runId);
    if (!run || run.status !== 'running') return false;

    const ctx = this.loadContext(run);
    if (!ctx) {
      this.fail(runId, 'the run references an agent or project that no longer exists');
      return false;
    }

    if (ctx.killSwitch) {
      this.store.setStatus(runId, 'halted', 'the project kill switch is active');
      this.event(runId, { type: 'status', status: 'halted', reason: 'kill switch active' });
      return false;
    }
    if (this.overBudget(run, ctx.budget)) return false;

    // --- Phase A: settle any tool calls left outstanding -------------------
    const open = this.store.getUnsettledToolCalls(runId);
    if (open.length > 0) {
      for (const call of open) {
        if (signal.aborted) return false;
        await this.settleCall(run, ctx, call, signal);
      }

      const after = this.store.getUnsettledToolCalls(runId);
      if (after.some((c) => c.state === 'awaiting_approval')) {
        this.store.setStatus(runId, 'awaiting_approval', 'waiting for a human decision');
        this.event(runId, {
          type: 'status',
          status: 'awaiting_approval',
          reason: 'waiting for a human decision',
        });
        return false;
      }
      if (after.length > 0) return true; // still working; come back round
    }

    // --- Phase B: close any complete-but-unreplied batch -------------------
    if (this.commitOpenBatch(runId)) return true;

    // --- Phase C: ask the model what to do next ---------------------------
    return await this.step(run, ctx, signal);
  }

  // ------------------------------------------------------------------
  // Phase C -- one model turn
  // ------------------------------------------------------------------

  private async step(run: RunRow, ctx: RunContext, signal: AbortSignal): Promise<boolean> {
    // Old command output is elided on the wire once the conversation outgrows the
    // budget; the stored history is untouched.
    const { messages } = fitToContext(this.store.wireMessages(run.id), ctx.budget.contextTokens ?? DEFAULT_CONTEXT_TOKENS);

    // A run records the model it started with, but the provider can be changed from
    // the UI while a run is parked at an approval gate. Sending a Gemini model name
    // to a local Ollama server 404s, so when the endpoint has moved we follow it
    // rather than replaying a name that no longer means anything.
    const providerMoved = run.providerBaseUrl !== this.llm.config.baseUrl;
    const model = providerMoved ? this.llm.config.model : run.model;

    let result;
    try {
      result = await this.llm.complete(messages, run.toolsSnapshot, {
        model,
        maxTokens: ctx.budget.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      });
    } catch (err) {
      if (err instanceof RetryableLLMError) {
        const attempt = run.retryCount + 1;
        if (attempt > MAX_PROVIDER_RETRIES) {
          this.fail(
            run.id,
            `${err.message} -- gave up after ${MAX_PROVIDER_RETRIES} attempts. ` +
              (err.status === 429
                ? 'The provider is rate limiting this key. Check your quota, lower run concurrency, or switch to a local model in Settings.'
                : 'The provider has been unavailable; try again later.'),
          );
          return false;
        }

        // Back off exponentially, but never retry sooner than the provider asked.
        // A flat interval against a rate limit just keeps the limit tripped.
        const delay = Math.max(err.retryAfterMs, backoffMs(attempt));
        const at = new Date(Date.now() + delay);

        // Park durably rather than sleeping: a setTimeout would not survive a deploy,
        // and free-tier daily limits can mean waiting a long time.
        this.store.suspendUntil(run.id, at, err.message, attempt);
        this.event(run.id, {
          type: 'status',
          status: 'suspended',
          reason: `${err.message} -- attempt ${attempt}/${MAX_PROVIDER_RETRIES}, retrying in ${Math.round(delay / 1000)}s`,
        });
        return false;
      }
      this.fail(run.id, err instanceof FatalLLMError ? err.message : String(err));
      return false;
    }

    if (signal.aborted) return false;

    // The provider answered, so any accumulated backoff is stale.
    if (run.retryCount > 0) this.store.clearRetries(run.id);

    const step = this.store.appendStep(run.id, result.message, {
      finishReason: result.finishReason,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      latencyMs: result.latencyMs,
    });
    this.store.bumpIteration(run.id, result.promptTokens, result.completionTokens);

    if (result.message.content) {
      this.event(run.id, { type: 'assistant_text', text: result.message.content });
    }

    const requested = result.message.tool_calls ?? [];
    const cutOff = result.finishReason === 'length';

    // The reply hit the output limit mid-answer. Ask it to carry on rather than
    // presenting half an answer as the conclusion -- at most twice per turn, so a
    // model that keeps rambling cannot loop.
    if (cutOff && requested.length === 0 && this.store.engineStepsThisTurn(run.id) < MAX_CONTINUATIONS) {
      this.store.appendStep(
        run.id,
        { role: 'user', content: '[SupOps] Your last reply was cut off by the output length limit. Continue exactly where you stopped; do not repeat what you already wrote.' },
        { origin: 'engine' },
      );
      return true;
    }

    if (requested.length === 0) {
      // A one-shot run is done. An interactive session is only done with *this*
      // turn -- it parks and waits for the next message, which `rebuildMessages`
      // will pick up with the whole conversation intact.
      //
      // Except when nothing in the turn worked. A session whose every action was
      // blocked by policy or errored has nothing to follow up on, so parking it at
      // "waiting for input" describes a conversation that is never going to happen
      // and leaves the run un-deletable. Such a turn ends the session as failed.
      if (run.interactive) {
        const dead = this.deadTurnReason(run.id);
        if (dead) {
          this.fail(run.id, dead);
          return false;
        }
      }

      // Interactive sessions end their turn as `succeeded` too. They stay
      // resumable -- posting a message revives a succeeded session -- but there is
      // no separate parked state to get stuck in, and the run is terminal, so it
      // can be deleted like any other.
      const next = 'succeeded';
      this.store.setStatus(run.id, next);
      this.event(run.id, { type: 'status', status: next });
      return false;
    }

    this.store.createToolCalls(
      run.id,
      step.id,
      requested.map((c, i) => {
        const args = parseArgs(c);
        // A call whose arguments were cut off by the output limit is marked so the
        // model is told why it failed, instead of a baffling "invalid arguments".
        if (cutOff && '__parse_error' in args) args.__truncated = true;
        return {
          toolCallId: c.id,
          callIndex: i,
          toolKey: c.function.name,
          argsJson: args,
          argsHash: hashArgs(args),
        };
      }),
    );

    for (const c of requested) {
      this.event(run.id, {
        type: 'tool_call',
        toolCallId: c.id,
        toolKey: c.function.name,
        target: (parseArgs(c).target as string) ?? null,
        rendered: '',
      });
    }
    return true;
  }

  // ------------------------------------------------------------------
  // Phase A -- classify and execute one call
  // ------------------------------------------------------------------

  private async settleCall(
    run: RunRow,
    ctx: RunContext,
    call: ToolCallRow,
    signal: AbortSignal,
  ): Promise<void> {
    if (call.state === 'proposed') {
      const classified = this.classify(run, ctx, call);
      if (!classified) return; // classify() already marked it blocked
    }

    const current = this.store.getToolCall(call.id);
    if (!current || isTerminalToolCall(current.state)) return;
    if (current.state === 'awaiting_approval') return;
    if (current.state !== 'auto_approved' && current.state !== 'approved') return;

    const tool = ctx.tools.find((t) => t.def.key === current.toolKey);
    const target = tool?.targetsBySlug.get(String(current.argsJson.target));
    if (!tool || !target) {
      this.blockCall(current, `target "${String(current.argsJson.target)}" is not available`);
      return;
    }

    this.event(run.id, { type: 'tool_started', toolCallId: current.toolCallId });

    let output;
    try {
      output = await executeToolCall(
        {
          db: this.db,
          store: this.store,
          killSwitchActive: () => !!this.store.getRun(run.id) && ctx.killSwitch,
          maxOutputBytes: ctx.budget.maxOutputBytesPerCall,
          onChunk: (chunk) => this.output.chunk(run.id, current.toolCallId, chunk),
        },
        {
          call: current,
          tool,
          target,
          projectId: run.projectId,
          toolsSnapshotKeys: run.toolsSnapshot.map((t) => t.function.name),
          signal,
        },
      );
    } catch (err) {
      if (err instanceof ToolExecutionRefused) {
        this.blockCall(current, err.message);
        return;
      }
      output = { ok: false, text: `Execution failed: ${err instanceof Error ? err.message : String(err)}` };
    }

    this.store.updateToolCall(current.id, {
      state: output.outcome ?? (output.ok ? 'succeeded' : 'failed'),
      resultJson: output,
      isError: !output.ok,
      exitCode: output.exitCode ?? null,
      finishedAt: new Date(),
    } as never);

    this.event(run.id, {
      type: 'tool_result',
      toolCallId: current.toolCallId,
      ok: output.ok,
      text: output.text,
      ...(output.exitCode !== undefined ? { exitCode: output.exitCode } : {}),
    });
  }

  private classify(run: RunRow, ctx: RunContext, call: ToolCallRow): boolean {
    // Checked first: a cut-off call has no usable arguments at all, target included.
    if (call.argsJson.__truncated) {
      this.blockCall(
        call,
        'your reply hit the output length limit before this call was complete, so it was not run. ' +
          'Split the script or file into smaller pieces and try again.',
      );
      return false;
    }

    const tool = ctx.tools.find((t) => t.def.key === call.toolKey);
    if (!tool) {
      this.blockCall(
        call,
        `"${call.toolKey}" is not an available tool. Use only the tools you were given.`,
      );
      return false;
    }

    const slug = String(call.argsJson.target ?? '');
    const target = tool.targetsBySlug.get(slug);
    if (!target) {
      // Small models invent enum values confidently. This is a routine correction,
      // not an exceptional case -- so say exactly what the valid options are.
      this.blockCall(
        call,
        `"${slug}" is not a registered target for ${call.toolKey}. ` +
          `Valid targets: ${[...tool.targetsBySlug.keys()].join(', ')}.`,
      );
      return false;
    }

    const turnStart = run.interactive ? this.store.lastUserSeq(run.id) : null;
    if (this.store.countIdenticalCalls(run.id, call.toolKey, call.argsHash, turnStart) > DUPLICATE_LIMIT) {
      this.blockCall(
        call,
        `you have attempted this identical action ${DUPLICATE_LIMIT} times and it is now blocked. ` +
          `Change your approach or escalate to a human.`,
      );
      return false;
    }

    const parsed = tool.def.argsSchema.safeParse(call.argsJson);
    if (!parsed.success) {
      this.blockCall(
        call,
        `invalid arguments for ${call.toolKey}: ${parsed.error.issues
          .map((i) => `${i.path.join('.') || '(root)'} ${i.message}`)
          .join('; ')}.`,
      );
      return false;
    }

    const rendered = tool.def.render(parsed.data as never, target);
    const signature = signatureOf(call.toolKey, call.argsJson);

    // Denied once already in this turn: do not ask the same person again.
    if (signature) {
      const denied = this.store
        .toolCallsThisTurn(run.id)
        .find((c) => c.id !== call.id && c.signature === signature && c.state === 'denied');
      if (denied) {
        this.store.updateToolCall(call.id, { signature } as never);
        this.blockCall(
          call,
          `this action was already denied in this turn${denied.decisionComment ? ` ("${denied.decisionComment}")` : ''}. Do not propose it again; take a different approach or ask the operator.`,
        );
        return false;
      }
    }

    const assessment = assessRisk({
      def: tool.def,
      args: call.argsJson,
      rendered,
      target,
      policy: run.policySnapshot,
      trigger: run.trigger,
    });

    this.store.updateToolCall(call.id, {
      state:
        assessment.decision === 'auto'
          ? 'auto_approved'
          : assessment.decision === 'approve'
            ? 'awaiting_approval'
            : 'blocked',
      tier: assessment.tier,
      riskJson: assessment,
      targetFingerprint: targetFingerprint(target),
      signature,
      renderedCommand: rendered,
      // The SupOps server is not a row in targets (and the column is a foreign key).
      targetId: isNetworkTarget(target) ? null : target.id,
    } as never);

    this.event(run.id, {
      type: 'tool_classified',
      toolCallId: call.toolCallId,
      tier: assessment.tier,
      assessment,
    });

    if (assessment.decision === 'block') {
      const why = assessment.contributions
        .filter((c) => c.tier === 'forbidden')
        .map((c) => c.reason)
        .join('; ');
      this.store.updateToolCall(call.id, {
        resultJson: {
          ok: false,
          text: `BLOCKED: ${why || 'this action is forbidden'}. No approval can authorise it.`,
        },
        isError: true,
        finishedAt: new Date(),
      } as never);
      this.event(run.id, { type: 'tool_blocked', toolCallId: call.toolCallId, reason: why });
      return false;
    }

    if (assessment.decision === 'approve' && run.policySnapshot.unattended) {
      const why = assessment.contributions
        .filter((c) => c.tier === assessment.tier)
        .map((c) => c.reason)
        .join('; ');
      this.blockCall(
        call,
        `NOT RUN: this is an unattended run and this action needs a human's approval ` +
          `(${assessment.tier}${why ? `: ${why}` : ''}). Use a standard read-only command ` +
          `instead, or record that it could not be checked.`,
      );
      return false;
    }

    if (assessment.decision === 'approve') {
      this.event(run.id, {
        type: 'approval_required',
        toolCallId: call.toolCallId,
        tier: assessment.tier,
        rendered,
      });
      return false;
    }

    return true;
  }

  private blockCall(call: ToolCallRow, reason: string): void {
    this.store.updateToolCall(call.id, {
      state: 'blocked',
      resultJson: { ok: false, text: reason },
      isError: true,
      finishedAt: new Date(),
    } as never);
    this.event(call.runId, { type: 'tool_blocked', toolCallId: call.toolCallId, reason });
  }

  // ------------------------------------------------------------------
  // Phase B -- materialise a completed batch of tool replies
  // ------------------------------------------------------------------

  /**
   * Invariant A. Replies for one assistant turn are written all at once, and only
   * once every sibling call has reached a terminal state. A conversation containing
   * an assistant turn with N tool_calls and fewer than N replies is malformed, and
   * the failure mode is nastier than an error: several backends accept it and
   * silently produce a worse agent.
   */
  private commitOpenBatch(runId: string): boolean {
    const pending = this.db
      .select()
      .from(toolCallsTable)
      .where(and(eq(toolCallsTable.runId, runId), eq(toolCallsTable.replyCommitted, false)))
      .orderBy(asc(toolCallsTable.callIndex))
      .all();

    if (pending.length === 0) return false;

    const batchStepId = pending[0]!.stepId;
    const batch = pending.filter((c) => c.stepId === batchStepId);
    if (!batch.every((c) => isTerminalToolCall(c.state))) return false;

    const replies: ChatMessage[] = batch
      .sort((a, b) => a.callIndex - b.callIndex)
      .map((c) => toReply(c));

    this.store.commitToolResults(runId, replies);
    for (const c of batch) {
      this.store.updateToolCall(c.id, { replyCommitted: true } as never);
    }
    return true;
  }

  // ------------------------------------------------------------------

  private loadContext(run: RunRow): RunContext | null {
    const agent = this.db.select().from(agents).where(eq(agents.id, run.agentId)).get();
    const project = this.db.select().from(projects).where(eq(projects.id, run.projectId)).get();
    if (!agent || !project) return null;

    // The run's frozen snapshots are the boundary, not the project's current state.
    // Binding every project target here let a run scoped to one host reach any other
    // host by slug: the tool enum sent to the model is only a hint, and the model
    // can type any name. Same for tools: only what the run was started with.
    const inScope = new Set(run.targetsSnapshot.map((t) => t.slug));
    const targets = loadTargets(this.db, run.projectId).filter((t) => inScope.has(t.slug));
    const snapshotKeys = run.toolsSnapshot.map((t) => t.function.name);
    // An advisory run was started with no tools on purpose; an empty snapshot must
    // not fall back to the agent's tool list below.
    // An advisory run has no targets; its only possible tool is net_check, on the
    // virtual SupOps-server target, and only if the run was started with it.
    if (run.policySnapshot.advisory) {
      const checks = run.policySnapshot.networkChecks && snapshotKeys.includes(netCheckTool.key);
      return {
        budget: agent.budget,
        killSwitch: project.killSwitch,
        tools: checks ? bindTools([netCheckTool as never], [NETWORK_TARGET]) : [],
      };
    }
    const defs = snapshotKeys.length
      ? snapshotKeys.map((k) => this.registry.get(k)).filter((d): d is NonNullable<typeof d> => !!d)
      : this.registry.resolve(effectiveToolKeys(agent.toolKeys ?? null));

    return {
      budget: agent.budget,
      killSwitch: project.killSwitch,
      tools: bindTools(defs, targets),
    };
  }

  private overBudget(run: RunRow, budget: RunBudget): boolean {
    if (run.iteration >= budget.maxIterations) {
      this.fail(run.id, `reached the maximum of ${budget.maxIterations} reasoning steps`);
      return true;
    }
    // A one-shot run's budget is the whole run. An interactive session's is per turn
    // (iterations and the wall clock are already reset by resumeWithInput), with a
    // session-wide ceiling as the backstop.
    const calls = run.interactive ? this.store.toolCallsThisTurn(run.id).length : this.store.countToolCalls(run.id);
    if (calls >= budget.maxToolCalls) {
      this.fail(run.id, `reached the maximum of ${budget.maxToolCalls} tool calls${run.interactive ? ' in this turn' : ''}`);
      return true;
    }
    const sessionCap = budget.maxSessionToolCalls ?? DEFAULT_SESSION_TOOL_CALLS;
    if (run.interactive && this.store.countToolCalls(run.id) >= sessionCap) {
      this.fail(run.id, `reached the session maximum of ${sessionCap} tool calls; start a new session`);
      return true;
    }
    if (run.deadlineAt && run.deadlineAt.getTime() < Date.now()) {
      this.fail(run.id, 'exceeded the wall-clock budget for this run');
      return true;
    }
    return false;
  }

  /**
   * Why this turn was a dead end, or null if any part of it got through. Only
   * every-call-failed counts: a turn where one command worked and another did not
   * still leaves the human something to act on, so the session ends normally.
   */
  private deadTurnReason(runId: string): string | null {
    // `record_finding` only writes to the run's own notes, so it succeeds even when
    // every command failed. Counting it would mask exactly the turns this catches.
    const batch = this.store
      .toolCallsThisTurn(runId)
      .filter((c) => c.toolKey !== 'record_finding');
    if (batch.length === 0) return null;
    if (!batch.every((c) => c.state === 'blocked' || c.state === 'failed' || c.state === 'denied'))
      return null;

    const blocked = batch.filter((c) => c.state === 'blocked').length;
    const denied = batch.filter((c) => c.state === 'denied').length;
    const n = batch.length;
    const what = n === 1 ? 'The action' : `All ${n} actions`;
    if (blocked === n) return `${what} in this turn ${n === 1 ? 'was' : 'were'} blocked by policy.`;
    if (denied === n) return `${what} in this turn ${n === 1 ? 'was' : 'were'} rejected.`;
    return `${what} in this turn failed. The last error is in the transcript.`;
  }

  private fail(runId: string, reason: string): void {
    this.store.setStatus(runId, 'failed', reason);
    this.event(runId, { type: 'status', status: 'failed', reason });
  }

  private event(runId: string, payload: Parameters<EventSink['emit']>[2]): void {
    // Persist first, emit second: a client must never see an event the database
    // does not know about, or replay after a reconnect would silently lose it.
    const seq = this.store.appendEvent(runId, payload);
    this.sink.emit(runId, seq, payload);
  }
}

interface RunContext {
  budget: RunBudget;
  killSwitch: boolean;
  tools: ResolvedTool[];
}

/** Models emit malformed JSON often enough that this must never throw. */
function parseArgs(call: ToolCallRequest): Record<string, unknown> {
  try {
    const parsed = JSON.parse(call.function.arguments || '{}');
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    return { __parse_error: call.function.arguments };
  }
}

/**
 * Turn a settled call into the reply the model will read.
 *
 * There is no `is_error` flag in this protocol, so a failure has to be unmistakable
 * in the text itself. A small model reading a bare denial without the marker will
 * cheerfully treat it as success and carry on.
 */
function toReply(call: ToolCallRow): ToolMessage {
  const base: ToolMessage = {
    role: 'tool',
    tool_call_id: call.toolCallId,
    name: call.toolKey,
    content: '',
  };

  switch (call.state) {
    case 'denied':
      return {
        ...base,
        content:
          `ERROR: DENIED by a human reviewer.` +
          (call.decisionComment ? ` Reason: "${call.decisionComment}".` : '') +
          ` Do not retry this action; propose a different approach or explain why you cannot proceed.`,
      };
    case 'expired':
      return {
        ...base,
        content:
          'ERROR: the approval request expired with no decision. Treat this action as not performed, ' +
          'and do not retry it without a new justification.',
      };
    case 'unknown_outcome':
      return {
        ...base,
        content:
          'ERROR: execution outcome unknown -- the worker stopped after dispatching this command but ' +
          'before recording its result. The action may or may not have taken effect. Verify the ' +
          'current state with a read-only check before deciding whether to retry.',
      };
    case 'blocked':
      return { ...base, content: `ERROR: ${call.resultJson?.text ?? 'blocked'}` };
    case 'timed_out':
      return { ...base, content: `ERROR: ${call.resultJson?.text ?? 'timed out'}` };
    default: {
      const out = call.resultJson;
      if (!out) return { ...base, content: 'ERROR: no result was recorded.' };
      return { ...base, content: out.ok ? out.text : `ERROR: ${out.text}` };
    }
  }
}

export { tierAtMost };
