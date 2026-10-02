import { eq } from 'drizzle-orm';
import {
  SLACK_SETTINGS_KEY,
  decryptSecret,
  encryptSecret,
  packEnvelope,
  settings,
  unpackEnvelope,
} from '@supops/db';
import type { StoredSlackSettings } from '@supops/db';
import { db } from '../context.ts';

export interface ResolvedSlackSettings {
  appToken: string | null;
  botToken: string | null;
  enabled: boolean;
}

/** What the UI may see: presence, never the tokens themselves. */
export interface PublicSlackSettings {
  appTokenConfigured: boolean;
  botTokenConfigured: boolean;
  enabled: boolean;
  /** True when enabled and both tokens are present -- i.e. the listener can connect. */
  connectable: boolean;
}

export interface SlackSettingsPatch {
  /** undefined keeps the stored token, '' clears it. */
  appToken?: string;
  botToken?: string;
  enabled?: boolean;
}

function read(): StoredSlackSettings | null {
  const row = db.select().from(settings).where(eq(settings.key, SLACK_SETTINGS_KEY)).get();
  return (row?.value as StoredSlackSettings | undefined) ?? null;
}

function decrypt(enc: string | null): string | null {
  if (!enc) return null;
  try {
    return decryptSecret(unpackEnvelope(enc));
  } catch {
    console.warn('  ! a stored Slack token could not be decrypted (master key changed?)');
    return null;
  }
}

/** Full tokens, server-side only. */
export function resolveSlackSettings(): ResolvedSlackSettings {
  const stored = read();
  return {
    appToken: decrypt(stored?.appTokenEnc ?? null),
    botToken: decrypt(stored?.botTokenEnc ?? null),
    enabled: stored?.enabled ?? false,
  };
}

export function publicSlackSettings(): PublicSlackSettings {
  const r = resolveSlackSettings();
  return {
    appTokenConfigured: !!r.appToken,
    botTokenConfigured: !!r.botToken,
    enabled: r.enabled,
    connectable: r.enabled && !!r.appToken && !!r.botToken,
  };
}

export function saveSlackSettings(patch: SlackSettingsPatch): PublicSlackSettings {
  const stored = read();
  const encFor = (input: string | undefined, current: string | null): string | null => {
    if (input === undefined) return current;
    if (input === '') return null;
    return packEnvelope(encryptSecret(input));
  };
  const next: StoredSlackSettings = {
    appTokenEnc: encFor(patch.appToken, stored?.appTokenEnc ?? null),
    botTokenEnc: encFor(patch.botToken, stored?.botTokenEnc ?? null),
    enabled: patch.enabled ?? stored?.enabled ?? false,
  };
  db.insert(settings)
    .values({ key: SLACK_SETTINGS_KEY, value: next, updatedAt: new Date() })
    .onConflictDoUpdate({ target: settings.key, set: { value: next, updatedAt: new Date() } })
    .run();
  return publicSlackSettings();
}
