import { existsSync, statSync, statfsSync } from 'node:fs';

/**
 * Disk space for the SQLite database.
 *
 * Deleting rows does not shrink a SQLite file: freed pages go on an internal free
 * list and are only reused by later writes. To actually hand space back, the file
 * must use `auto_vacuum = INCREMENTAL` (then `PRAGMA incremental_vacuum` truncates
 * free pages off the end), and the WAL must be checkpointed and truncated.
 *
 * Takes the raw better-sqlite3 handle: these are PRAGMAs, not queries.
 */
export interface SqliteHandle {
  pragma(source: string, options?: { simple?: boolean }): unknown;
  exec(source: string): unknown;
}

const num = (s: SqliteHandle, p: string): number => Number(s.pragma(p, { simple: true }) ?? 0);

/** 0 = none, 1 = full, 2 = incremental. */
export const autoVacuumMode = (s: SqliteHandle): number => num(s, 'auto_vacuum');

export type VacuumSetup =
  | { status: 'already' }
  | { status: 'converted'; tookMs: number }
  | { status: 'skipped'; reason: string };

/**
 * Switch a database to incremental auto-vacuum. A brand-new database is set before
 * any table exists (cheap); an existing one needs a one-time VACUUM, which rewrites
 * the whole file and needs roughly as much free disk again -- so it is skipped, with
 * a reason, when space is short or the file is very large. Run at boot, before the
 * worker starts writing.
 */
export function ensureIncrementalVacuum(
  s: SqliteHandle,
  dbPath: string,
  opts: { maxMb?: number } = {},
): VacuumSetup {
  if (autoVacuumMode(s) === 2) return { status: 'already' };

  const pageCount = num(s, 'page_count');
  // An empty file: setting the pragma is enough, no rewrite needed.
  if (pageCount <= 1) {
    s.pragma('auto_vacuum = INCREMENTAL');
    s.exec('VACUUM');
    return autoVacuumMode(s) === 2 ? { status: 'converted', tookMs: 0 } : { status: 'skipped', reason: 'SQLite refused the change' };
  }

  const bytes = fileBytes(dbPath) + fileBytes(`${dbPath}-wal`);
  const maxMb = opts.maxMb ?? 2048;
  if (bytes > maxMb * 1024 * 1024) {
    return { status: 'skipped', reason: `database is ${mb(bytes)} MB; convert it with "Compact database" during a quiet period` };
  }
  const free = freeDiskBytes(dbPath);
  if (free !== null && free < bytes * 2.2) {
    return { status: 'skipped', reason: `needs about ${mb(bytes * 2.2)} MB free to rewrite the database; ${mb(free)} MB available` };
  }

  const started = Date.now();
  s.pragma('wal_checkpoint(TRUNCATE)');
  s.pragma('auto_vacuum = INCREMENTAL');
  s.exec('VACUUM');
  if (autoVacuumMode(s) !== 2) return { status: 'skipped', reason: 'SQLite did not apply the change' };
  return { status: 'converted', tookMs: Date.now() - started };
}

/**
 * Return free pages to the filesystem after a clean-up. With incremental auto-vacuum
 * the file actually shrinks; without it, the space stays inside the file for reuse.
 */
export function reclaimSpace(s: SqliteHandle, dbPath: string): { freedBytes: number; shrunk: boolean } {
  const before = fileBytes(dbPath) + fileBytes(`${dbPath}-wal`);
  const incremental = autoVacuumMode(s) === 2;
  if (incremental) s.pragma('incremental_vacuum');
  try {
    s.pragma('wal_checkpoint(TRUNCATE)');
  } catch {
    // Busy readers: the checkpoint will happen on a later write. Not an error.
  }
  const after = fileBytes(dbPath) + fileBytes(`${dbPath}-wal`);
  return { freedBytes: Math.max(0, before - after), shrunk: incremental };
}

export interface StorageStats {
  databaseBytes: number;
  walBytes: number;
  /** Space inside the file that is free and reusable (and reclaimable with incremental vacuum). */
  freeInsideBytes: number;
  freeDiskBytes: number | null;
  totalDiskBytes: number | null;
  incrementalVacuum: boolean;
}

export function storageStats(s: SqliteHandle, dbPath: string): StorageStats {
  const pageSize = num(s, 'page_size');
  const disk = diskInfo(dbPath);
  return {
    databaseBytes: fileBytes(dbPath),
    walBytes: fileBytes(`${dbPath}-wal`),
    freeInsideBytes: num(s, 'freelist_count') * pageSize,
    freeDiskBytes: disk?.free ?? null,
    totalDiskBytes: disk?.total ?? null,
    incrementalVacuum: autoVacuumMode(s) === 2,
  };
}

function fileBytes(p: string): number {
  try {
    return existsSync(p) ? statSync(p).size : 0;
  } catch {
    return 0;
  }
}

function diskInfo(p: string): { free: number; total: number } | null {
  try {
    const st = statfsSync(p);
    return { free: st.bavail * st.bsize, total: st.blocks * st.bsize };
  } catch {
    return null;
  }
}

const freeDiskBytes = (p: string): number | null => diskInfo(p)?.free ?? null;
const mb = (b: number): number => Math.round(b / 1024 / 1024);
