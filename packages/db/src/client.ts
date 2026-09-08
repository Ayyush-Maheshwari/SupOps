import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema/index.ts';

export type Db = ReturnType<typeof createDb>['db'];

export function createDb(path: string) {
  const abs = resolve(path);
  mkdirSync(dirname(abs), { recursive: true });

  const sqlite = new Database(abs);
  // WAL lets readers run while a write is in flight -- required because the same
  // process serves HTTP and the socket stream while the engine writes.
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  // Rather than surfacing SQLITE_BUSY as a random 500, wait for the writer.
  sqlite.pragma('busy_timeout = 5000');
  sqlite.pragma('foreign_keys = ON');

  const db = drizzle(sqlite, { schema });
  return { sqlite, db };
}

export { schema };
