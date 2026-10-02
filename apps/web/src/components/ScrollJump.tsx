import { useEffect, useRef, useState } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';

/**
 * Floating "jump to top / bottom" for long pages. Finds the scrolling <main> it sits
 * in, and shows each button only when it would move you: top once you've scrolled
 * down, bottom while there is more below.
 */
export function ScrollJump() {
  const anchor = useRef<HTMLSpanElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [pos, setPos] = useState({ canUp: false, canDown: false });

  useEffect(() => {
    const el = anchor.current?.closest('main') as HTMLElement | null;
    setScroller(el);
    if (!el) return;
    const update = () =>
      setPos({
        canUp: el.scrollTop > 240,
        canDown: el.scrollHeight - el.scrollTop - el.clientHeight > 240,
      });
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Content grows while a run streams; re-evaluate as it does.
    const ro = new ResizeObserver(update);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    ro.observe(el);
    return () => { el.removeEventListener('scroll', update); ro.disconnect(); };
  }, []);

  const go = (top: number) => scroller?.scrollTo({ top, behavior: 'smooth' });

  return (
    <>
      <span ref={anchor} aria-hidden className="hidden" />
      {(pos.canUp || pos.canDown) && (
        <div className="fixed bottom-6 right-6 z-30 flex flex-col gap-2">
          {pos.canUp && (
            <button
              type="button"
              className="grid h-11 w-11 place-items-center rounded-full border border-blue/40 bg-tile text-blue-text shadow-lg shadow-blue/10 transition-colors hover:border-blue/70 hover:bg-blue/15"
              onClick={() => go(0)}
              title="Jump to top"
              aria-label="Jump to top"
            >
              <ArrowUp size={16} />
            </button>
          )}
          {pos.canDown && (
            <button
              type="button"
              className="grid h-11 w-11 place-items-center rounded-full border border-blue/40 bg-tile text-blue-text shadow-lg shadow-blue/10 transition-colors hover:border-blue/70 hover:bg-blue/15"
              onClick={() => go(scroller ? scroller.scrollHeight : 0)}
              title="Jump to bottom"
              aria-label="Jump to bottom"
            >
              <ArrowDown size={16} />
            </button>
          )}
        </div>
      )}
    </>
  );
}
