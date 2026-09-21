import { projects } from '@supops/db';
import { db, settingsStore } from './context.ts';
import { reconcileChecks, startScan } from './services/health.ts';

/**
 * The recurring health check.
 *
 * Mirrors `Worker`: a coarse `setInterval` that does the real deciding from durable
 * state. The schedule config lives in the `settings` KV row, and `nextCheckAt` (not
 * the timer) is the source of truth for when a scan is due -- so a restart resumes
 * the schedule instead of double-firing or forgetting it. Each tick also reconciles
 * any finished Deep-scan runs into issues, the durable stand-in for a completion hook.
 */
export class HealthScheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  start(): void {
    this.timer = setInterval(() => void this.tick(), 15_000);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      reconcileChecks();

      const cfg = settingsStore.health();
      if (!cfg.enabled) return;
      const now = Date.now();
      if (cfg.nextCheckAt !== null && now < cfg.nextCheckAt) return;

      // Reschedule first, so a scan that throws does not wedge the loop into firing
      // every tick.
      settingsStore.saveHealth({ lastCheckAt: now, nextCheckAt: now + cfg.intervalMs });

      const active = db.select({ id: projects.id }).from(projects).all();
      for (const p of active) {
        try {
          startScan(p.id, cfg.scanType, 'schedule', null);
        } catch (err) {
          console.error(`scheduled health check for project ${p.id} failed:`, err);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

export const healthScheduler = new HealthScheduler();
