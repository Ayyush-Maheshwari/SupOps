import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ShieldCheck, X } from 'lucide-react';
import { api, post } from '../lib/api';
import { useApp } from '../lib/store';
import { Spinner } from './ui';
import type { Target, ToolCall, TrustedCommand } from '../lib/types';

/**
 * Trust a command: a standing approval for this project. The command keeps its real
 * risk tier; a matching one simply stops waiting for a person. Exact by default, or
 * "the same command on any file under a folder whose name matches a pattern".
 * Production is never ticked for you.
 */

type Env = 'dev' | 'staging' | 'prod';
const ENVS: Array<{ value: Env; label: string }> = [
  { value: 'dev', label: 'Dev' },
  { value: 'staging', label: 'Staging' },
  { value: 'prod', label: 'Production' },
];

/** The command text a tool call runs, as trust sees it. */
export function trustableText(call: ToolCall): string | null {
  const a = call.argsJson as { command?: unknown; args?: unknown };
  if (call.toolKey === 'ssh_exec' && typeof a.command === 'string') return a.command;
  if (call.toolKey === 'k8s_kubectl' && typeof a.args === 'string') return `kubectl ${a.args.replace(/^kubectl\s+/, '')}`;
  return null;
}

/** A call worth trusting: a shell or kubectl action that needed (or needs) a person. */
export function canTrust(call: ToolCall): boolean {
  return !!trustableText(call) && (call.tier === 'medium' || call.tier === 'high') && !call.riskJson?.trusted;
}

/** The first absolute file path the command names: what a folder rule would be built around. */
function firstFile(command: string): string | null {
  for (const w of command.trim().split(/\s+/)) {
    const t = w.replace(/^['"]|['"]$/g, '');
    if (t.startsWith('/') && !/[*?[\]]/.test(t) && t.lastIndexOf('/') > 0) return t;
  }
  return null;
}

/** "app.log.3.gz" -> "*.gz"; no extension -> the name itself. */
function patternFor(name: string): string {
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.')) : '';
  return ext && ext.length <= 8 ? `*${ext}` : name;
}

export function TrustDialog({ call, onClose, onTrusted }: { call: ToolCall; onClose: () => void; onTrusted?: (rule: TrustedCommand) => void }) {
  const projectId = useApp((s) => s.projectId);
  const isAdmin = useApp((s) => s.user?.globalRole === 'owner' || s.user?.globalRole === 'admin');
  const qc = useQueryClient();
  const command = trustableText(call) ?? '';
  const file = call.toolKey === 'ssh_exec' ? firstFile(command) : null;
  const [kind, setKind] = useState<'exact' | 'folder'>('exact');
  const [folder, setFolder] = useState(file ? file.slice(0, file.lastIndexOf('/')) : '');
  const [glob, setGlob] = useState(file ? patternFor(file.slice(file.lastIndexOf('/') + 1)) : '*');
  const [note, setNote] = useState('');

  const targets = useQuery({ queryKey: ['targets', projectId], queryFn: () => api<Target[]>(`/targets?projectId=${projectId}`), enabled: !!projectId, staleTime: 60_000 });
  const slug = String((call.argsJson as { target?: unknown }).target ?? '');
  const targetEnv = targets.data?.find((t) => t.slug === slug)?.env as Env | undefined;
  // Production is never pre-ticked, even when the command ran there: that is a decision to make on purpose.
  const [envs, setEnvs] = useState<Env[]>(['dev', 'staging']);

  const save = useMutation({
    mutationFn: () =>
      post<TrustedCommand>('/trusted-commands', {
        projectId,
        toolCallId: call.id,
        matchKind: kind,
        ...(kind === 'folder' ? { folder, glob } : {}),
        envs,
        note: note.trim() || undefined,
      }),
    onSuccess: (rule) => {
      void qc.invalidateQueries({ queryKey: ['trusted', projectId] });
      onTrusted?.(rule);
    },
  });

  const summary = useMemo(() => {
    if (kind === 'exact') return <>Only <code className="font-mono text-ink">{command}</code>, exactly as written.</>;
    return (
      <>
        <code className="font-mono text-ink">{command.split(/\s+/).filter((w) => w.startsWith('-') || w === command.split(/\s+/)[0]).join(' ')}</code> on any file named{' '}
        <code className="font-mono text-ink">{glob}</code> under <code className="font-mono text-ink">{folder}/</code>. Never outside that folder, never with
        wildcards, pipes, redirects or a second command.
      </>
    );
  }, [kind, command, folder, glob]);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 backdrop-blur-sm sm:items-center sm:p-6" onClick={onClose}>
      <div className="tile max-h-[92vh] w-full max-w-lg overflow-y-auto rounded-b-none p-5 sm:rounded-b-tile" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Trust this command">
        <div className="mb-3 flex items-center gap-3">
          <ShieldCheck size={18} className="text-green" />
          <h2 className="flex-1 text-base font-semibold text-ink">Trust this command</h2>
          <button className="text-dim hover:text-ink" onClick={onClose} aria-label="Close"><X size={16} /></button>
        </div>
        <p className="mb-4 text-[12.5px] leading-relaxed text-muted">
          A trusted command runs without waiting for approval in this project. It keeps its risk rating, it never applies to automatic runs, and you can untrust it
          any time under <span className="text-ink">Approvals → Trusted</span>.
        </p>

        <pre className="mb-4 overflow-x-auto rounded-inner border border-hairline bg-ground/60 px-3 py-2 font-mono text-[12px] text-ink">{command}</pre>

        <fieldset className="mb-4 space-y-2">
          <legend className="label">What to trust</legend>
          <label className={clsx('flex cursor-pointer items-start gap-2.5 rounded-inner border px-3 py-2.5', kind === 'exact' ? 'border-blue/50 bg-blue/5' : 'border-hairline')}>
            <input type="radio" name="kind" className="mt-0.5" checked={kind === 'exact'} onChange={() => setKind('exact')} />
            <span className="text-[13px] text-ink">Only this exact command</span>
          </label>
          <label className={clsx('flex items-start gap-2.5 rounded-inner border px-3 py-2.5', !file ? 'cursor-not-allowed opacity-50' : 'cursor-pointer', kind === 'folder' ? 'border-blue/50 bg-blue/5' : 'border-hairline')}>
            <input type="radio" name="kind" className="mt-0.5" disabled={!file} checked={kind === 'folder'} onChange={() => setKind('folder')} />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-ink">The same command on any matching file in a folder</span>
              {!file && <span className="block text-[11.5px] text-muted">Only for a command that names a file by its full path.</span>}
              {kind === 'folder' && (
                <span className="mt-2 grid gap-2 sm:grid-cols-[1fr_120px]">
                  <input className="input font-mono text-[12px]" value={folder} onChange={(e) => setFolder(e.target.value)} aria-label="Folder" placeholder="/var/log/app" />
                  <input className="input font-mono text-[12px]" value={glob} onChange={(e) => setGlob(e.target.value)} aria-label="File name pattern" placeholder="*.gz" />
                </span>
              )}
            </span>
          </label>
        </fieldset>

        <fieldset className="mb-4">
          <legend className="label">Where</legend>
          <div className="flex flex-wrap gap-2">
            {ENVS.map((e) => (
              <label key={e.value} className={clsx('flex cursor-pointer items-center gap-2 rounded-full border px-3 py-1.5 text-[12.5px]', envs.includes(e.value) ? (e.value === 'prod' ? 'border-red/50 bg-red/10 text-red' : 'border-blue/50 bg-blue/10 text-blue-text') : 'border-hairline text-muted')}>
                <input type="checkbox" checked={envs.includes(e.value)} onChange={(ev) => setEnvs((cur) => (ev.target.checked ? [...cur, e.value] : cur.filter((x) => x !== e.value)))} />
                {e.label}
              </label>
            ))}
          </div>
          {targetEnv === 'prod' && !envs.includes('prod') && (
            <p className="mt-2 text-[11.5px] text-amber">This command ran on a production machine. Tick Production to trust it there.</p>
          )}
        </fieldset>

        <label className="mb-4 block">
          <span className="label">Note (optional)</span>
          <input className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="Why this is routine, e.g. rotated logs only" maxLength={500} />
        </label>

        <p className="mb-4 rounded-inner border border-hairline bg-tile-2/60 px-3 py-2 text-[12px] leading-relaxed text-muted">{summary}</p>

        {save.isError && <p className="mb-3 text-xs text-red">{(save.error as Error).message}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button className="btn-primary" disabled={save.isPending || !envs.length || (kind === 'folder' && (!folder.trim() || !glob.trim()))} onClick={() => save.mutate()}>
            {save.isPending ? <Spinner /> : <ShieldCheck size={14} />} {isAdmin ? 'Trust it' : 'Suggest to an admin'}
          </button>
          <button className="btn-ghost" onClick={onClose}>Cancel</button>
          {!isAdmin && <span className="text-[11.5px] text-muted">An admin approves suggestions under Approvals → Trusted.</span>}
        </div>
      </div>
    </div>
  );
}

/** "Trusted · by Ayush": shown on an action that ran without waiting because of a trusted command. */
export function TrustedChip({ call }: { call: ToolCall }) {
  const t = call.riskJson?.trusted;
  if (!t) return null;
  return (
    <Link to="/approvals?tab=trusted" className="inline-flex items-center gap-1 rounded-full border border-green/40 bg-green/10 px-2 py-0.5 text-[11px] text-green hover:underline" title="Ran without waiting: a person trusted this command. It keeps its risk rating.">
      <ShieldCheck size={11} /> Trusted{t.byName ? ` · by ${t.byName}` : ''}
    </Link>
  );
}
