import { join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { createDb, setMasterKey } from '@supops/db';
import { createDefaultRegistry, Engine, LLMClient } from '@supops/core';
import { SettingsStore } from './settings-store.ts';
import { config } from './config.ts';
import { SocketEventSink, SocketOutputSink } from './sockets.ts';

setMasterKey(Buffer.from(config.masterKey, 'base64'));

const { db, sqlite } = createDb(config.databasePath);

// Migrate on boot. Schema drift between the code and the file on disk is a failure
// mode with a confusing symptom ("no such table") and an obvious fix, so we just
// apply it rather than making every entry point remember to.
migrate(db, { migrationsFolder: join(config.repoRoot, 'packages/db/migrations') });

export const sink = new SocketEventSink();
export const outputSink = new SocketOutputSink();

export const settingsStore = new SettingsStore(db);

// Database settings win over .env, so a provider change made in the UI survives a
// restart and takes effect without one.
export const llm = new LLMClient(settingsStore.resolve());

/** Re-point the client after a settings change. The next request uses the new one. */
export function applyLlmSettings(): void {
  llm.reconfigure(settingsStore.resolve());
}

export const registry = createDefaultRegistry();

export const engine = new Engine({
  db,
  llm,
  registry,
  sink,
  output: outputSink,
  workerId: `worker-${process.pid}`,
});

export { db, sqlite };
