import { deleteOldRuns, dropOldImages, previewCleanup, reclaimSpace } from '@supops/core';
import type { CleanupPreview } from '@supops/core';
import { config } from '../config.ts';
import { db, settingsStore, sqlite } from '../context.ts';

/**
 * History clean-up: the scheduled job, "Clean up now", and the Runs page's "Clear
 * history" all come through here, so they share the same exclusions (active,
 * pinned, linked to an open health issue) and all reclaim the disk afterwards.
 */
export interface CleanupRequest {
  /** Delete finished runs older than this; null keeps every run (images-only clean-up). */
  olderThanDays: number | null;
  dropImagesAfterDays?: number | null;
  projectId?: string;
}

export interface CleanupResult {
  runs: number;
  images: number;
  freedBytes: number;
  shrunk: boolean;
}

let running = false;

export function previewHistoryCleanup(req: CleanupRequest): CleanupPreview & { imagesOnly: number } {
  const p = req.olderThanDays === null
    ? { runs: 0, images: 0, imageBytes: 0, kept: { pinned: 0, active: 0, linked: 0 } }
    : previewCleanup(db, { olderThanDays: req.olderThanDays, projectId: req.projectId });
  const imagesOnly = req.dropImagesAfterDays
    ? previewCleanup(db, { olderThanDays: req.dropImagesAfterDays, projectId: req.projectId }).images
    : 0;
  return { ...p, imagesOnly };
}

export async function runHistoryCleanup(req: CleanupRequest): Promise<CleanupResult> {
  if (running) throw new Error('A clean-up is already in progress');
  running = true;
  try {
    const runs = req.olderThanDays === null
      ? 0
      : await deleteOldRuns(db, { olderThanDays: req.olderThanDays, projectId: req.projectId });
    const images = req.dropImagesAfterDays
      ? dropOldImages(db, { olderThanDays: req.dropImagesAfterDays, projectId: req.projectId }).images
      : 0;
    const { freedBytes, shrunk } = reclaimSpace(sqlite, config.databasePath);
    console.log(`  clean-up: removed ${runs} run(s), ${images} image(s), freed ${Math.round(freedBytes / 1024)} KB`);
    return { runs, images, freedBytes, shrunk };
  } finally {
    running = false;
  }
}

/** The scheduled job: runs the stored policy if it is due. */
export async function runScheduledRetention(now = Date.now()): Promise<void> {
  const cfg = settingsStore.retention();
  if (cfg.days === null && cfg.dropImagesAfterDays === null) return;
  if (cfg.nextRunAt !== null && now < cfg.nextRunAt) return;

  // Reschedule first, so a failure does not retry every tick.
  settingsStore.saveRetention({ lastRunAt: now, nextRunAt: now + 24 * 60 * 60_000 });
  try {
    const r = await runHistoryCleanup({
      olderThanDays: cfg.days,
      dropImagesAfterDays: cfg.dropImagesAfterDays,
    });
    settingsStore.saveRetention({ lastResult: { at: now, runs: r.runs, images: r.images, freedBytes: r.freedBytes } });
  } catch (err) {
    settingsStore.saveRetention({
      lastResult: { at: now, runs: 0, images: 0, freedBytes: 0, error: err instanceof Error ? err.message : String(err) },
    });
  }
}
