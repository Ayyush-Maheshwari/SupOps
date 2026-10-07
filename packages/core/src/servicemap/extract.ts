import { CI_LINK_KINDS, CI_TYPES } from '@supops/db';
import type { CiLinkKind, CiType } from '@supops/db';
import { keyFor, normalizeName, resolveName } from './resolve.ts';

/**
 * Components and dependencies read out of a document by the model, then compared
 * with the map. Only what the text states is taken, each with the quote that says
 * it, so a reviewer can check every suggestion against its source.
 */

export const EXTRACT_PROMPT = `You read an operations document and list the components it describes and how they depend on each other, for a service map.

Return ONLY JSON:
{"items":[{"name":"db-1","type":"database","env":"prod","description":"PostgreSQL primary","aliases":["10.0.5.11","postgres-primary"],"quote":"db-1 is the PostgreSQL primary"}],
 "links":[{"from":"api","to":"db-1","kind":"depends_on","detail":"tcp/5432","quote":"The API talks to PostgreSQL on db-1"}]}

Rules:
- Only what the document states or clearly implies. Never invent components, names or addresses. If it describes no components, return {"items":[],"links":[]}.
- type is one of: ${CI_TYPES.join(', ')}.
- kind is one of: ${CI_LINK_KINDS.join(', ')}. "a depends_on b" means a needs b to work; "a runs_on b" means a is hosted on b; "a routes_to b" for load balancers and gateways; "a replicates_to b" from primary to replica.
- Use the names the document uses. Put other names, hostnames and IPs it gives for the same thing in aliases.
- quote: the shortest exact phrase from the document that supports the entry (under 200 characters).
- A group like "four app servers" with no names is one item ("app servers") unless the servers are named.`;

export interface ExtractedItem {
  name: string;
  type: CiType;
  env?: string;
  description?: string;
  aliases: string[];
  quote?: string;
}

export interface ExtractedLink {
  from: string;
  to: string;
  kind: CiLinkKind;
  detail?: string;
  quote?: string;
}

export interface Extraction {
  items: ExtractedItem[];
  links: ExtractedLink[];
}

const str = (v: unknown, max = 300) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined);

/** The model's answer, checked: unknown types and kinds are coerced or dropped, never trusted. */
export function parseExtraction(raw: string | null): Extraction {
  if (!raw) return { items: [], links: [] };
  const json = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!json) return { items: [], links: [] };
  let data: { items?: unknown[]; links?: unknown[] };
  try {
    data = JSON.parse(json) as typeof data;
  } catch {
    return { items: [], links: [] };
  }
  const items: ExtractedItem[] = [];
  for (const r of Array.isArray(data.items) ? data.items : []) {
    const o = r as Record<string, unknown>;
    const name = str(o.name, 120);
    if (!name) continue;
    const type = (CI_TYPES as readonly string[]).includes(String(o.type)) ? (o.type as CiType) : 'service';
    items.push({
      name,
      type,
      ...(str(o.env, 30) ? { env: str(o.env, 30) } : {}),
      ...(str(o.description) ? { description: str(o.description) } : {}),
      aliases: Array.isArray(o.aliases) ? o.aliases.map((a) => str(a, 120)).filter((a): a is string => !!a).slice(0, 12) : [],
      ...(str(o.quote, 240) ? { quote: str(o.quote, 240) } : {}),
    });
  }
  const links: ExtractedLink[] = [];
  for (const r of Array.isArray(data.links) ? data.links : []) {
    const o = r as Record<string, unknown>;
    const from = str(o.from, 120);
    const to = str(o.to, 120);
    if (!from || !to || normalizeName(from) === normalizeName(to)) continue;
    const kind = (CI_LINK_KINDS as readonly string[]).includes(String(o.kind)) ? (o.kind as CiLinkKind) : 'depends_on';
    links.push({ from, to, kind, ...(str(o.detail, 120) ? { detail: str(o.detail, 120) } : {}), ...(str(o.quote, 240) ? { quote: str(o.quote, 240) } : {}) });
  }
  // A link may name a component the item list left out: add it so the link has ends.
  for (const l of links) {
    for (const end of [l.from, l.to]) {
      if (!items.some((i) => normalizeName(i.name) === normalizeName(end) || i.aliases.some((a) => normalizeName(a) === normalizeName(end)))) {
        items.push({ name: end, type: 'service', aliases: [] });
      }
    }
  }
  return { items, links };
}

// ---- comparing a document with the map ----------------------------------------

export interface MapItemLite {
  id: string;
  key: string;
  name: string;
  type: CiType;
  description: string | null;
  aliases: string[];
  locked: boolean;
}

export interface MapLinkLite {
  id: string;
  fromId: string;
  toId: string;
  kind: CiLinkKind;
}

export interface DocPlan {
  /** Existing entries this document now also supports: evidence only, no change to the map. */
  supportItems: Array<{ itemId: string; quote?: string }>;
  supportLinks: Array<{ linkId: string; quote?: string }>;
  /** Changes that need a person. */
  proposals: Array<{ op: 'add_item' | 'update_item' | 'add_link' | 'remove_item' | 'remove_link'; payload: Record<string, unknown>; quote?: string }>;
  /** Evidence from this document that it no longer supports. */
  dropItemEvidence: string[];
  dropLinkEvidence: string[];
}

/**
 * What a (new or edited) document means for the map. `docOnly*` are the entries whose
 * only support was this document: if it stopped saying so, removing them is proposed;
 * entries something else also supports just lose this document's evidence.
 */
export function planDocChanges(input: {
  extraction: Extraction;
  items: MapItemLite[];
  links: MapLinkLite[];
  /** Items and links this document supported before. */
  previousItemIds: string[];
  previousLinkIds: string[];
  /** Of those, the ones nothing else supports. */
  docOnlyItemIds: string[];
  docOnlyLinkIds: string[];
}): DocPlan {
  const plan: DocPlan = { supportItems: [], supportLinks: [], proposals: [], dropItemEvidence: [], dropLinkEvidence: [] };
  const { items, links } = input;
  const resolved = new Map<string, MapItemLite | null>();
  const resolve = (name: string, aliases: string[] = []) => {
    const k = normalizeName(name);
    if (resolved.has(k)) return resolved.get(k)!;
    const hit = resolveName(items, name) ?? aliases.map((a) => resolveName(items, a)).find(Boolean) ?? null;
    resolved.set(k, hit);
    return hit;
  };

  const stillItems = new Set<string>();
  for (const e of input.extraction.items) {
    const hit = resolve(e.name, e.aliases);
    if (!hit) {
      plan.proposals.push({ op: 'add_item', payload: { key: keyFor(e.name), name: e.name, type: e.type, env: e.env ?? null, description: e.description ?? null, aliases: e.aliases }, quote: e.quote });
      continue;
    }
    stillItems.add(hit.id);
    plan.supportItems.push({ itemId: hit.id, quote: e.quote });
    // Fields the document fills in or corrects, unless a person owns this entry.
    if (!hit.locked) {
      const changes: Record<string, unknown> = {};
      if (e.type !== 'service' && e.type !== hit.type) changes.type = e.type;
      if (e.description && !hit.description) changes.description = e.description;
      // The document's own name is a name for it too; and it replaces a bare IP.
      const newAliases = [e.name, ...e.aliases].filter((a, i, all) => all.indexOf(a) === i && ![hit.name, ...hit.aliases].some((x) => normalizeName(x) === normalizeName(a)));
      const bareIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(hit.name) && !/^\d{1,3}(\.\d{1,3}){3}$/.test(e.name);
      if (bareIp) {
        changes.name = e.name;
        changes.aliases = [...hit.aliases, hit.name, ...newAliases.filter((a) => a !== e.name)];
      } else if (newAliases.length) changes.aliases = [...hit.aliases, ...newAliases];
      if (Object.keys(changes).length) plan.proposals.push({ op: 'update_item', payload: { id: hit.id, name: hit.name, changes }, quote: e.quote });
    }
  }

  const stillLinks = new Set<string>();
  for (const l of input.extraction.links) {
    const a = resolve(l.from);
    const b = resolve(l.to);
    const existing = a && b ? links.find((x) => x.fromId === a.id && x.toId === b.id && x.kind === l.kind) : undefined;
    if (existing) {
      stillLinks.add(existing.id);
      plan.supportLinks.push({ linkId: existing.id, quote: l.quote });
    } else {
      plan.proposals.push({ op: 'add_link', payload: { from: a?.key ?? l.from, to: b?.key ?? l.to, kind: l.kind, detail: l.detail ?? null }, quote: l.quote });
    }
  }

  // What the document used to say and no longer does.
  for (const id of input.previousLinkIds) {
    if (stillLinks.has(id)) continue;
    if (input.docOnlyLinkIds.includes(id)) {
      const l = links.find((x) => x.id === id);
      const name = (iid: string) => items.find((i) => i.id === iid)?.name ?? iid;
      plan.proposals.push({ op: 'remove_link', payload: { id, from: l ? name(l.fromId) : '', to: l ? name(l.toId) : '', kind: l?.kind ?? '' } });
    } else plan.dropLinkEvidence.push(id);
  }
  for (const id of input.previousItemIds) {
    if (stillItems.has(id)) continue;
    if (input.docOnlyItemIds.includes(id)) plan.proposals.push({ op: 'remove_item', payload: { id, name: items.find((i) => i.id === id)?.name ?? id } });
    else plan.dropItemEvidence.push(id);
  }
  return plan;
}
