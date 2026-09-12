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
