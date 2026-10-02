import { useEffect, useState } from 'react';
import { Paperclip, X } from 'lucide-react';
import { clsx } from 'clsx';
import { messageAttachmentIds, messageText } from '@supops/shared';
import type { ContentPart } from '@supops/shared';
import { getToken } from '../lib/api';
import type { ImageAttachments } from '../lib/images';
import { MAX_IMAGES } from '../lib/images';
import { Spinner } from './ui';

/** The paperclip: opens the file picker. Pair with `<AttachmentStrip>`. */
export function AttachButton({ att, className }: { att: ImageAttachments; className?: string }) {
  return (
    <>
      <button
        type="button"
        className={clsx('btn-quiet !min-h-[36px] !px-2.5', className)}
        onClick={() => att.inputRef.current?.click()}
        disabled={att.busy || att.images.length >= MAX_IMAGES}
        title="Attach screenshots (or paste / drop them)"
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
    </>
  );
}

/** Thumbnails of what is attached, each removable, plus any error. */
export function AttachmentStrip({ att }: { att: ImageAttachments }) {
  if (!att.images.length && !att.error) return null;
  return (
    <div className="space-y-1.5">
      {att.images.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Attached images">
          {att.images.map((img) => (
            <li key={img.id} className="group relative">
              <img
                src={img.data}
                alt={img.name}
                className="h-16 w-16 rounded-inner border border-hairline object-cover sm:h-20 sm:w-20"
              />
              <button
                type="button"
                onClick={() => att.remove(img.id)}
                className="absolute -right-1.5 -top-1.5 grid h-6 w-6 place-items-center rounded-full border border-edge bg-tile text-muted shadow hover:text-red"
                aria-label={`Remove ${img.name}`}
                title="Remove"
              >
                <X size={12} />
              </button>
            </li>
          ))}
        </ul>
      )}
      {att.error && <p className="text-[11px] text-amber">{att.error}</p>}
    </div>
  );
}

/**
 * An image stored on a run. Fetched with the bearer token (an <img src> cannot send
 * one) and shown from an object URL; click to open it full size.
 */
export function RunImage({ runId, attachmentId }: { runId: string; attachmentId: string }) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let revoke: string | null = null;
    let live = true;
    fetch(`/api/runs/${runId}/attachments/${attachmentId}`, { headers: { Authorization: `Bearer ${getToken() ?? ''}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
      .then((b) => {
        if (!live) return;
        revoke = URL.createObjectURL(b);
        setUrl(revoke);
      })
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [runId, attachmentId]);

  if (failed) return <span className="grid h-20 w-28 place-items-center rounded-inner border border-hairline text-[10px] text-muted">image unavailable</span>;
  if (!url) return <span className="grid h-20 w-28 place-items-center rounded-inner border border-hairline text-muted"><Spinner /></span>;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className="block overflow-hidden rounded-inner border border-hairline hover:border-edge" title="Open full size">
        <img src={url} alt="Attached screenshot" className="h-24 max-w-[220px] object-cover sm:h-28" />
      </button>
      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Attached screenshot"
          className="fixed inset-0 z-50 grid place-items-center bg-ground/90 p-4 backdrop-blur-sm"
          onClick={() => setOpen(false)}
        >
          <img src={url} alt="Attached screenshot" className="max-h-full max-w-full rounded-inner border border-hairline" />
        </div>
      )}
    </>
  );
}

/** A user turn: its text, plus any screenshots that came with it. */
export function UserContent({ runId, content, clean }: { runId: string; content: string | ContentPart[] | null; clean: (s: string) => string }) {
  const ids = messageAttachmentIds(content);
  return (
    <div className="space-y-2">
      <p className="whitespace-pre-wrap break-words text-sm text-ink">{clean(messageText(content))}</p>
      {ids.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {ids.map((a) => <RunImage key={a} runId={runId} attachmentId={a} />)}
        </div>
      )}
    </div>
  );
}
