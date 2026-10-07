import { projects } from '@supops/db';
import { db } from '../context.ts';
import { lastDiscovery, runDiscovery } from '../servicemap/discover.ts';
import { alertPoller } from './alert-poller.ts';
import { enqueueTriage, reconcileTriage, resumeTriage } from './triage.ts';
import { expireIgnores } from './incidents.ts';
import { watcher } from './watcher.ts';

/**
 * The observability loops: alert import, the metric watcher, and harvesting finished
 * incident investigations. Each is a coarse timer deciding from durable state, like
 * the health scheduler, so a restart resumes rather than repeats.
 */
const MAP_EVERY_MS = 6 * 3_600_000;

/** Rebuild each project's service map from live sources every few hours. */
async function mapTick(): Promise<void> {
  for (const p of db.select({ id: projects.id }).from(projects).all()) {
    const last = lastDiscovery(p.id);
    if (last && Date.now() - last.at < MAP_EVERY_MS) continue;
    try {
      await runDiscovery(p.id);
    } catch (err) {
      console.error(`service map discovery for ${p.id} failed:`, err);
    }
  }
}

class ObserveScheduler {
  private timer: NodeJS.Timeout | null = null;
  private mapTimer: NodeJS.Timeout | null = null;

  start(): void {
    alertPoller.start();
    watcher.start();
    setTimeout(() => void mapTick(), 60_000);
    this.mapTimer = setInterval(() => void mapTick(), 15 * 60_000);
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
    if (this.mapTimer) clearInterval(this.mapTimer);
  }
}

export const observeScheduler = new ObserveScheduler();
