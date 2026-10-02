/**
 * Mermaid diagrams in agent output.
 *
 * Agents answer "draw me a flow chart" with a fenced ```mermaid block. The UI renders
 * it, the PDF embeds it and the Markdown report keeps it as a fence (GitHub, GitLab
 * and most wikis render those natively). These helpers are shared so all three agree
 * on what a diagram is and on how a slightly-wrong one is repaired.
 */

export interface MermaidBlock {
  source: string;
  /** Nearest heading or bold line above the block, for a caption. */
  title: string;
}

const FENCE = /^```[ \t]*mermaid[ \t]*\n([\s\S]*?)\n```[ \t]*$/gim;

/** Every ```mermaid fence in a piece of Markdown, in order. */
export function extractMermaidBlocks(markdown: string): MermaidBlock[] {
  const out: MermaidBlock[] = [];
  for (const m of markdown.matchAll(FENCE)) {
    const source = m[1]!.trim();
    if (!source) continue;
    const before = markdown.slice(0, m.index).split('\n').reverse();
    let title = '';
    for (const line of before.slice(0, 6)) {
      const t = line.trim().replace(/^#+\s*/, '').replace(/\*\*/g, '').replace(/:$/, '').trim();
      if (t && !t.startsWith('```') && !/^[-*_]{3,}$/.test(t)) {
        title = t;
        break;
      }
    }
    out.push({ source, title: title.slice(0, 80) });
  }
  return out;
}

/** Whitespace-insensitive identity, so a diagram rendered in the browser matches the server's copy. */
export const diagramKey = (source: string): string =>
  source.replace(/\r/g, '').split('\n').map((l) => l.trim()).filter(Boolean).join('\n');

// Label characters Mermaid's flowchart grammar treats as syntax unless the label is
// quoted. Parentheses inside [...] are the usual culprit: "VM: mongo2 (Primary)".
const RISKY = /[()[\]{}:;#&|<>=@%]/;

const quote = (label: string): string => `"${label.trim().replace(/"/g, '#quot;')}"`;

/**
 * Node shapes as [open, close], longest first so `[(` wins over `[`. Each close is
 * specific to its open, so a label may contain other brackets.
 */
const SHAPES: Array<[string, string]> = [
  ['[(', ')]'],
  ['([', '])'],
  ['[[', ']]'],
  ['((', '))'],
  ['{{', '}}'],
  ['[/', '/]'],
  ['[\\', '\\]'],
  ['[', ']'],
  ['(', ')'],
  ['{', '}'],
];

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** Apply `fn` only outside "quoted" stretches, which are already safe. */
const outsideQuotes = (line: string, fn: (s: string) => string): string =>
  line
    .split(/("[^"]*")/)
    .map((seg, i) => (i % 2 === 1 ? seg : fn(seg)))
    .join('');

function quoteNodeLabels(line: string): string {
  // A square label that is not quoted but has quotes inside it -- G[say "hi"] -- would
  // be split by the quote-skipping below, so escape and quote it first.
  const inner = line.replace(
    /(\b[A-Za-z_][\w-]*)\[(?!["(\[/\\])([^\]\n]*"[^\]\n]*)\](?!\))/g,
    (_w, id: string, label: string) => `${id}[${quote(label)}]`,
  );
  return outsideQuotes(inner, quoteSegment);
}

// Edge labels only choke on brackets; colons, ampersands and slashes are fine there.
const EDGE_RISKY = /[()[\]{}]/;

function quoteSegment(segment: string): string {
  // -->|label (x)|  ->  -->|"label (x)"|
  let out = segment.replace(/([-=.>ox])\|(?!")([^|\n]+)\|/g, (whole, arrow: string, label: string) =>
    EDGE_RISKY.test(label) ? `${arrow}|${quote(label)}|` : whole,
  );
  for (const [open, close] of SHAPES) {
    // An id, the opening delimiter, an unquoted label (no quote, not starting with a
    // further delimiter char), then the matching close.
    const re = new RegExp(
      `(\\b[A-Za-z_][\\w-]*)${esc(open)}(?!["(\\[{/\\\\])([^"\\n]*?)${esc(close)}(?![\\])}])`,
      'g',
    );
    out = out.replace(re, (whole, id: string, label: string) =>
      RISKY.test(label) && label.trim() ? `${id}${open}${quote(label)}${close}` : whole,
    );
  }
  return out;
}

/**
 * Make a model-written flowchart parse. Mermaid is strict about a few things models
 * get wrong all the time -- mostly punctuation inside labels -- and quoting a label
 * is always valid, so every risky label is quoted. Only flowcharts are touched; other
 * diagram types come back unchanged. The operation is idempotent.
 */
export function repairMermaid(source: string): string {
  const lines = source.replace(/\r/g, '').split('\n');
  const head = lines.find((l) => l.trim() && !l.trim().startsWith('%%'))?.trim() ?? '';
  if (!/^(graph|flowchart)\b/i.test(head)) return source;

  return lines
    .map((line) => {
      if (/^\s*%%/.test(line)) return line;
      // subgraph id [Title (with) punctuation]  ->  subgraph id ["Title ..."]
      const sub = /^(\s*subgraph\s+[\w-]+\s*)\[(?!")(.*)\]\s*$/.exec(line);
      if (sub) return RISKY.test(sub[2]!) ? `${sub[1]}[${quote(sub[2]!)}]` : line;
      // subgraph Title with spaces (no id)  ->  subgraph "Title with spaces"
      const bare = /^(\s*subgraph\s+)(?!")([^[\n]*\s[^[\n]*?)\s*$/.exec(line);
      if (bare && RISKY.test(bare[2]!)) return `${bare[1]}${quote(bare[2]!)}`;
      return quoteNodeLabels(line);
    })
    .join('\n');
}
