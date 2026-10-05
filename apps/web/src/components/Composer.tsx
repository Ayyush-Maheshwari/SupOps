import { useEffect, useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { clsx } from 'clsx';
import { ChevronRight, Paperclip, X } from 'lucide-react';
import type { ImageAttachments } from '../lib/images';
import { MAX_IMAGES } from '../lib/images';
import { Spinner } from './ui';
import { MicButton } from './MicButton';
import { useDictation } from '../lib/useDictation';

/**
 * The message box: one slim line -- attach, text, send -- in a single bordered
 * surface, so the controls read as one thing. Attached images appear above the line
 * only when there are some. The textarea grows with its content up to a cap.
 *
 * Enter sends, Shift+Enter is a newline, and paste/drop attach images. The mic
 * dictates into the box; sending stops it.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  att,
  placeholder,
  sending = false,
  locked = false,
  lockedHint,
  disabled = false,
  autoFocus,
  footer,
  error,
  sendIcon = <ChevronRight size={15} />,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  att: ImageAttachments;
  placeholder: string;
  /** A send is in flight. */
  sending?: boolean;
  /** Typing is allowed but sending is not yet (the agent is still working). */
  locked?: boolean;
  lockedHint?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Small print under the box (keyboard hints, scope notes). */
  footer?: ReactNode;
  error?: string | null;
  /** The send button's glyph; defaults to the chevron the run page always used. */
  sendIcon?: ReactNode;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const dictation = useDictation(value, onChange);
  const submit = () => {
    dictation.cancel();
    onSubmit();
  };

  // Grow with the text: reset to one line, then fit the content (capped by max-h).
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [value]);

  const hasInput = !!value.trim() || att.images.length > 0;
  const canSend = hasInput && !sending && !locked && !disabled && !att.busy;

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (canSend) submit();
    }
  };

  return (
    <div className="space-y-1">
      <div
        {...att.dropProps}
        className={clsx(
          'rounded-2xl border bg-tile-2 transition-colors',
          att.dragging ? 'border-blue ring-2 ring-blue/40' : 'border-edge focus-within:border-blue/50',
          disabled && 'opacity-60',
        )}
      >
        {att.images.length > 0 && (
          <ul className="flex flex-wrap gap-2 px-2 pt-2" aria-label="Attached images">
            {att.images.map((img) => (
              <li key={img.id} className="relative">
                <img src={img.data} alt={img.name} className="h-12 w-12 rounded-lg border border-hairline object-cover" />
                <button
                  type="button"
                  onClick={() => att.remove(img.id)}
                  className="absolute -right-1.5 -top-1.5 grid h-5 w-5 place-items-center rounded-full border border-edge bg-tile text-muted shadow hover:text-red"
                  aria-label={`Remove ${img.name}`}
                  title="Remove"
                >
                  <X size={11} />
                </button>
              </li>
            ))}
          </ul>
        )}

        {/* One line: attach · text · send. The text grows upward when it wraps. */}
        <div className="flex items-end gap-1.5 p-1.5">
          <button
            type="button"
            onClick={() => att.inputRef.current?.click()}
            disabled={disabled || att.busy || att.images.length >= MAX_IMAGES}
            className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-muted transition-colors hover:bg-white/5 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent"
            title="Attach images (or paste / drop them)"
            aria-label="Attach images"
          >
            {att.busy ? <Spinner /> : <Paperclip size={16} />}
          </button>
          <input
            ref={att.inputRef}
            type="file"
            accept="image/*"
            multiple
            hidden
            onChange={(e) => {
              if (e.target.files) void att.addFiles(e.target.files);
              e.target.value = '';
            }}
          />

          <textarea
            ref={ref}
            rows={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={att.onPaste}
            placeholder={att.dragging ? 'Drop to attach' : dictation.listening ? 'Listening…' : locked && lockedHint ? lockedHint : placeholder}
            disabled={disabled}
            autoFocus={autoFocus}
            aria-label="Message"
            className="block max-h-40 min-h-[40px] min-w-0 flex-1 resize-none bg-transparent px-1 py-2.5 text-sm leading-5 text-ink placeholder:text-muted focus:outline-none"
          />

          <MicButton dictation={dictation} disabled={disabled} className="mb-0.5 !h-[34px] !w-[34px]" />

          <button
            type="button"
            onClick={submit}
            disabled={!canSend}
            className="btn-primary mb-0.5 shrink-0 !min-h-[34px] !rounded-xl !px-2.5"
            title="Send (Enter)"
            aria-label="Send"
          >
            {sending ? <Spinner /> : sendIcon}
          </button>
        </div>
      </div>

      {att.error && <p className="px-1 text-[11px] text-amber">{att.error}</p>}
      {dictation.error && <p className="px-1 text-[11px] text-amber">{dictation.error}</p>}
      {error && <p className="px-1 text-[11px] text-red">{error}</p>}
      {footer && <p className="px-1 text-[11px] text-muted">{footer}</p>}
    </div>
  );
}
