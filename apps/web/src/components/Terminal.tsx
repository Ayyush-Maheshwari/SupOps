import { useEffect, useRef } from 'react';
import { clsx } from 'clsx';
import { TerminalSquare } from 'lucide-react';

export interface TerminalLine {
  kind: 'command' | 'output' | 'note';
  text: string;
  target?: string | null;
}

/** The 8 basic ANSI colours plus bright, mapped onto the app's palette. */
const ANSI: Record<number, string> = {
  30: 'text-dim', 31: 'text-red', 32: 'text-green', 33: 'text-amber',
  34: 'text-blue-text', 35: 'text-violet', 36: 'text-cyan', 37: 'text-ink',
  90: 'text-dim', 91: 'text-red', 92: 'text-green', 93: 'text-amber',
  94: 'text-blue-text', 95: 'text-violet', 96: 'text-cyan', 97: 'text-ink',
};

/**
 * Renders a line containing ANSI SGR sequences as spans.
 *
 * Deliberately not a terminal emulator: this pane mirrors output, it does not accept
 * input or handle cursor movement, so xterm.js would be ~250KB for line editing and
 * key handling we never use. Unsupported sequences are dropped rather than printed,
 * which is the one thing that actually looks broken.
 */
function ansiToSpans(line: string, keyBase: string) {
  const parts: React.ReactNode[] = [];
  const re = /\x1b\[([0-9;]*)m/g;
  let last = 0;
  let cls = '';
  let m: RegExpExecArray | null;
  let i = 0;

  while ((m = re.exec(line)) !== null) {
    if (m.index > last) {
      parts.push(<span key={`${keyBase}-${i++}`} className={cls}>{line.slice(last, m.index)}</span>);
    }
    const codes = (m[1] || '0').split(';').map(Number);
    for (const c of codes) {
      if (c === 0) cls = '';
      else if (c === 1) cls = clsx(cls, 'font-semibold');
      else if (ANSI[c]) cls = ANSI[c]!;
    }
    last = re.lastIndex;
  }
  if (last < line.length) {
    parts.push(<span key={`${keyBase}-${i++}`} className={cls}>{line.slice(last)}</span>);
  }
  // Strip anything else (cursor moves, clears) rather than printing the escape.
  return parts.length ? parts : line.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '');
}

export function Terminal({
  lines,
  className,
  live = false,
}: {
  lines: TerminalLine[];
  className?: string;
  live?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the tail, but stop following the moment the user scrolls up to read
  // something -- auto-scrolling out from under someone is worse than not following.
  useEffect(() => {
    const el = ref.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <div className={clsx('flex min-h-0 flex-col', className)}>
      <div
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
        className="min-h-0 flex-1 overflow-y-auto bg-ground/60 px-4 py-3 font-mono text-[12px] leading-[1.55]"
      >
        {lines.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 text-dim">
            <TerminalSquare size={22} />
            <span className="text-[11px]">Commands the agent runs will appear here</span>
          </div>
        ) : (
          lines.map((l, i) =>
            l.kind === 'command' ? (
              <div key={i} className="mt-3 flex gap-2 first:mt-0">
                <span className="shrink-0 select-none text-green">$</span>
                <span className="min-w-0 break-all text-ink">{l.text}</span>
                {l.target && (
                  <span className="ml-auto shrink-0 text-[10px] text-dim">{l.target}</span>
                )}
              </div>
            ) : l.kind === 'note' ? (
              <div key={i} className="mt-1 text-[11px] italic text-dim">{l.text}</div>
            ) : (
              <div key={i} className="whitespace-pre-wrap break-all text-muted">
                {ansiToSpans(l.text, String(i))}
              </div>
            ),
          )
        )}
        {live && <span className="inline-block h-3.5 w-2 animate-pulse bg-green align-middle" />}
      </div>
    </div>
  );
}
