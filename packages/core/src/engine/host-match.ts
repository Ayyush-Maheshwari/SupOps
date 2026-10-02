import type { TargetConfig } from '@supops/db';

/**
 * Matching an alert's host label to the machine it is about.
 *
 * Alerts name a machine however their exporter sees it -- `10.0.4.20:9100`,
 * `ip-10-0-4-20.us-east-1.compute.internal`, `jump-metrics` -- while a
 * target is registered by whatever address SupOps connects to (often a public IP or
 * a jump alias). So a target is matched on every name it is known by: its slug, the
 * address SupOps dials (for a machine reached directly), its alias behind a jump, and
 * the hostnames/IPs recorded for it (`addresses`, filled in by Test and discovery).
 */

interface MatchableTarget {
  id: string;
  slug: string;
  kind: string;
  config: TargetConfig;
}

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Every form an alert's host value could take, normalised: full name, short name, IP. */
export function hostForms(value: string): string[] {
  let v = value.trim().toLowerCase();
  if (!v) return [];
  v = v.replace(/^[a-z]+:\/\//, '').replace(/\/.*$/, '');
  // Strip a port, but not from a bare IPv6 address.
  if (/^\[.*\](:\d+)?$/.test(v)) v = v.replace(/^\[(.*)\](:\d+)?$/, '$1');
  else if ((v.match(/:/g) ?? []).length === 1) v = v.split(':')[0]!;
  const out = new Set<string>([v]);
  const short = v.split('.')[0]!;
  if (!IPV4.test(v) && short) out.add(short);
  // AWS-style private DNS names carry the IP: ip-10-0-4-20[.region.compute.internal].
  const aws = short.match(/^ip-(\d{1,3})-(\d{1,3})-(\d{1,3})-(\d{1,3})$/);
  if (aws) out.add(aws.slice(1).join('.'));
  return [...out];
}

/** The names a target is known by, normalised for matching. */
export function targetNames(t: MatchableTarget): string[] {
  const names = new Set<string>([t.slug.toLowerCase()]);
  if (t.config.kind === 'ssh') {
    const c = t.config;
    // A machine behind a jump shares the jump's host; that address is not its own.
    if (c.via?.alias) for (const f of hostForms(c.via.alias)) names.add(f);
    else for (const f of hostForms(c.host)) names.add(f);
    for (const a of c.addresses ?? []) for (const f of hostForms(a)) names.add(f);
  }
  return [...names];
}

/** Targets the host value refers to. Empty when nothing matches. */
export function matchTargetsByHost<T extends MatchableTarget>(available: T[], value: string): T[] {
  const forms = new Set(hostForms(value));
  if (!forms.size) return [];
  return available.filter((t) => targetNames(t).some((n) => forms.has(n)));
}

/**
 * Add the jump of every scoped machine that is reached through one. A problem is
 * often on the jump itself, and without it in scope the agent can see the jump's
 * address in the alert but has no way to log in to it.
 */
export function withJumps<T extends MatchableTarget>(scoped: T[], available: T[]): T[] {
  const out = new Map(scoped.map((t) => [t.id, t]));
  for (const t of scoped) {
    if (t.config.kind !== 'ssh' || !t.config.via?.alias) continue;
    const { host, port } = t.config;
    for (const j of available) {
      if (j.config.kind === 'ssh' && !j.config.via?.alias && j.config.host === host && j.config.port === port) out.set(j.id, j);
    }
  }
  return [...out.values()];
}

/**
 * Hostnames and IPs from `hostname; hostname -I` output, for a target's `addresses`.
 * Loopback and link-local addresses are dropped; at most 16 are kept.
 */
export function parseHostAddresses(text: string): string[] {
  const out = new Set<string>();
  for (const tok of text.split(/\s+/)) {
    const t = tok.trim().toLowerCase();
    if (!t || t.length > 253) continue;
    if (IPV4.test(t)) {
      if (t.startsWith('127.') || t.startsWith('169.254.')) continue;
      out.add(t);
    } else if (/^[a-f0-9:]+$/.test(t) && t.includes(':')) {
      if (t === '::1' || t.startsWith('fe80')) continue;
      out.add(t);
    } else if (/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(t) && t !== 'localhost' && t !== 'supops-ok') {
      out.add(t);
    }
  }
  return [...out].slice(0, 16);
}
