import { and, eq } from 'drizzle-orm';
import type { Db } from '@supops/db';
import { becomeSecrets, credentials, decryptSecret, targets, unpackEnvelope } from '@supops/db';
import type { ResolvedTarget } from '../tools/types.ts';

/**
 * Load a project's targets. Secrets are NOT decrypted here.
 *
 * Plaintext is fetched only by `withSecret`, immediately before a connection, and
 * it lives only in that call frame. Keeping it out of the objects we pass around
 * means it cannot end up in a log line, an API response, an event payload, or a
 * run snapshot by accident -- all of which are things that happen when a decrypted
 * credential is allowed to travel with its target.
 */
export function loadTargets(db: Db, projectId: string): ResolvedTarget[] {
  return db
    .select()
    .from(targets)
    .where(and(eq(targets.projectId, projectId), eq(targets.enabled, true)))
    .all()
    .map((t) => ({
      id: t.id,
      slug: t.slug,
      kind: t.kind,
      env: t.env,
      sensitivity: t.sensitivity,
      description: t.description,
      config: t.config,
      credentialId: t.credentialId,
      protectedPaths: t.protectedPaths,
      writablePaths: t.writablePaths,
      unitAllowlist: t.unitAllowlist,
    }));
}

export function loadTarget(db: Db, targetId: string): ResolvedTarget | undefined {
  const t = db.select().from(targets).where(eq(targets.id, targetId)).get();
  if (!t) return undefined;
  return {
    id: t.id,
    slug: t.slug,
    kind: t.kind,
    env: t.env,
    sensitivity: t.sensitivity,
    description: t.description,
    config: t.config,
    credentialId: t.credentialId,
    protectedPaths: t.protectedPaths,
    writablePaths: t.writablePaths,
    unitAllowlist: t.unitAllowlist,
  };
}

export interface SecretRef {
  id: string;
  value: string;
}

/**
 * Decrypt a target's credential for the duration of one call. The only place
 * plaintext is produced; callers must not store the result on a long-lived object.
 */
export function resolveSecret(db: Db, target: ResolvedTarget): SecretRef | null {
  if (!target.credentialId) return null;

  const cred = db
    .select()
    .from(credentials)
    .where(eq(credentials.id, target.credentialId))
    .get();
  if (!cred) return null;

  return { id: cred.id, value: decryptSecret(unpackEnvelope(cred.secretEnc)) };
}

/**
 * Decrypt every elevation password a target has, keyed by the sudo/su account it is
 * for. Same last-moment-only contract as `resolveSecret`. `user: ''` is the default.
 */
export function resolveBecomeSecrets(db: Db, target: ResolvedTarget): Array<{ user: string; value: string }> {
  const rows = db
    .select({ sudoUser: becomeSecrets.sudoUser, secretEnc: credentials.secretEnc })
    .from(becomeSecrets)
    .innerJoin(credentials, eq(becomeSecrets.credentialId, credentials.id))
    .where(eq(becomeSecrets.targetId, target.id))
    .all();
  return rows.map((r) => ({ user: r.sudoUser, value: decryptSecret(unpackEnvelope(r.secretEnc)) }));
}
