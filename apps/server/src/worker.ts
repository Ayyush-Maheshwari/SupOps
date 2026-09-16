import { engine, settingsStore } from './context.ts';

/**
 * The scheduler.
 *
 * Concurrency defaults to 1 and that is not timidity: a free-tier key has a real
 * requests-per-minute ceiling and a self-hosted model can usually serve one
 * conversation at a time. Running four agents in parallel against either one
 * produces a burst of 429s, which the engine then durably backs off from -- so the
 * work takes longer than if it had been serialised in the first place.
 */
export class Worker {
  private running = new Set<string>();
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    // Anything left `running` by a previous process died mid-flight. Sweep it back
    // to `queued`, and mark any dispatched-but-unrecorded tool call as an unknown
    // outcome so it is never silently re-executed.
    const recovered = engine.store.recoverStaleRuns();
    if (recovered.runs || recovered.toolCalls) {
      console.log(
        `  recovered ${recovered.runs} interrupted run(s), ` +
          `${recovered.toolCalls} tool call(s) with unknown outcomes`,
      );
    }
    this.timer = setInterval(() => void this.poll(), 1000);
    void this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Kick the scheduler immediately rather than waiting for the next tick. */
  nudge(): void {
    void this.poll();
  }

  private async poll(): Promise<void> {
    const free = settingsStore.concurrency() - this.running.size;
    if (free <= 0) return;

    for (const run of engine.store.claimable(free)) {
      if (this.running.has(run.id)) continue;
      this.running.add(run.id);
      void engine
        .runToCompletion(run.id)
        .catch((err) => console.error(`run ${run.id} crashed:`, err))
        .finally(() => this.running.delete(run.id));
    }
  }
}

export const worker = new Worker();
