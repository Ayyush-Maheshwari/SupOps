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
import { TIER_STYLE } from '../lib/format';
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

const commandOf = (line: string) => {
  const s = line.trim().replace(/^\$\s+/, '');
  return s && !s.startsWith('#') ? s : null;
};

/** What each verdict means for someone about to paste the line into a terminal. */
const VERDICT: Record<RiskTier, string> = {
  read_only: 'only looks',
  low: 'low risk',
  medium: 'changes something',
  high: 'risky change',
  forbidden: 'never run this',
};

/**
 * A shell block. In an advisory run each command is rated by the risk engine -- the
 * same verdict a live run would get -- since the reader is the one who will run it.
 */
function ShellBlock({ text }: { text: string }) {
  const rate = useContext(RateCommands);
  const [copied, setCopied] = useState(false);
  const lines = text.split('\n');
  const commands = lines.map(commandOf).filter((c): c is string => !!c);
  const ratings = useQuery({
    queryKey: ['rate-commands', commands],
    queryFn: () => post<Array<{ tier: RiskTier; reason: string }>>('/runs/rate-commands', { commands }),
    enabled: rate && commands.length > 0,
    staleTime: Infinity,
  });
  let k = 0;
  return (
    <div className="group/sh relative">
      <code className="block overflow-x-auto whitespace-pre rounded-lg border border-hairline bg-ground/70 px-3 py-2 pr-9 font-mono text-xs leading-relaxed text-ink">
        {lines.map((line, i) => {
          const cmd = commandOf(line);
          const r = cmd && rate ? ratings.data?.[k++] : undefined;
          return (
            <span key={i} className={clsx('flex items-baseline gap-3', !cmd && line.trim() && 'text-muted')}>
              <span className="min-w-0 flex-1">{line || ' '}</span>
              {r && (
                <span title={r.reason} className={clsx('shrink-0 font-sans text-[10px] uppercase tracking-wide', TIER_STYLE[r.tier].text)}>
                  {VERDICT[r.tier]}
                </span>
              )}
            </span>
          );
        })}
      </code>
      <button
        type="button"
        onClick={async () => {
          if (await copyText(commands.join('\n') || text)) {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          }
        }}
        className="absolute right-1.5 top-1.5 grid h-6 w-6 place-items-center rounded text-muted opacity-0 transition-opacity hover:text-ink focus:opacity-100 group-hover/sh:opacity-100"
        title="Copy the commands"
        aria-label="Copy the commands"
      >
        {copied ? <Check size={12} /> : <Copy size={12} />}
      </button>
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
