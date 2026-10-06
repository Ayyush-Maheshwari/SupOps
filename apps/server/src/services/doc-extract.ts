import { extractText, getDocumentProxy } from 'unpdf';
import mammoth from 'mammoth';
import type { ExtractedFile } from '@supops/core';

/**
 * Text out of an uploaded document, page by page. No model is involved: this is the
 * deterministic half of an import, so what the model later splits is exactly what
 * the file says.
 */

export const IMPORT_TYPES = ['pdf', 'docx', 'md', 'markdown', 'txt'] as const;
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PAGES = 300;

export class ExtractError extends Error {}

const extOf = (name: string) => name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? '';

/** File signatures, so a renamed file is caught before a parser chokes on it. */
const isPdf = (b: Buffer) => b.subarray(0, 5).toString('latin1') === '%PDF-';
const isZip = (b: Buffer) => b[0] === 0x50 && b[1] === 0x4b;

export async function extractFile(name: string, data: Buffer): Promise<ExtractedFile> {
  const ext = extOf(name);
  if (!(IMPORT_TYPES as readonly string[]).includes(ext)) {
    throw new ExtractError(`${name}: only PDF, Word (.docx), Markdown and text files can be imported.`);
  }
  if (data.length > MAX_FILE_BYTES) throw new ExtractError(`${name} is larger than 10 MB.`);

  if (ext === 'pdf') {
    if (!isPdf(data)) throw new ExtractError(`${name} is not a valid PDF.`);
    let pages: string[];
    try {
      const pdf = await getDocumentProxy(new Uint8Array(data));
      if (pdf.numPages > MAX_PAGES) throw new ExtractError(`${name} has ${pdf.numPages} pages; the limit is ${MAX_PAGES}.`);
      pages = (await extractText(pdf, { mergePages: false })).text as string[];
    } catch (err) {
      if (err instanceof ExtractError) throw err;
      throw new ExtractError(`${name} could not be read as a PDF${/password/i.test(String(err)) ? ' (it is password-protected)' : ''}.`);
    }
    // A scan has pages but (almost) no text layer.
    if (pages.join('').replace(/\s/g, '').length < 20 * Math.max(1, Math.min(pages.length, 5))) {
      throw new ExtractError(`${name} has no readable text -- it looks like a scan. Export it with text (or run OCR on it) and try again.`);
    }
    return { name, pages };
  }

  if (ext === 'docx') {
    if (!isZip(data)) throw new ExtractError(`${name} is not a valid Word document (.docx). Older .doc files need saving as .docx first.`);
    try {
      // Markdown keeps headings, lists and tables, which the split relies on.
      const { value } = await (mammoth as unknown as { convertToMarkdown: (i: { buffer: Buffer }) => Promise<{ value: string }> }).convertToMarkdown({ buffer: data });
      // mammoth escapes punctuation for Markdown; undo the escapes that only add noise.
      return { name, pages: [value.replace(/\\([.()\-_!#>+[\]])/g, '$1')] };
    } catch {
      throw new ExtractError(`${name} could not be read as a Word document.`);
    }
  }

  const text = data.toString('utf8');
  if (text.includes('\u0000')) throw new ExtractError(`${name} does not look like a text file.`);
  return { name, pages: [text] };
}
