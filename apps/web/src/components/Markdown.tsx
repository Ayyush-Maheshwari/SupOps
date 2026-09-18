import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { Components } from 'react-markdown';

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
    const isBlock = /language-/.test(className ?? '');
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
  pre: ({ children }) => <pre className="mb-2.5 last:mb-0">{children}</pre>,
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

export function Markdown({ children }: { children: string }) {
  return (
    // min-w-0 lets this shrink inside a flex parent; overflow-wrap:anywhere breaks a
    // long unbreakable token (a path, URL or command with no spaces) instead of
    // letting it push the whole summary card wider than its container.
    <div className="min-w-0 break-words text-sm [overflow-wrap:anywhere]">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
