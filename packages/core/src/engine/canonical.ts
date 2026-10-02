import { createHash } from 'node:crypto';

/** Key-sorted JSON, so a hash is stable regardless of property order. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/**
 * The seal on an approval. A human approves these exact bytes; if anything
 * re-renders or mutates the arguments between the decision and the dispatch, the
 * hash no longer matches and execution fails closed rather than running something
 * nobody agreed to.
 */
export const hashArgs = (args: unknown): string =>
  createHash('sha256').update(canonicalJson(args)).digest('hex');

/**
 * What an approval was granted *against*: the target's identity, environment,
 * sensitivity, connection config and credential. Recorded when an action is
 * classified and checked again just before it runs, so repointing a target after
 * approval (swapping staging's credential for prod's, flipping env) cannot ride an
 * approval nobody gave for that. The pinned SSH host key is left out: it is written
 * into the config on first contact, which would otherwise invalidate every run's
 * first approval.
 */
export function targetFingerprint(t: {
  id: string; kind: string; env: string; sensitivity: number; config: unknown; credentialId: string | null;
}): string {
  const { hostKeyFingerprint: _pinned, ...config } = (t.config ?? {}) as Record<string, unknown>;
  return createHash('sha256')
    .update(canonicalJson({ id: t.id, kind: t.kind, env: t.env, sensitivity: t.sensitivity, config, credentialId: t.credentialId }))
    .digest('hex');
}
