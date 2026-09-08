import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { ts } from './_common.ts';

/**
 * Global key/value configuration that operators can change at runtime.
 *
 * Anything here overrides the matching environment variable, so `.env` becomes the
 * initial default rather than the permanent source of truth -- which is what lets
 * someone switch the platform from a hosted model to a local one from the UI
 * instead of editing a file and restarting the process.
 */
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).$type<unknown>().notNull(),
  updatedAt: ts('updated_at').notNull().$defaultFn(() => new Date()),
});

/** Stored under `settings.key = 'llm'`. The API key is an encrypted envelope. */
export interface StoredLlmSettings {
  baseUrl: string;
  model: string;
  classifierModel: string;
  /** AES-256-GCM envelope, or null when the key should fall back to the environment. */
  apiKeyEnc: string | null;
  runConcurrency: number;
}

export const LLM_SETTINGS_KEY = 'llm';

/**
 * Stored under `settings.key = 'slack'`. Workspace-level: one Slack app serves the
 * whole install, and per-project routing lives in `alert_subscriptions`. Both tokens
 * are encrypted envelopes. `appToken` (xapp-) drives the outbound Socket Mode
 * connection; `botToken` (xoxb-) reads channel/message metadata via the Web API.
 */
export interface StoredSlackSettings {
  appTokenEnc: string | null;
  botTokenEnc: string | null;
  enabled: boolean;
}

export const SLACK_SETTINGS_KEY = 'slack';

/**
 * Stored under `settings.key = 'health'`. Drives the recurring health scheduler.
 * `nextCheckAt`/`lastCheckAt` are epoch-ms and persisted so the schedule survives a
 * restart (the in-memory timer only decides when to *look*, not when a scan is due).
 */
export interface StoredHealthSettings {
  enabled: boolean;
  intervalMs: number;
  scanType: 'quick' | 'deep';
  nextCheckAt: number | null;
  lastCheckAt: number | null;
}

export const HEALTH_SETTINGS_KEY = 'health';
