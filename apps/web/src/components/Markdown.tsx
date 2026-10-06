import { createContext, useContext, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';
import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Copy } from 'lucide-react';
import type { RiskTier } from '@supops/shared';
import { post } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { Diagram } from './Diagram';

/** Set by advisory runs: shell blocks are commands a person will run by hand. */
const RateCommands = createContext(false);
const SHELL = /language-(bash|sh|shell|console|zsh)\b/;

/**
 * Render agent prose as Markdown.
 *
 * Agents write reports in Markdown whether or not you ask them to, so showing the
 * raw text turns a readable status report into a wall of `###` and `**`. Components
 * are mapped explicitly rather than using a prose plugin so headings, tables and
 * code sit in the same dark palette as the rest of the run timeline.
 *
 * Raw HTML is deliberately NOT enabled. Model output is not trusted input, and
 * `rehype-raw` would let anything that reached the model's context -- a log line, a
 * file it read -- inject markup into this page.
 */
const components: Components = {
  h1: ({ children }) => <h3 className="mb-2 mt-4 text-base font-semibold text-ink first:mt-0">{children}</h3>,
  h2: ({ children }) => <h4 className="mb-2 mt-4 text-sm font-semibold text-ink first:mt-0">{children}</h4>,
  h3: ({ children }) => (
    <h5 className="mb-1.5 mt-4 text-xs font-semibold uppercase tracking-wide text-muted first:mt-0">{children}</h5>
  ),
  h4: ({ children }) => (
    <h6 className="mb-1.5 mt-3 text-xs font-semibold uppercase tracking-wide text-muted first:mt-0">{children}</h6>
  ),
  p: ({ children }) => <p className="mb-2.5 leading-relaxed text-ink last:mb-0">{children}</p>,
  ul: ({ children }) => <ul className="mb-2.5 ml-1 space-y-1 last:mb-0">{children}</ul>,
  ol: ({ children }) => <ol className="mb-2.5 ml-5 list-decimal space-y-1 last:mb-0">{children}</ol>,
  li: ({ children }) => (
    <li className="relative pl-4 leading-relaxed text-ink marker:text-muted before:absolute before:left-0 before:text-muted before:content-['·'] [ol>&]:pl-0 [ol>&]:before:content-none">
      {children}
    </li>
  ),
  strong: ({ children }) => <strong className="font-semibold text-ink">{children}</strong>,
  em: ({ children }) => <em className="italic text-muted">{children}</em>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className="text-blue-text hover:underline">
      {children}
    </a>
  ),
  code: ({ className, children }) => {
    // ```mermaid blocks are drawn, not printed.
    if (/language-mermaid/.test(className ?? '')) return <Diagram source={String(children).replace(/\n$/, '')} />;
    const isBlock = /language-/.test(className ?? '');
    if (isBlock && SHELL.test(className ?? '')) return <ShellBlock text={String(children).replace(/\n$/, '')} />;
    if (isBlock) {
      return (
        <code className="block overflow-x-auto whitespace-pre rounded-lg border border-hairline bg-ground/70 px-3 py-2 font-mono text-xs leading-relaxed text-ink">
          {children}
        </code>
      );
    }
    return (
      <code className="rounded border border-hairline bg-ground/70 px-1 py-0.5 font-mono text-[0.85em] text-cyan [overflow-wrap:anywhere]">
        {children}
      </code>
    );
  },
  pre: ({ node, children }) => {
    const child = node?.children[0];
    const lang = child && 'properties' in child ? String(child.properties?.className ?? '') : '';
    // A diagram renders its own card; a <pre> around it would force monospace layout.
    if (/language-mermaid/.test(lang)) return <>{children}</>;
    // Shell blocks render their own layout (a command list in advisory runs); inside a
    // <pre> its explanations would inherit "never wrap" and run off narrow screens.
    if (SHELL.test(lang)) return <div className="mb-2.5 last:mb-0">{children}</div>;
    return <pre className="mb-2.5 last:mb-0">{children}</pre>;
  },
  blockquote: ({ children }) => (
    <blockquote className="mb-2.5 border-l-2 border-hairline pl-3 text-muted last:mb-0">{children}</blockquote>
  ),
  hr: () => <hr className="my-4 border-hairline" />,
  table: ({ children }) => (
    <div className="mb-2.5 overflow-x-auto last:mb-0">
      <table className="w-full border-collapse text-xs">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-hairline bg-tile-2 px-2 py-1.5 text-left font-semibold text-muted">{children}</th>
  ),
  td: ({ children }) => <td className="border border-hairline px-2 py-1.5 text-ink">{children}</td>,
};

/** One suggested command: its explanation (from the # comments above it) and its lines. */
interface CommandItem {
  note: string;
  /** As written, for display and copying (keeps \\ line continuations). */
  text: string;
  /** One line, for the risk engine. */
  line: string;
}

/**
 * Read a shell block as a list of commands. A run of # comments explains the command
 * that follows it; a line ending in \\ continues onto the next. A leading "CHANGES:"
 * in a comment is dropped -- the verdict pill already says it.
 */
function parseCommands(text: string): { items: CommandItem[]; trailing: string } {
  const items: CommandItem[] = [];
  let note: string[] = [];
  let cur: string[] = [];
  const flush = () => {
    if (!cur.length) return;
    const text = cur.join('\n');
    items.push({
      note: note.join(' ').replace(/^(CHANGES|CHANGE|DESTRUCTIVE|WARNING)\s*:\s*/i, ''),
      text,
      line: cur.map((l) => l.replace(/\\\s*$/, '').trim()).join(' '),
    });
    cur = [];
    note = [];
  };
  for (const raw of text.split('\n')) {
    const t = raw.trim();
    const continues = cur.length > 0 && /\\\s*$/.test(cur[cur.length - 1]!);
    if (continues && t) {
      cur.push(raw.replace(/^\s{0,2}/, '  '));
    } else if (!t) {
      flush();
    } else if (t.startsWith('#')) {
      flush();
      note.push(t.replace(/^#+\s?/, ''));
    } else {
      flush();
      cur.push(t.replace(/^\$\s+/, ''));
    }
  }
  flush();
  return { items, trailing: note.join(' ') };
}

type Verdict = { tier: RiskTier; reason: string; recognised: boolean };

/**
 * What a verdict means to someone about to paste the command, in the product's
 * colours: green reads only, amber modifies state, red is high impact or prohibited.
 */
function verdictStyle(v: Verdict | undefined): { label: string; pill: string; edge: string; title: string } {
  if (!v) return { label: '···', pill: 'border-hairline bg-tile-2 text-muted', edge: 'bg-hairline', title: 'Rating…' };
  if (!v.recognised) {
    return {
      label: 'Unverified',
      pill: 'border-edge bg-tile-2 text-muted',
      edge: 'bg-dim',
      title: 'The risk engine does not know this command, so a live run would ask before running it. Check what it does first.',
    };
  }
  const by: Record<RiskTier, { label: string; pill: string; edge: string }> = {
    read_only: { label: 'Read-only', pill: 'border-green/30 bg-green/10 text-green', edge: 'bg-green/70' },
    low: { label: 'Low impact', pill: 'border-cyan/30 bg-cyan/10 text-cyan', edge: 'bg-cyan/70' },
    medium: { label: 'Modifies state', pill: 'border-amber/35 bg-amber/10 text-amber', edge: 'bg-amber' },
    high: { label: 'High impact', pill: 'border-red/40 bg-red/10 text-red', edge: 'bg-red' },
    forbidden: { label: 'Prohibited', pill: 'border-red/60 bg-red/20 text-red', edge: 'bg-red' },
  };
  return { ...by[v.tier], title: v.reason };
}

function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={async () => {
        if (await copyText(text)) {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        }
      }}
      className={clsx('grid h-7 w-7 shrink-0 place-items-center rounded-md text-muted transition-colors hover:bg-white/5 hover:text-ink', className)}
      title={copied ? 'Copied' : label}
      aria-label={label}
    >
      {copied ? <Check size={13} className="text-green" /> : <Copy size={13} />}
    </button>
  );
}

/**
 * A shell block. In an advisory run it is a list of commands the reader will run by
 * hand, so each one is a row: its risk (rated by the same engine as a live run) and
 * what it is for on top, the command below, wrapped rather than scrolled so nothing is
 * ever hidden, and its own copy button. Elsewhere it stays a plain code block.
 */
function ShellBlock({ text }: { text: string }) {
  const rate = useContext(RateCommands);
  const { items, trailing } = parseCommands(text);
  const ratings = useQuery({
    queryKey: ['rate-commands', items.map((i) => i.line)],
    queryFn: () => post<Verdict[]>('/runs/rate-commands', { commands: items.map((i) => i.line) }),
    enabled: rate && items.length > 0,
    staleTime: Infinity,
  });

  if (!rate || !items.length) {
    return (
      <div className="group/sh relative">
        <code className="block overflow-x-auto whitespace-pre rounded-lg border border-hairline bg-ground/70 px-3 py-2 pr-10 font-mono text-xs leading-relaxed text-ink">
          {text}
        </code>
        <CopyButton text={text} label="Copy" className="absolute right-1.5 top-1.5 bg-ground/80 opacity-0 focus:opacity-100 group-hover/sh:opacity-100" />
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border border-hairline bg-ground/60">
      <ul className="divide-y divide-hairline">
        {items.map((it, i) => {
          const v = verdictStyle(ratings.data?.[i]);
          return (
            <li key={i} className="group/cmd relative flex gap-3 py-2.5 pl-4 pr-2">
              <span aria-hidden className={clsx('absolute inset-y-0 left-0 w-[3px]', v.edge)} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-start gap-x-2 gap-y-1">
                  <span title={v.title} className={clsx('mt-px inline-flex shrink-0 items-center rounded-full border px-2 py-px font-sans text-[10px] font-semibold uppercase leading-4 tracking-wide', v.pill)}>
                    {v.label}
                  </span>
                  {it.note && <span className="min-w-0 basis-full font-sans text-xs leading-5 text-muted sm:flex-1 sm:basis-auto">{it.note}</span>}
                </div>
                <code className="mt-1.5 block whitespace-pre-wrap font-mono text-[12.5px] leading-relaxed text-ink [overflow-wrap:anywhere]">
                  {it.text}
                </code>
              </div>
              <CopyButton text={it.text} label="Copy this command" className="opacity-60 group-hover/cmd:opacity-100 focus:opacity-100" />
            </li>
          );
        })}
      </ul>
      {trailing && <p className="border-t border-hairline px-4 py-2 font-sans text-xs text-muted">{trailing}</p>}
    </div>
  );
}

export function Markdown({ children, rateCommands = false }: { children: string; rateCommands?: boolean }) {
  return (
    // min-w-0 lets this shrink inside a flex parent; overflow-wrap:anywhere breaks a
    // long unbreakable token (a path, URL or command with no spaces) instead of
    // letting it push the whole summary card wider than its container.
    <div className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">
      <RateCommands.Provider value={rateCommands}>
        <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
          {children}
        </ReactMarkdown>
      </RateCommands.Provider>
    </div>
  );
}
