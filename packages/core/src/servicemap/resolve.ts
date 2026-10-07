/**
 * One component, many names: `web-1`, `web-1:9100`, `web-1.prod.internal`,
 * `web-1-node-metrics`, `10.0.4.21`. Normalising them is what lets a document, a
 * target, a live connection and a metric agree that they mean the same thing.
 */

/** A name reduced to what identifies it. */
export function normalizeName(raw: string): string {
  let v = raw.trim().toLowerCase();
  v = v.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  if (/^\[.*\](:\d+)?$/.test(v)) v = v.replace(/^\[(.*)\](:\d+)?$/, '$1');
  else if ((v.match(/:/g) ?? []).length === 1) v = v.split(':')[0]!;
  // Scrape-job and exporter plumbing.
  v = v.replace(/[-_](node[-_])?(metrics|exporter)$/, '');
  // A short host name from a fully qualified one (but never cut an IP).
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(v) && v.includes('.')) v = v.split('.')[0]!;
  // AWS-style private DNS carries the IP.
  const aws = v.match(/^ip-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/);
  if (aws) v = aws.slice(1).join('.');
  return v;
}

/** A key for a new component from its name: lowercase, dashes, no spaces. */
export function keyFor(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9.@:_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'component';
}

export interface Resolvable {
  id: string;
  key: string;
  name: string;
  aliases: string[];
}

/** Names that say nothing about which machine: loopback and "any address". */
export const isAnonymousName = (n: string) => /^(127\.\d+\.\d+\.\d+|localhost|0\.0\.0\.0|::1?|\*)$/.test(normalizeName(n));

/**
 * The component a name refers to, if any: by key, name or alias, after normalising.
 * Loopback names never identify anything. When several components share a name (two
 * services on one address), the machine is the answer.
 */
export function resolveName<T extends Resolvable & { type?: string }>(items: T[], name: string): T | undefined {
  const n = normalizeName(name);
  if (!n || isAnonymousName(n)) return undefined;
  const exact = items.find((i) => i.key === name || i.key === n);
  if (exact) return exact;
  const all = items.filter((i) => [i.name, ...i.aliases].some((a) => !isAnonymousName(a) && normalizeName(a) === n));
  return all.find((i) => i.type === 'host') ?? all[0];
}
