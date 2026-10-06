import { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { AlertTriangle, ChevronDown, Copy, FileText, KeyRound, ShieldAlert, Upload, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { Panel, Segmented, Spinner, Switch } from './ui';

type Kind = 'runbook' | 'note' | 'fact';
type Env = 'dev' | 'staging' | 'prod';

interface Proposal {
  sectionId: string;
  kind: Kind;
  title: string;
  slug: string;
  body: string;
  tags: string[];
  envs: Env[];
  source: string;
  fromPage: number;
  toPage: number;
  secrets: string[];
  injection: string[];
  clash: { id: string; title: string; slug: string; status: string } | null;
}

interface Job {
  id: string;
  status: 'running' | 'done' | 'failed';
  done: number;
  total: number;
  error: string | null;
  warnings: string[];
  sections: Array<{ id: string; file: string; fromPage: number; toPage: number; paged: boolean; text: string; pages: string[] }>;
  proposals: Proposal[];
}

/** A proposal as the reviewer is editing it. */
interface Draft extends Omit<Proposal, 'tags'> {
  key: number;
  include: boolean;
  tags: string;
  pinned: boolean;
  /** Update the clashing document instead of creating a new one. */
  replace: boolean;
}

const ACCEPT = '.pdf,.docx,.md,.markdown,.txt';
const MAX_FILES = 5;
const MAX_BYTES = 10 * 1024 * 1024;
const KIND_LABEL: Record<Kind, string> = { runbook: 'Runbook', note: 'Note', fact: 'Fact' };

const readBase64 = (f: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(new Error(`Could not read ${f.name}`));
    r.readAsDataURL(f);
  });

/**
 * Import existing documents: upload, let the model split them into runbooks, notes and
 * facts, then review and edit every proposal before anything is saved.
 */
export function KnowledgeImport({ projectId, isAdmin, onClose, onSaved }: {
  projectId: string;
  isAdmin: boolean;
  onClose: () => void;
  onSaved: (message: string) => void;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragging, setDragging] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [active, setActive] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const addFiles = (list: FileList | File[]) => {
    setError(null);
    const next = [...files];
    for (const f of Array.from(list)) {
      if (!/\.(pdf|docx|md|markdown|txt)$/i.test(f.name)) { setError(`${f.name}: only PDF, Word (.docx), Markdown and text files can be imported.`); continue; }
      if (f.size > MAX_BYTES) { setError(`${f.name} is larger than 10 MB.`); continue; }
      if (!next.some((x) => x.name === f.name && x.size === f.size)) next.push(f);
    }
    if (next.length > MAX_FILES) setError(`Import at most ${MAX_FILES} files at a time.`);
    setFiles(next.slice(0, MAX_FILES));
  };

  const upload = useMutation({
    mutationFn: async () =>
      post<{ id: string }>('/knowledge/import', {
        projectId,
        files: await Promise.all(files.map(async (f) => ({ name: f.name, data: await readBase64(f) }))),
      }),
    onSuccess: (r) => setJobId(r.id),
    onError: (e) => setError(e instanceof Error ? e.message : 'Upload failed'),
  });

  const job = useQuery({
    queryKey: ['knowledge-import', jobId],
    queryFn: () => api<Job>(`/knowledge/import/${jobId}`),
    enabled: !!jobId && !drafts,
    refetchInterval: (q) => (q.state.data?.status === 'running' ? 1500 : false),
  });

  useEffect(() => {
    const j = job.data;
    if (j?.status !== 'done' || drafts) return;
    setDrafts(
      j.proposals.map((p, key) => ({ ...p, key, include: true, tags: p.tags.join(', '), pinned: p.kind === 'fact', replace: false })),
    );
    setActive(0);
  }, [job.data, drafts]);

  const chosen = drafts?.filter((d) => d.include) ?? [];
  const save = useMutation({
    mutationFn: () =>
      post<{ saved: number; status: string }>('/knowledge/import/save', {
        projectId,
        docs: chosen.map((d) => ({
          kind: d.kind,
          title: d.title.trim(),
          slug: d.replace && d.clash ? d.clash.slug : d.slug,
          body: d.body,
          tags: d.tags.split(',').map((t) => t.trim()).filter(Boolean),
          scope: d.envs.length ? { envs: d.envs } : {},
          pinned: d.pinned,
          source: d.source,
          ...(d.replace && d.clash ? { replaceId: d.clash.id } : {}),
        })),
      }),
    onSuccess: (r) => onSaved(`${r.saved} document${r.saved === 1 ? '' : 's'} saved${r.status === 'draft' ? ' as drafts for an admin to approve' : ' and approved'}.`),
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save'),
  });

  // ---- 1. pick files -------------------------------------------------------
  if (!jobId) {
    return (
      <Panel title="Import documents" action={<button className="btn-quiet" onClick={onClose} aria-label="Close"><X size={15} /></button>}>
        <div className="space-y-4 px-5 pb-5 pt-1">
          <p className="text-xs leading-relaxed text-muted">
            Upload runbooks, wiki exports or handbooks. SupOps reads the text, splits it into separate runbooks, notes
            and facts, and shows you each one to check and edit. Nothing is saved until you choose to.
          </p>
          <button
            type="button"
            onClick={() => input.current?.click()}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(e.dataTransfer.files); }}
            className={clsx(
              'flex w-full flex-col items-center gap-2 rounded-inner border border-dashed px-4 py-10 text-center transition-colors',
              dragging ? 'border-blue bg-blue/10' : 'border-edge bg-tile-2/50 hover:border-blue/50',
            )}
          >
            <Upload size={22} className="text-blue-text" />
            <span className="text-sm text-ink">{dragging ? 'Drop to add' : 'Drop files here, or click to choose'}</span>
            <span className="text-[11px] text-muted">PDF, Word (.docx), Markdown or text · up to {MAX_FILES} files, 10 MB each</span>
          </button>
          <input ref={input} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ''; }} />
          {!!files.length && (
            <ul className="space-y-1.5">
              {files.map((f) => (
                <li key={f.name + f.size} className="flex items-center gap-2 rounded-inner border border-hairline bg-tile-2/60 px-3 py-2 text-sm">
                  <FileText size={14} className="shrink-0 text-cyan" />
                  <span className="min-w-0 flex-1 truncate text-ink">{f.name}</span>
                  <span className="text-[11px] text-muted">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
                  <button className="text-muted hover:text-red" onClick={() => setFiles(files.filter((x) => x !== f))} aria-label={`Remove ${f.name}`}><X size={13} /></button>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-muted">
            The text is sent to the model set in Settings to split it. Passwords, keys and tokens found in it are replaced with [REDACTED].
          </p>
          {error && <p className="rounded-inner border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">{error}</p>}
          <div className="flex gap-2">
            <button className="btn-primary" disabled={!files.length || upload.isPending} onClick={() => upload.mutate()}>
              {upload.isPending ? <Spinner /> : <Upload size={15} />} Read and split
            </button>
            <button className="btn-ghost" onClick={onClose}>Cancel</button>
          </div>
        </div>
      </Panel>
    );
  }

  // ---- 2. working ----------------------------------------------------------
  const j = job.data;
  if (!drafts) {
    const failed = j?.status === 'failed' || job.isError;
    return (
      <Panel title="Import documents">
        <div className="space-y-4 px-5 pb-6 pt-2">
          {failed ? (
            <>
              <p className="rounded-inner border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">
                {j?.error ?? (job.error instanceof Error ? job.error.message : 'The import failed.')}
              </p>
              <div className="flex gap-2">
                <button className="btn-ghost" onClick={() => { setJobId(null); setError(null); }}>Try other files</button>
                <button className="btn-ghost" onClick={onClose}>Close</button>
              </div>
            </>
          ) : (
            <div className="flex flex-col items-center gap-3 py-8 text-center">
              <Spinner className="text-blue-text" />
              <p className="text-sm text-ink">
                {!j?.total ? 'Reading the files…' : `Splitting into runbooks, notes and facts — section ${Math.min(j.done + 1, j.total)} of ${j.total}`}
              </p>
              {!!j?.total && (
                <div className="h-1.5 w-64 overflow-hidden rounded-full bg-tile-2">
                  <div className="h-full rounded-full bg-blue transition-all" style={{ width: `${(j.done / j.total) * 100}%` }} />
                </div>
              )}
              <p className="text-[11px] text-muted">Long documents take a minute or two. You can keep this page open.</p>
            </div>
          )}
        </div>
      </Panel>
    );
  }

  // ---- 3. review -----------------------------------------------------------
  const d = drafts[active];
  const set = (patch: Partial<Draft>) => setDrafts(drafts.map((x, i) => (i === active ? { ...x, ...patch } : x)));
  const section = j?.sections.find((s) => s.id === d?.sectionId);
  // Just the pages this proposal came from, when the file has pages.
  const original = section && d
    ? section.paged && section.pages.length
      ? section.pages.slice(d.fromPage - section.fromPage, d.toPage - section.fromPage + 1).map((t, i) => `— page ${d.fromPage + i} —\n${t.trim()}`).join('\n\n')
      : section.text
    : '';
  const flagged = drafts.filter((x) => x.secrets.length || x.injection.length || x.clash).length;
  const toggleEnv = (e: Env) => d && set({ envs: d.envs.includes(e) ? d.envs.filter((x) => x !== e) : [...d.envs, e] });

  return (
    <Panel
      title={`Review ${drafts.length} proposed document${drafts.length === 1 ? '' : 's'}`}
      action={<button className="btn-quiet" onClick={onClose} aria-label="Close"><X size={15} /></button>}
    >
      <div className="space-y-4 px-5 pb-5 pt-1">
        <p className="text-xs text-muted">
          Check each one, edit anything that is off, and untick what you do not want. {flagged ? `${flagged} need${flagged === 1 ? 's' : ''} a look (marked).` : ''}
        </p>
        {j?.warnings.map((w) => (
          <p key={w} className="flex gap-2 rounded-inner border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber"><AlertTriangle size={14} className="mt-px shrink-0" /> {w}</p>
        ))}

        {!drafts.length ? (
          <p className="text-sm text-muted">Nothing usable was found in these files.</p>
        ) : (
          <div className="grid gap-4 lg:grid-cols-5">
            {/* the list */}
            <ul className="max-h-[70vh] space-y-1 overflow-y-auto lg:col-span-2">
              <li className="flex items-center gap-2 px-2 pb-1 text-[11px] text-muted">
                <input type="checkbox" aria-label="Select all" checked={drafts.every((x) => x.include)} onChange={(e) => setDrafts(drafts.map((x) => ({ ...x, include: e.target.checked })))} />
                {chosen.length} of {drafts.length} selected
              </li>
              {drafts.map((x, i) => (
                <li key={x.key}>
                  <div className={clsx('flex items-start gap-2 rounded-inner px-2 py-2', i === active ? 'bg-white/[0.06] ring-1 ring-edge' : 'hover:bg-white/[0.03]')}>
                    <input type="checkbox" className="mt-1" aria-label={`Include ${x.title}`} checked={x.include} onChange={(e) => setDrafts(drafts.map((y, k) => (k === i ? { ...y, include: e.target.checked } : y)))} />
                    <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setActive(i)}>
                      <span className={clsx('block truncate text-sm', x.include ? 'text-ink' : 'text-muted line-through')}>{x.title}</span>
                      <span className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
                        <span className="chip border border-edge bg-tile-2">{KIND_LABEL[x.kind]}</span>
                        <span className="truncate">{x.source}</span>
                        {!!x.secrets.length && <KeyRound size={12} className="text-amber" aria-label="Secrets masked" />}
                        {!!x.injection.length && <ShieldAlert size={12} className="text-red" aria-label="Text addressed to the AI" />}
                        {x.clash && <Copy size={12} className="text-amber" aria-label="Matches an existing document" />}
                      </span>
                    </button>
                  </div>
                </li>
              ))}
            </ul>

            {/* the editor */}
            {d && (
              <div className="space-y-3 lg:col-span-3">
                {!!d.secrets.length && (
                  <p className="flex gap-2 rounded-inner border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
                    <KeyRound size={14} className="mt-px shrink-0" /> Secrets were found and replaced with [REDACTED] ({d.secrets.join(', ')}). Keep credentials in Targets, not in knowledge.
                  </p>
                )}
                {!!d.injection.length && (
                  <div className="rounded-inner border border-red/30 bg-red/10 px-3 py-2 text-xs text-red">
                    <p className="flex gap-2"><ShieldAlert size={14} className="mt-px shrink-0" /> This text reads like instructions to the AI. Approved knowledge reaches every run, so remove it unless it is genuinely part of the procedure:</p>
                    <ul className="mt-1 list-disc pl-8 font-mono text-[11px]">{d.injection.map((l) => <li key={l}>{l}</li>)}</ul>
                  </div>
                )}
                {d.clash && (
                  <div className="rounded-inner border border-amber/30 bg-amber/10 px-3 py-2 text-xs text-amber">
                    <p className="flex gap-2"><Copy size={14} className="mt-px shrink-0" /> Matches the existing {d.clash.status} document “{d.clash.title}”.</p>
                    <div className="mt-2 flex flex-wrap gap-4 pl-6 text-ink">
                      <label className="flex items-center gap-1.5"><input type="radio" checked={!d.replace} onChange={() => set({ replace: false })} /> Save as new ({d.slug})</label>
                      <label className={clsx('flex items-center gap-1.5', !isAdmin && d.clash.status !== 'draft' && 'opacity-50')}>
                        <input type="radio" checked={d.replace} disabled={!isAdmin && d.clash.status !== 'draft'} onChange={() => set({ replace: true })} /> Update the existing one
                      </label>
                    </div>
                  </div>
                )}

                <div className="grid gap-3 sm:grid-cols-3">
                  <label className="block sm:col-span-2"><span className="label">Title</span>
                    <input className="input" value={d.title} onChange={(e) => set({ title: e.target.value })} />
                  </label>
                  <div><span className="label">Kind</span>
                    <Segmented label="Kind" value={d.kind} onChange={(k) => set({ kind: k, pinned: k === 'fact' ? true : d.pinned })} options={[{ value: 'runbook', label: 'Runbook' }, { value: 'note', label: 'Note' }, { value: 'fact', label: 'Fact' }]} />
                  </div>
                </div>
                {!d.replace && (
                  <label className="block"><span className="label">Slug</span>
                    <input className="input font-mono" value={d.slug} onChange={(e) => set({ slug: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
                  </label>
                )}
                <label className="block">
                  <span className="label">{d.kind === 'runbook' ? 'Steps (Markdown)' : 'Text (Markdown)'} · about {Math.round(d.body.length / 4)} tokens</span>
                  <textarea className="input min-h-64 resize-y font-mono text-xs leading-relaxed" value={d.body} onChange={(e) => set({ body: e.target.value })} />
                </label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="block"><span className="label">Tags (comma-separated)</span>
                    <input className="input" value={d.tags} onChange={(e) => set({ tags: e.target.value })} />
                  </label>
                  <div><span className="label">Applies to environments (none = all)</span>
                    <div className="flex gap-3 text-xs text-muted">
                      {(['dev', 'staging', 'prod'] as const).map((e) => (
                        <label key={e} className="flex items-center gap-1.5"><input type="checkbox" checked={d.envs.includes(e)} onChange={() => toggleEnv(e)} /> {e}</label>
                      ))}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <Switch label="Pinned" checked={d.pinned} onChange={(v) => set({ pinned: v })} />
                  <span className="text-sm text-ink">Pinned</span>
                  <span className="text-[11px] text-muted">Always included in matching runs.</span>
                </div>
                {section && (
                  <details className="group rounded-inner border border-hairline bg-ground/40">
                    <summary className="flex cursor-pointer list-none items-center gap-2 px-3 py-2 text-xs text-muted hover:text-ink">
                      <ChevronDown size={13} className="transition-transform group-open:rotate-180" /> Original text · {d.source}
                    </summary>
                    <pre className="max-h-72 overflow-auto whitespace-pre-wrap border-t border-hairline px-3 py-2 font-mono text-[11px] leading-relaxed text-muted">{original}</pre>
                  </details>
                )}
              </div>
            )}
          </div>
        )}

        {error && <p className="rounded-inner border border-red/30 bg-red/10 px-3 py-2 text-sm text-red">{error}</p>}
        <div className="flex flex-wrap items-center gap-2 border-t border-hairline pt-4">
          <button
            className="btn-primary"
            disabled={!chosen.length || save.isPending || chosen.some((x) => !x.title.trim() || !x.body.trim() || (!x.replace && !x.slug))}
            onClick={() => { setError(null); save.mutate(); }}
          >
            {save.isPending ? <Spinner /> : null} {isAdmin ? `Save and approve ${chosen.length}` : `Save ${chosen.length} as drafts`}
          </button>
          <button className="btn-ghost" onClick={onClose}>Discard</button>
          <span className="text-[11px] text-muted">
            {isAdmin ? 'Approved documents are used by runs straight away.' : 'Drafts are used once an admin approves them.'}
          </span>
        </div>
      </div>
    </Panel>
  );
}
