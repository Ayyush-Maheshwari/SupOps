import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClipboardEvent, DragEvent } from 'react';

/**
 * Screenshots attached to a task or follow-up.
 *
 * Every image is downscaled and re-encoded here before it leaves the browser: a
 * 4K screenshot becomes a few hundred KB, which keeps uploads fast, keeps the
 * model's token bill sane, and means the server only ever sees JPEG or PNG -- the
 * two formats every provider and the PDF renderer accept.
 */
export const MAX_IMAGES = 6;
const MAX_EDGE = 1600;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;

export interface PreparedImage {
  id: string;
  name: string;
  /** data: URL, JPEG or PNG. Also used for the preview. */
  data: string;
  width: number;
  height: number;
}

let counter = 0;

async function prepare(file: File): Promise<PreparedImage> {
  if (!file.type.startsWith('image/')) throw new Error(`${file.name || 'That file'} is not an image.`);
  if (file.size > MAX_INPUT_BYTES) throw new Error(`${file.name || 'That image'} is larger than 25 MB.`);

  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('This browser cannot process images.');
  ctx.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();

  // PNG keeps small, sharp screenshots crisp (text, UI); anything larger or
  // photographic goes to JPEG. JPEG has no alpha, so paint a white ground first.
  let data = file.type === 'image/png' ? canvas.toDataURL('image/png') : '';
  if (!data || data.length > 1_600_000) {
    const flat = document.createElement('canvas');
    flat.width = width;
    flat.height = height;
    const f = flat.getContext('2d')!;
    f.fillStyle = '#ffffff';
    f.fillRect(0, 0, width, height);
    f.drawImage(canvas, 0, 0);
    data = flat.toDataURL('image/jpeg', 0.88);
  }

  counter += 1;
  const name = file.name && file.name !== 'image.png' ? file.name : `screenshot-${counter}.${data.startsWith('data:image/png') ? 'png' : 'jpg'}`;
  return { id: `img-${Date.now()}-${counter}`, name, data, width, height };
}

/** Pasted, dropped or picked images for one composer. */
export function useImageAttachments() {
  const [images, setImages] = useState<PreparedImage[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const count = useRef(0);
  useEffect(() => {
    count.current = images.length;
  }, [images.length]);

  const addFiles = useCallback(async (files: Iterable<File>) => {
    const list = [...files].filter((f) => f.type.startsWith('image/'));
    if (!list.length) return;
    setError(null);
    const room = MAX_IMAGES - count.current;
    if (room <= 0) {
      setError(`You can attach up to ${MAX_IMAGES} images.`);
      return;
    }
    setBusy(true);
    try {
      const prepared: PreparedImage[] = [];
      for (const f of list.slice(0, room)) prepared.push(await prepare(f));
      setImages((cur) => [...cur, ...prepared].slice(0, MAX_IMAGES));
      if (list.length > room) setError(`Only ${MAX_IMAGES} images can be attached; the rest were skipped.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read that image.');
    } finally {
      setBusy(false);
    }
  }, []);

  /** Attach images from a paste; text pastes pass through untouched. */
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      const files = [...e.clipboardData.items]
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((f): f is File => !!f);
      if (files.length) {
        e.preventDefault();
        void addFiles(files);
      }
    },
    [addFiles],
  );

  const [dragging, setDragging] = useState(false);
  const dropProps = {
    onDragOver: (e: DragEvent) => {
      if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) {
        e.preventDefault();
        setDragging(true);
      }
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      setDragging(false);
      void addFiles(e.dataTransfer.files);
    },
  };

  return {
    images,
    error,
    busy,
    dragging,
    inputRef,
    onPaste,
    dropProps,
    addFiles,
    remove: (id: string) => setImages((cur) => cur.filter((i) => i.id !== id)),
    clear: () => {
      setImages([]);
      setError(null);
    },
    /** The request payload. */
    payload: () => images.map(({ name, data, width, height }) => ({ name, data, width, height })),
  };
}

export type ImageAttachments = ReturnType<typeof useImageAttachments>;
