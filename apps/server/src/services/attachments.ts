import { z } from 'zod';
import { runAttachments } from '@supops/db';
import type { ContentPart } from '@supops/shared';
import { ATTACHMENT_URL_PREFIX } from '@supops/shared';
import { db } from '../context.ts';

/**
 * Images pasted into Investigate or a follow-up message.
 *
 * The browser downscales and re-encodes every image to JPEG or PNG before upload, so
 * what arrives is small and in a format every provider and the PDF renderer accept.
 * The server still checks the bytes rather than trusting the declared type: the
 * magic number decides, and anything else is refused.
 */
export const MAX_IMAGES = 6;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export const imageInput = z.object({
  /** base64, optionally as a full `data:image/...;base64,` URL. */
  data: z.string().min(1).max(Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 64),
  name: z.string().max(200).optional(),
  width: z.number().int().positive().max(20_000).optional(),
  height: z.number().int().positive().max(20_000).optional(),
});
export type ImageInput = z.infer<typeof imageInput>;
export const imagesInput = z.array(imageInput).max(MAX_IMAGES).optional();

function sniff(buf: Buffer): 'image/jpeg' | 'image/png' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  return null;
}

export type SaveResult = { ok: true; ids: string[] } | { ok: false; error: string };

/** Decode, verify and store images for a run. All-or-nothing. */
export function decodeImages(images: ImageInput[] | undefined): { ok: true; decoded: Array<ImageInput & { buf: Buffer; mime: 'image/jpeg' | 'image/png' }> } | { ok: false; error: string } {
  const decoded = [];
  for (const [i, img] of (images ?? []).entries()) {
    const b64 = img.data.replace(/^data:[^;,]+;base64,/, '');
    const buf = Buffer.from(b64, 'base64');
    if (buf.length === 0 || buf.length > MAX_IMAGE_BYTES) {
      return { ok: false, error: `Image ${i + 1} is empty or larger than ${MAX_IMAGE_BYTES / 1024 / 1024} MB.` };
    }
    const mime = sniff(buf);
    if (!mime) return { ok: false, error: `Image ${i + 1} is not a JPEG or PNG.` };
    decoded.push({ ...img, buf, mime });
  }
  return { ok: true, decoded };
}

export function saveImages(
  runId: string,
  decoded: Array<{ buf: Buffer; mime: 'image/jpeg' | 'image/png'; name?: string; width?: number; height?: number }>,
  createdBy: string | null,
): string[] {
  return decoded.map(
    (d) =>
      db
        .insert(runAttachments)
        .values({
          runId,
          mime: d.mime,
          name: d.name ?? null,
          width: d.width ?? null,
          height: d.height ?? null,
          bytes: d.buf.length,
          data: d.buf,
          createdBy,
        })
        .returning({ id: runAttachments.id })
        .get().id,
  );
}

/** A user turn: plain text when there are no images, multimodal parts when there are. */
export function userContent(text: string, attachmentIds: string[]): string | ContentPart[] {
  if (attachmentIds.length === 0) return text;
  return [
    { type: 'text', text },
    ...attachmentIds.map((id): ContentPart => ({ type: 'image_url', image_url: { url: `${ATTACHMENT_URL_PREFIX}${id}` } })),
  ];
}
