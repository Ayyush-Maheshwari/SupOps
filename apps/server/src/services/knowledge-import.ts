import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { knowledgeDocs } from '@supops/db';
import type { ExtractedFile, ImportProposal, ImportSection } from '@supops/core';
import { MAX_SECTIONS, SPLIT_PROMPT, dedupeSlugs, parseSplit, sectionFile, sectionMessage } from '@supops/core';
import { messageText } from '@supops/shared';
import { db, llm } from '../context.ts';
import { ExtractError, extractFile } from './doc-extract.ts';

/**
 * An import in progress. Splitting a long handbook is several model calls, which can
 * outlast an HTTP request, so the upload starts a job the page polls. Jobs live in
 * memory only: nothing is saved until a person reviews the proposals, and a restart
 * just means uploading again.
 */
export interface ImportJob {
  id: string;
  projectId: string;
  userId: string | null;
  status: 'running' | 'done' | 'failed';
  /** Sections split so far, of `total`. */
  done: number;
  total: number;
  error: string | null;
  warnings: string[];
  /** Each section's text, and page by page when the file has pages, for the review's "original text". */
  sections: Array<Pick<ImportSection, 'id' | 'file' | 'fromPage' | 'toPage' | 'paged' | 'text'> & { pages: string[] }>;
  proposals: Array<ImportProposal & { clash: { id: string; title: string; slug: string; status: string } | null }>;
  createdAt: number;
}

const jobs = new Map<string, ImportJob>();
const TTL_MS = 60 * 60_000;

function sweep(): void {
  const cutoff = Date.now() - TTL_MS;
  for (const [id, j] of jobs) if (j.createdAt < cutoff) jobs.delete(id);
}

export function getImportJob(id: string, userId: string | null): ImportJob | undefined {
  const j = jobs.get(id);
  // Only the person who uploaded a document sees what it said before review.
  return j && j.userId === userId ? j : undefined;
}

export function startImport(input: { projectId: string; userId: string | null; files: Array<{ name: string; data: Buffer }> }): ImportJob {
  sweep();
  const job: ImportJob = {
    id: randomUUID(),
    projectId: input.projectId,
    userId: input.userId,
    status: 'running',
    done: 0,
    total: 0,
    error: null,
    warnings: [],
    sections: [],
    proposals: [],
    createdAt: Date.now(),
  };
  jobs.set(job.id, job);
  void run(job, input.files).catch((err) => {
    job.status = 'failed';
    job.error = err instanceof Error ? err.message : String(err);
  });
  return job;
}

async function run(job: ImportJob, files: Array<{ name: string; data: Buffer }>): Promise<void> {
  const extracted: ExtractedFile[] = [];
  for (const f of files) {
    try {
      extracted.push(await extractFile(f.name, f.data));
    } catch (err) {
      if (!(err instanceof ExtractError)) throw err;
      job.warnings.push(err.message);
    }
  }
  if (!extracted.length) {
    job.status = 'failed';
    job.error = job.warnings.join(' ') || 'Nothing could be read from those files.';
    return;
  }

  let sections = extracted.flatMap((f) => sectionFile(f).map((s) => ({ s, pages: f.pages })));
  if (sections.length > MAX_SECTIONS) {
    job.warnings.push(`Only the first ${MAX_SECTIONS} sections (about ${Math.round((MAX_SECTIONS * 24) / 3)} pages of text) were imported. Split the file and import the rest separately.`);
    sections = sections.slice(0, MAX_SECTIONS);
  }
  job.total = sections.length;
  job.sections = sections.map(({ s, pages }) => ({
    id: s.id, file: s.file, fromPage: s.fromPage, toPage: s.toPage, paged: s.paged, text: s.text,
    pages: s.paged ? pages.slice(s.fromPage - 1, s.toPage) : [],
  }));

  const proposals: ImportProposal[] = [];
  let fellBack = 0;
  for (const { s, pages } of sections) {
    let raw: string | null = null;
    try {
      const res = await llm.complete(
        [
          { role: 'system', content: SPLIT_PROMPT },
          { role: 'user', content: sectionMessage(s, pages) },
        ],
        [],
        { maxTokens: 8000, temperature: 0.1 },
      );
      raw = messageText(res.message.content ?? '');
    } catch (err) {
      console.warn('knowledge import: model unavailable, splitting by headings:', err instanceof Error ? err.message : err);
    }
    const parsed = parseSplit(raw, s);
    if (parsed.fallback) fellBack++;
    proposals.push(...parsed.proposals);
    job.done++;
  }
  if (fellBack) {
    job.warnings.push(
      `${fellBack === sections.length ? 'The model could not split this document' : `The model could not split ${fellBack} of ${sections.length} sections`}, so ${fellBack === 1 ? 'it was' : 'they were'} split by the document's own headings instead. Check the kinds and titles before saving.`,
    );
  }

  // Slugs stay unique; a proposal that matches an existing document by slug or title
  // is flagged so the reviewer can choose to update it instead of adding a duplicate.
  const existing = db
    .select({ id: knowledgeDocs.id, title: knowledgeDocs.title, slug: knowledgeDocs.slug, status: knowledgeDocs.status })
    .from(knowledgeDocs)
    .where(eq(knowledgeDocs.projectId, job.projectId))
    .all();
  const bySlug = new Map(existing.map((d) => [d.slug, d]));
  const byTitle = new Map(existing.map((d) => [d.title.trim().toLowerCase(), d]));
  const clashes = proposals.map((p) => bySlug.get(p.slug) ?? byTitle.get(p.title.trim().toLowerCase()) ?? null);
  job.proposals = dedupeSlugs(proposals, bySlug.keys()).map((p, i) => ({ ...p, clash: clashes[i] ?? null }));
  job.status = 'done';
}
