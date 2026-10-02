import { useEffect, useRef, useState } from 'react';

const prefersReducedMotion = (): boolean =>
  typeof window !== 'undefined' &&
  window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;

/**
 * Reveal a tile once it enters the viewport.
 *
 * Gating on intersection rather than mount means tiles below the fold do not burn
 * their animation while offscreen, so scrolling down still shows the stagger. Under
 * reduced motion the element starts shown and never animates at all.
 */
export function useReveal<T extends HTMLElement = HTMLDivElement>() {
  const ref = useRef<T | null>(null);
  const [shown, setShown] = useState(prefersReducedMotion);

  useEffect(() => {
    if (shown || !ref.current) return;
    const el = ref.current;

    // No IntersectionObserver (old browsers, jsdom): show immediately rather than
    // leaving the tile invisible forever.
    if (typeof IntersectionObserver === 'undefined') {
      setShown(true);
      return;
    }

    const io = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setShown(true);
          io.disconnect();
        }
      },
      { rootMargin: '0px 0px -40px 0px', threshold: 0.01 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [shown]);

  return { ref, shown };
}
