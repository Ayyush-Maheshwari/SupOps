import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Plus, Search, Trash2, X } from 'lucide-react';
import { post } from '../lib/api';
import { Field, Panel, Spinner } from './ui';
import type { Target } from '../lib/types';

type Method = 'none' | 'sudo' | 'su' | 'sudo-su';

/**
 * Discover the VMs aliased in a jump host's ~/.ssh/config and create one target per
 * VM in a single action. Each created target reaches its VM via `ssh <alias>` on the
 * jump, sharing the jump's connection and the elevation you set here.
 */
export function DiscoverVms({
  projectId,
  jumpTargets,
  onDone,
}: {
  projectId: string;
  jumpTargets: Target[];
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const [fromTargetId, setFromTargetId] = useState(jumpTargets[0]?.id ?? '');
  const [configPath, setConfigPath] = useState('');
  const [aliases, setAliases] = useState<string[] | null>(null);
  const [raw, setRaw] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [env, setEnv] = useState<'dev' | 'staging' | 'prod'>('prod');
  const [method, setMethod] = useState<Method>('sudo');
  const [pws, setPws] = useState<Array<{ user: string; password: string }>>([{ user: '', password: '' }]);
  const [result, setResult] = useState<{ created: number; updated: number; skipped: string[] } | null>(null);

  const discover = useMutation({
    mutationFn: () =>
      post<{ aliases: string[]; raw?: string }>('/targets/discover', {
        fromTargetId,
        ...(configPath ? { configPath } : {}),
      }),
    onSuccess: (d) => {
      setAliases(d.aliases);
      setRaw(d.raw ?? '');
      setSelected(new Set(d.aliases));
    },
  });

  const create = useMutation({
    mutationFn: () =>
      post<{ created: unknown[]; updated: unknown[]; skipped: string[] }>('/targets/bulk', {
        projectId,
        fromTargetId,
        env,
        aliases: [...selected],
        become: { method },
        becomePasswords: method === 'none' ? [] : pws.filter((p) => p.password),
      }),
    onSuccess: (d) => {
      setResult({ created: d.created.length, updated: d.updated?.length ?? 0, skipped: d.skipped });
      void qc.invalidateQueries({ queryKey: ['targets', projectId] });
    },
  });

  const toggle = (a: string) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(a) ? n.delete(a) : n.add(a);
      return n;
    });

  return (
    <Panel title="Discover VMs behind a jump" accent="bg-violet" className="p-0">
      <div className="space-y-4 p-4">
        {/* 1. pick the jump */}
        <Field label="Jump host" hint="An existing target whose ~/.ssh/config lists the VMs. Its connection and key are reused.">
          {jumpTargets.length ? (
            <select className="input" value={fromTargetId} onChange={(e) => { setFromTargetId(e.target.value); setAliases(null); }}>
              {jumpTargets.map((t) => (
                <option key={t.id} value={t.id}>{t.slug} ({(t.config as { host?: string }).host})</option>
              ))}
            </select>
          ) : (
            <p className="text-xs text-muted">Add the jump/bastion as a target first, then come back here.</p>
          )}
        </Field>

        <details>
          <summary className="cursor-pointer text-[11px] text-muted">
            Advanced: ssh config path (default <code className="font-mono">~/.ssh/config</code>)
          </summary>
          <input
            className="input mt-2 font-mono text-xs"
            placeholder="~/.ssh/config"
            value={configPath}
            onChange={(e) => setConfigPath(e.target.value)}
          />
          <p className="mt-1 text-[11px] text-muted">
            <code className="font-mono">~</code> expands to whichever user SupOps logs in as. Includes
            are followed automatically; override only if the aliases live elsewhere.
          </p>
        </details>

        <button className="btn-ghost" onClick={() => discover.mutate()} disabled={!fromTargetId || discover.isPending}>
          {discover.isPending ? <Spinner /> : <Search size={15} />} Read jump's ssh config
        </button>
        {discover.error && (
          <p className="text-sm text-red">{discover.error instanceof Error ? discover.error.message : 'Discovery failed'}</p>
        )}

        {/* 2. choose aliases + elevation */}
        {aliases && (
          <>
            {aliases.length === 0 ? (
              <p className="text-sm text-muted">No Host aliases found in the jump's ~/.ssh/config.</p>
            ) : (
              <div>
                {raw && (
                  <details className="mb-2">
                    <summary className="cursor-pointer text-[11px] text-muted">
                      Found {aliases.length} host{aliases.length === 1 ? '' : 's'} — show what was read
                    </summary>
                    <pre className="mt-2 max-h-48 overflow-auto rounded-inner border border-hairline bg-tile-2/50 p-2 font-mono text-[10px] text-muted">
                      {raw}
                    </pre>
                  </details>
                )}
                <div className="mb-1 flex items-center justify-between">
                  <span className="label">VMs to add ({selected.size}/{aliases.length})</span>
                  <button className="btn-ghost !min-h-0 !py-1 !text-[11px]" onClick={() => setSelected(new Set(selected.size === aliases.length ? [] : aliases))}>
                    {selected.size === aliases.length ? 'Clear all' : 'Select all'}
                  </button>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {aliases.map((a) => (
                    <button
                      key={a}
                      onClick={() => toggle(a)}
                      className={clsx(
                        'rounded-full border px-2.5 py-1 font-mono text-[11px] transition-colors',
                        selected.has(a) ? 'border-blue/50 bg-blue/15 text-blue-text' : 'border-edge bg-tile-2 text-muted hover:text-ink',
                      )}
                    >
                      {selected.has(a) && <Check size={11} className="mr-1 inline" />}{a}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Environment" hint="Applied to every VM created.">
                <select className="input" value={env} onChange={(e) => setEnv(e.target.value as typeof env)}>
                  <option value="dev">dev</option>
                  <option value="staging">staging</option>
                  <option value="prod">prod</option>
                </select>
              </Field>
              <Field label="Elevation" hint="Applied to every VM created.">
                <select className="input" value={method} onChange={(e) => setMethod(e.target.value as Method)}>
                  <option value="none">None</option>
                  <option value="sudo">sudo</option>
                  <option value="su">su - user</option>
                  <option value="sudo-su">sudo su - user</option>
                </select>
              </Field>
            </div>

            {method !== 'none' && (
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <span className="label">Elevation passwords</span>
                  <button className="btn-ghost !min-h-0 !py-1 !text-[11px]" onClick={() => setPws([...pws, { user: '', password: '' }])}>
                    <Plus size={12} /> Add
                  </button>
                </div>
                <p className="mb-2 text-[11px] text-muted">One per sudo account (blank = default). Applied to every VM.</p>
                <div className="space-y-2">
                  {pws.map((row, i) => (
                    <div key={i} className="flex gap-2">
                      <input className="input w-40 font-mono text-xs" placeholder="sudo user"
                        value={row.user} onChange={(e) => setPws(pws.map((r, j) => j === i ? { ...r, user: e.target.value } : r))} />
                      <input className="input flex-1 font-mono text-xs" type="password" placeholder="password for this user"
                        value={row.password} onChange={(e) => setPws(pws.map((r, j) => j === i ? { ...r, password: e.target.value } : r))} autoComplete="off" />
                      <button className="btn-quiet !min-h-0 !w-9 !px-0" onClick={() => setPws(pws.filter((_, j) => j !== i))}><Trash2 size={13} /></button>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}

        {result && (
          <div className="rounded-inner border border-green/30 bg-green/5 px-3 py-2 text-sm text-green">
            Created {result.created}{result.updated ? `, refreshed ${result.updated}` : ''} target{result.created + result.updated === 1 ? '' : 's'}.
            {result.skipped.length > 0 && (
              <span className="text-muted"> Left alone (a non-jump target owns the name): {result.skipped.join(', ')}.</span>
            )}
          </div>
        )}
        {create.error && (
          <p className="text-sm text-red">{create.error instanceof Error ? create.error.message : 'Could not create targets'}</p>
        )}
      </div>

      <div className="flex justify-end gap-2 border-t border-hairline px-4 py-3">
        <button className="btn-ghost" onClick={onDone}><X size={15} /> Close</button>
        <button
          className="btn-primary"
          onClick={() => create.mutate()}
          disabled={create.isPending || !aliases || selected.size === 0}
        >
          {create.isPending ? <Spinner /> : <Plus size={15} />} Create {selected.size} target{selected.size === 1 ? '' : 's'}
        </button>
      </div>
    </Panel>
  );
}
