import { clsx } from 'clsx';
import { Mic, Square } from 'lucide-react';
import type { Dictation } from '../lib/useDictation';

/**
 * The voice toggle that sits beside a message box. While listening it turns red and
 * shows a stop square; the words land in the box for the person to check and send.
 */
export function MicButton({ dictation, disabled, className }: { dictation: Dictation; disabled?: boolean; className?: string }) {
  const { supported, listening, toggle } = dictation;
  const label = !supported
    ? 'Voice input is not available in this browser (try Chrome, Edge or Safari)'
    : listening
      ? 'Stop listening'
      : 'Speak instead of typing';
  return (
    <button
      type="button"
      onClick={toggle}
      disabled={disabled || !supported}
      aria-pressed={listening}
      aria-label={label}
      title={label}
      className={clsx(
        'relative grid h-10 w-10 shrink-0 place-items-center rounded-xl transition-colors disabled:opacity-40',
        listening ? 'bg-red/15 text-red' : 'text-muted hover:bg-white/5 hover:text-ink disabled:hover:bg-transparent',
        className,
      )}
    >
      {listening && <span aria-hidden className="absolute inset-1 animate-ping rounded-xl bg-red/20" />}
      {listening ? <Square size={13} fill="currentColor" /> : <Mic size={16} />}
    </button>
  );
}
