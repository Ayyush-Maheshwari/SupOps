import { alertPoller } from './alert-poller.ts';
import { enqueueTriage, reconcileTriage, resumeTriage } from './triage.ts';
import { expireIgnores } from './incidents.ts';
import { watcher } from './watcher.ts';

/**
 * The observability loops: alert import, the metric watcher, and harvesting finished
 * incident investigations. Each is a coarse timer deciding from durable state, like
 * the health scheduler, so a restart resumes rather than repeats.
 */
class ObserveScheduler {
  private timer: NodeJS.Timeout | null = null;

  start(): void {
    alertPoller.start();
    watcher.start();
    resumeTriage();
    this.timer = setInterval(() => {
      try {
        reconcileTriage();
        // Ignores that ran out: what still fires is open again, and diagnosed if it never was.
        for (const id of expireIgnores()) enqueueTriage(id);
      } catch (err) {
        console.error('incident triage reconcile failed:', err);
      }
    }, 10_000);
  }

  stop(): void {
    alertPoller.stop();
    watcher.stop();
    if (this.timer) clearInterval(this.timer);
  }
}

export const observeScheduler = new ObserveScheduler();
