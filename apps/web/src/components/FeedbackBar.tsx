import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { BookmarkPlus, Check, MessageSquareWarning, ThumbsDown, ThumbsUp } from 'lucide-react';
import { post } from '../lib/api';
import { useApp } from '../lib/store';
import { Spinner } from './ui';

/**
 * Feedback on one agent reply. Thumbs record how it went; "Correct this" saves what
 * the agent got wrong as a knowledge note for future runs (approved at once for an
 * admin, a draft for an admin to approve otherwise). "Save to knowledge" keeps a good
 * answer as a note.
 */
export function FeedbackBar({ runId, stepId, text, projectId }: { runId: string; stepId: string; text: string; projectId: string }) {
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const [rated, setRated] = useState<'up' | 'down' | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [correction, setCorrection] = useState('');
  const [done, setDone] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (body: { rating: 'up' | 'down'; correction?: string }) =>
      post<{ docStatus: 'approved' | 'draft' | null }>(`/runs/${runId}/feedback`, { stepId, ...body }),
    onSuccess: (r, v) => {
      setRated(v.rating);
      if (v.correction) {
        setCorrecting(false);
        setCorrection('');
        setDone(r.docStatus === 'approved' ? 'Saved — future runs will use this correction.' : 'Saved as a draft — an admin approves it before runs use it.');
      }
    },
  });
  const save = useMutation({
    mutationFn: () =>
      post('/knowledge', {
        projectId,
        slug: `note-${Date.now().toString(36)}`,
        kind: 'note',
        title: text.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '').slice(0, 120) || 'Saved answer',
        body: text,
        tags: ['from-run'],
      }),
    onSuccess: () => setDone(isAdmin ? 'Saved to knowledge.' : 'Saved to knowledge as a draft.'),
  });

  return (
    <div className="mt-2 space-y-2 border-t border-hairline pt-2">
      <div className="flex items-center gap-3">
        <div role="toolbar" aria-label="Feedback on this reply" className="inline-flex items-center gap-0.5 rounded-lg border border-hairline bg-tile-2/40 p-0.5">
          <IconButton label="Helpful" pressed={rated === 'up'} tone="green" onClick={() => send.mutate({ rating: 'up' })}>
            <ThumbsUp size={14} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Not helpful" pressed={rated === 'down'} tone="red" onClick={() => send.mutate({ rating: 'down' })}>
            <ThumbsDown size={14} strokeWidth={1.75} />
          </IconButton>
          <span className="mx-0.5 h-4 w-px bg-hairline" aria-hidden />
          <IconButton label="Correct this" pressed={correcting} tone="amber" expanded={correcting} onClick={() => setCorrecting((v) => !v)}>
            <MessageSquareWarning size={14} strokeWidth={1.75} />
          </IconButton>
          <IconButton label="Save to knowledge" tone="cyan" disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner /> : <BookmarkPlus size={14} strokeWidth={1.75} />}
          </IconButton>
        </div>
        {done && <span className="inline-flex items-center gap-1 text-[11px] text-green"><Check size={12} /> {done}</span>}
      </div>
      {correcting && (
        <div className="space-y-2">
          <textarea
            className="input min-h-20 resize-y text-sm"
            placeholder="What was wrong, and what is actually true? e.g. Logs on web hosts are in /srv/logs, not /var/log."
            value={correction}
            onChange={(e) => setCorrection(e.target.value)}
            maxLength={2000}
          />
          <button className="btn-primary !min-h-[34px] !text-xs" disabled={correction.trim().length < 3 || send.isPending} onClick={() => send.mutate({ rating: 'down', correction: correction.trim() })}>
            {send.isPending ? <Spinner /> : null} Save correction
          </button>
        </div>
      )}
      {(send.error || save.error) && <p className="text-[11px] text-red">{((send.error || save.error) as Error).message}</p>}
    </div>
  );
}

const TONE = {
  green: 'bg-green/10 text-green',
  red: 'bg-red/10 text-red',
  amber: 'bg-amber/10 text-amber',
  cyan: 'bg-cyan/10 text-cyan',
} as const;

/**
 * A square icon button with its own tooltip. The browser's title tooltip waits about
 * a second and cannot be styled; this one shows almost at once, on hover and on
 * keyboard focus, and the label is also the accessible name.
 */
function IconButton({
  label, pressed, expanded, tone, disabled, onClick, children,
}: {
  label: string;
  pressed?: boolean;
  expanded?: boolean;
  tone: keyof typeof TONE;
  disabled?: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        aria-label={label}
        {...(pressed !== undefined && expanded === undefined ? { 'aria-pressed': pressed } : {})}
        {...(expanded !== undefined ? { 'aria-expanded': expanded } : {})}
        disabled={disabled}
        onClick={onClick}
        className={clsx(
          'grid h-7 w-7 place-items-center rounded-md transition-colors duration-150',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue/50 disabled:opacity-50',
          pressed ? TONE[tone] : 'text-muted hover:bg-white/[0.06] hover:text-ink',
        )}
      >
        {children}
      </button>
      <span
        role="presentation"
        className={clsx(
          'pointer-events-none absolute bottom-full left-1/2 z-20 mb-1.5 -translate-x-1/2 translate-y-0.5 whitespace-nowrap',
          'rounded-md border border-hairline bg-tile px-2 py-1 text-[11px] font-medium text-ink shadow-lg',
          'opacity-0 transition duration-100 group-hover:translate-y-0 group-hover:opacity-100 group-focus-within:translate-y-0 group-focus-within:opacity-100',
          'motion-reduce:transition-none',
        )}
      >
        {label}
      </span>
    </span>
  );
}
