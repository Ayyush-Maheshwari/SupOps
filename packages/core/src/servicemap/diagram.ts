import { inflateRawSync } from 'node:zlib';
import { CI_LINK_KINDS, CI_TYPES } from '@supops/db';
import type { CiLinkKind, CiType } from '@supops/db';
import { normalizeName } from './resolve.ts';
import type { Extraction, ExtractedItem, ExtractedLink } from './extract.ts';

/**
 * Architecture diagrams into the map. A draw.io file is read exactly -- its boxes
 * and arrows are data -- and needs no model. Anything else (a picture, Mermaid,
 * PlantUML, Graphviz) is read by the model with the prompt below. Either way the
 * result is the same shape as a document's, and becomes suggestions to review.
 */

export const DIAGRAM_PROMPT = `You read an architecture diagram and list its components and the connections between them, for a service map.

Return ONLY JSON:
{"items":[{"name":"db-1","type":"database","env":"prod","description":"PostgreSQL primary","aliases":["10.0.5.11"],"quote":"db-1 (PostgreSQL)"}],
 "links":[{"from":"api","to":"db-1","kind":"depends_on","detail":"tcp/5432","quote":"api -> db-1"}]}

Rules:
- Every labelled box, node, icon or shape that stands for a system is a component. Use its label as the name, exactly as written. Put other names, hostnames or IPs written on or beside it in aliases.
- Ignore titles, legends, notes, and boxes that only group others (a VPC, a region, "Production") unless the group is itself a machine or cluster that the others run on; then link each inside it with kind "runs_on" to the group.
- An arrow from A to B: A calls or sends to B, so "A depends_on B". A line with no arrowhead: the side that initiates (a client, a load balancer, an app) depends on the other (a database, a cache, a queue). A load balancer or gateway pointing at servers: "routes_to". Primary to replica: "replicates_to".
- type is one of: ${CI_TYPES.join(', ')}. A cylinder is a database; a user or browser icon, or a third-party service, is external.
- kind is one of: ${CI_LINK_KINDS.join(', ')}.
- Put a label written on an arrow (a protocol, port or purpose) in detail.
- quote: the text in the diagram that names the component or labels the arrow (under 200 characters).
- Only what the diagram shows. Never invent components. If it is not an architecture diagram, return {"items":[],"links":[]}.`;

// ---- draw.io ---------------------------------------------------------------------------

interface Cell {
  id: string;
  label: string;
  style: string;
  vertex: boolean;
  edge: boolean;
  source?: string;
  target?: string;
  parent?: string;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s: string) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) =>
    e[0] === '#' ? String.fromCodePoint(e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m);

/** A label as text: draw.io labels are often HTML. */
function labelText(raw: string): string {
  return decode(decode(raw).replace(/<br\s*\/?>|<\/(div|p)>/gi, ' ').replace(/<[^>]+>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of tag.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) out[m[1]!] = m[2]!;
  return out;
}

/** The graph XML of a draw.io file, unpacking the compressed form draw.io saves by default. */
export function drawioXml(text: string): string | null {
  if (!/<mxfile|<mxGraphModel|mxCell/.test(text)) {
    // A draw.io SVG or HTML export carries the file in an attribute.
    const embedded = text.match(/content="([^"]*mxfile[^"]*)"/)?.[1];
    return embedded ? drawioXml(decode(embedded)) : null;
  }
  if (text.includes('<mxCell')) return text;
  const packed = text.match(/<diagram[^>]*>([\s\S]*?)<\/diagram>/)?.[1]?.trim();
  if (!packed) return null;
  try {
    return decodeURIComponent(inflateRawSync(Buffer.from(packed, 'base64')).toString('latin1'));
  } catch {
    return null;
  }
}

const TYPE_HINTS: Array<[RegExp, CiType]> = [
  // Most specific first: "elastic_load_balancing" is a load balancer, "elasticache" a cache.
  [/load.?balanc|\belb\b|\balb\b|\bnlb\b|haproxy|nginx|traefik|envoy|ingress|\blb\b/i, 'load_balancer'],
  [/redis|memcache|cache/i, 'cache'],
  [/queue|kafka|rabbit|sqs|sns|pubsub|nats|kinesis|\bmq\b/i, 'queue'],
  [/gateway|api.?gw|cdn|cloudfront|waf/i, 'gateway'],
  [/cylinder|datastore|database|rds|aurora|dynamo|postgres|mysql|maria|mongo|cassandra|elasticsearch|opensearch|clickhouse|\bdb\b|sql/i, 'database'],
  [/\bs3\b|bucket|storage|blob|\bnfs\b|\befs\b|volume/i, 'storage'],
  [/kubernetes|k8s|\beks\b|\baks\b|\bgke\b|cluster|openshift/i, 'cluster'],
  [/prometheus|grafana|alertmanager|loki|monitor|datadog|newrelic/i, 'monitoring'],
  [/actor|\buser|person|browser|internet|third.?party|external/i, 'external'],
  [/server|\bec2\b|\bvm\b|instance|\bhost|machine|compute/i, 'host'],
];

/** The type a shape and its label suggest; a service when nothing does. */
export function typeFromShape(style: string, label: string): CiType {
  for (const [re, t] of TYPE_HINTS) if (re.test(style)) return t;
  for (const [re, t] of TYPE_HINTS) if (re.test(label)) return t;
  return 'service';
}

function kindFor(label: string, fromType: CiType): CiLinkKind {
  if (/replicat/i.test(label)) return 'replicates_to';
  if (/backup/i.test(label)) return 'backs_up_to';
  if (/\breads?\b/i.test(label)) return 'reads_from';
  if (/\bwrites?\b/i.test(label)) return 'writes_to';
  if (/monitor|scrape/i.test(label)) return 'monitors';
  if (/route|proxy|forward|balanc/i.test(label) || fromType === 'load_balancer' || fromType === 'gateway') return 'routes_to';
  return 'depends_on';
}

const hasArrow = (style: string, end: 'start' | 'end') => {
  const v = style.match(new RegExp(`${end}Arrow=([^;]*)`))?.[1];
  // draw.io draws an arrowhead at the end unless told otherwise, none at the start.
  return end === 'end' ? v !== 'none' : !!v && v !== 'none';
};

/** Boxes and arrows of a draw.io file, exactly; null when the text is not one. */
export function parseDrawio(text: string): Extraction | null {
  const xml = drawioXml(text);
  if (!xml) return null;
  const cells = new Map<string, Cell>();
  // <mxCell .../> or <mxCell ...>...</mxCell>, alone or wrapped in <object label=...> / <UserObject>.
  for (const m of xml.matchAll(/<(object|UserObject)\b([^>]*)>\s*<mxCell\b([^>]*)\/?>|<mxCell\b([^>]*)\/?>/g)) {
    const wrapper = m[2] ? attrs(m[2]) : {};
    const a = attrs(m[3] ?? m[4] ?? '');
    const id = wrapper.id ?? a.id;
    if (!id) continue;
    cells.set(id, {
      id,
      label: labelText(wrapper.label ?? a.value ?? ''),
      style: a.style ?? '',
      vertex: a.vertex === '1',
      edge: a.edge === '1',
      source: a.source,
      target: a.target,
      parent: a.parent,
    });
  }
  // An arrow can end on a label inside a box: it belongs to the nearest labelled box.
  const owner = (id: string | undefined): Cell | undefined => {
    for (let c = id ? cells.get(id) : undefined, n = 0; c && n < 10; c = c.parent ? cells.get(c.parent) : undefined, n++) {
      if (c.vertex && c.label) return c;
    }
    return undefined;
  };
  const isGroup = (c: Cell) => /swimlane|container=1|group/.test(c.style) || [...cells.values()].some((x) => x.vertex && x.parent === c.id && x.label);

  const items: ExtractedItem[] = [];
  const typeOf = new Map<string, CiType>();
  const seen = new Set<string>();
  for (const c of cells.values()) {
    if (!c.vertex || !c.label || c.label.length > 80 || /^(legend|title|note)\b/i.test(c.label)) continue;
    const type = typeFromShape(c.style, c.label);
    // Grouping boxes are not components unless they are machines or clusters.
    if (isGroup(c) && type !== 'host' && type !== 'cluster') continue;
    typeOf.set(c.id, type);
    const k = normalizeName(c.label);
    if (seen.has(k)) continue;
    seen.add(k);
    items.push({ name: c.label, type, aliases: [], quote: c.label });
  }

  const links: ExtractedLink[] = [];
  const linked = new Set<string>();
  for (const e of cells.values()) {
    if (!e.edge) continue;
    let a = owner(e.source);
    let b = owner(e.target);
    if (!a || !b || a === b || !typeOf.has(a.id) || !typeOf.has(b.id)) continue;
    // An arrowhead only at the start points the other way.
    if (hasArrow(e.style, 'start') && !hasArrow(e.style, 'end')) [a, b] = [b, a];
    const label = e.label;
    const kind = kindFor(label, typeOf.get(a.id)!);
    const k = `${normalizeName(a.label)}>${normalizeName(b.label)}>${kind}`;
    if (linked.has(k)) continue;
    linked.add(k);
    links.push({ from: a.label, to: b.label, kind, ...(label ? { detail: label.slice(0, 120) } : {}), quote: `${a.label} -> ${b.label}${label ? ` (${label})` : ''}` });
  }
  // Things inside a machine or cluster box run on it.
  for (const c of cells.values()) {
    const inside = c.parent ? cells.get(c.parent) : undefined;
    if (!c.vertex || !typeOf.has(c.id) || !inside || !typeOf.has(inside.id)) continue;
    const t = typeOf.get(inside.id);
    if (t === 'host' || t === 'cluster') links.push({ from: c.label, to: inside.label, kind: 'runs_on', quote: `${c.label} in ${inside.label}` });
  }
  return { items, links };
}

/** What kind of diagram a text is, for messages. */
export function diagramFormat(text: string): 'drawio' | 'mermaid' | 'plantuml' | 'graphviz' | 'text' {
  if (drawioXml(text)) return 'drawio';
  if (/^\s*(flowchart|graph|C4\w*|architecture-beta|sequenceDiagram)\b/m.test(text)) return 'mermaid';
  if (/@startuml|@startc4/i.test(text)) return 'plantuml';
  if (/^\s*(strict\s+)?(di)?graph\b[^{]*\{/m.test(text)) return 'graphviz';
  return 'text';
}
