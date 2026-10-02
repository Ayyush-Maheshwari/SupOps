import { runScheduledRetention } from './services/retention.ts';

/**
 * Housekeeping on a timer. Like the health scheduler, the timer only wakes it up:
 * when work is due is decided from durable settings (`nextRunAt`), so a restart
 * neither skips nor repeats a day's clean-up.
 */
export class MaintenanceScheduler {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;

  start(): void {
    this.timer = setInterval(() => void this.tick(), 60_000);
    // First pass shortly after boot, once the worker has recovered interrupted runs.
    setTimeout(() => void this.tick(), 30_000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async tick(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      await runScheduledRetention();
    } catch (err) {
      console.error('maintenance tick failed:', err);
    } finally {
      this.busy = false;
    }
  }
}

export const maintenanceScheduler = new MaintenanceScheduler();
