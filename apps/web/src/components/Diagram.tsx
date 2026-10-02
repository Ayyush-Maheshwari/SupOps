import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { Check, Code2, Copy, Maximize2, Workflow, X } from 'lucide-react';
import { renderDiagram } from '../lib/mermaid';
import { copyText } from '../lib/clipboard';
import { Spinner } from './ui';

/**
 * A ```mermaid block from the agent, drawn. If it will not render even after repair,
 * the source is shown instead with a note -- the content is never lost.
 */
export function Diagram({ source }: { source: string }) {
  const [state, setState] = useState<{ svg: string; repaired: boolean } | { error: string } | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let live = true;
    setState(null);
    renderDiagram(source)
      .then((r) => live && setState({ svg: r.svg, repaired: r.repaired }))
      .catch((e: unknown) => live && setState({ error: e instanceof Error ? e.message : 'Could not draw this diagram' }));
    return () => {
      live = false;
    };
  }, [source]);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setExpanded(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded]);

  const failed = !!state && 'error' in state;
  const svg = state && 'svg' in state ? state.svg : null;

  const copy = async () => {
    if (await copyText(source)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }
  };

  const code = (
    <code className="block overflow-x-auto whitespace-pre rounded-lg border border-hairline bg-ground/70 px-3 py-2 font-mono text-xs leading-relaxed text-ink">
      {source}
    </code>
  );

  return (
    <figure className="mb-2.5 overflow-hidden rounded-lg border border-hairline bg-ground/40 last:mb-0">
      <figcaption className="flex items-center gap-2 border-b border-hairline px-3 py-1.5 text-[11px] text-muted">
        <Workflow size={13} className="text-blue-text" aria-hidden />
        <span>{failed ? 'Diagram (could not be drawn)' : 'Diagram'}</span>
        <div className="ml-auto flex items-center gap-0.5">
          {svg && (
            <IconButton label={showCode ? 'Show diagram' : 'Show source'} onClick={() => setShowCode((v) => !v)} active={showCode}>
              <Code2 size={13} />
            </IconButton>
          )}
          <IconButton label="Copy Mermaid source" onClick={() => void copy()}>
            {copied ? <Check size={13} className="text-green" /> : <Copy size={13} />}
          </IconButton>
          {svg && (
            <IconButton label="Expand" onClick={() => setExpanded(true)}>
              <Maximize2 size={13} />
            </IconButton>
          )}
        </div>
      </figcaption>

      <div className="p-3">
        {!state ? (
          <div className="grid h-24 place-items-center text-muted"><Spinner /></div>
        ) : failed || showCode ? (
          <>
            {failed && (
              <p className="mb-2 text-[11px] text-amber">
                The agent's diagram has a syntax error, so its source is shown. {(state as { error: string }).error.split('\n')[0]}
              </p>
            )}
            {code}
          </>
        ) : (
          // Mermaid's own output under securityLevel "strict" (sanitised, no scripts).
          <div className="diagram overflow-x-auto [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:max-w-full" dangerouslySetInnerHTML={{ __html: svg! }} />
        )}
      </div>

      {expanded && svg && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Diagram"
          className="fixed inset-0 z-50 grid place-items-center bg-ground/90 p-4 backdrop-blur-sm sm:p-10"
          onClick={() => setExpanded(false)}
        >
          <button
            type="button"
            className="absolute right-4 top-4 grid h-10 w-10 place-items-center rounded-full border border-edge bg-tile text-muted hover:text-ink"
            aria-label="Close"
            onClick={() => setExpanded(false)}
          >
            <X size={16} />
          </button>
          <div
            className="max-h-full w-full max-w-6xl overflow-auto rounded-tile border border-hairline bg-tile p-6 [&_svg]:mx-auto [&_svg]:h-auto [&_svg]:w-full [&_svg]:max-w-none"
            onClick={(e) => e.stopPropagation()}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
        </div>
      )}
    </figure>
  );
}

function IconButton({ label, onClick, active, children }: { label: string; onClick: () => void; active?: boolean; children: React.ReactNode }) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className={clsx(
        'grid h-7 w-7 place-items-center rounded-md transition-colors hover:bg-white/5 hover:text-ink',
        active ? 'text-blue-text' : 'text-muted',
      )}
    >
      {children}
    </button>
  );
}
