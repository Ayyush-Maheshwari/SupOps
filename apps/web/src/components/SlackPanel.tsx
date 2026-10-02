import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Plug, Plus, Save, Trash2 } from 'lucide-react';
import { api, del, post, put } from '../lib/api';
import { Field, Panel, Spinner } from './ui';

interface SlackStatus {
  appTokenConfigured: boolean;
  botTokenConfigured: boolean;
  enabled: boolean;
  connectable: boolean;
  connected: boolean;
}
interface Sub {
  id: string;
  channelId: string;
  channelName: string;
  enabled: boolean;
}
interface Channel {
  id: string;
  name: string;
}

/** Slack connection + this project's channel subscriptions. */
export function SlackPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const [appToken, setAppToken] = useState('');
  const [botToken, setBotToken] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [seeded, setSeeded] = useState(false);

  const status = useQuery({ queryKey: ['slack'], queryFn: () => api<SlackStatus>('/integrations/slack') });
  const subs = useQuery({
    queryKey: ['slackSubs', projectId],
    queryFn: () => api<Sub[]>(`/integrations/slack/subscriptions?projectId=${projectId}`),
    enabled: !!projectId,
  });

  useEffect(() => {
    if (status.data && !seeded) {
      setEnabled(status.data.enabled);
      setSeeded(true);
    }
  }, [status.data, seeded]);

  const invalidate = () => void qc.invalidateQueries({ queryKey: ['slack'] });

  const save = useMutation({
    mutationFn: () =>
      put('/integrations/slack', {
        enabled,
        ...(appToken ? { appToken } : {}),
        ...(botToken ? { botToken } : {}),
      }),
    onSuccess: () => {
      setAppToken('');
      setBotToken('');
      invalidate();
    },
  });

  const test = useMutation({
    mutationFn: () => post<{ ok: boolean; team?: string; error?: string }>('/integrations/slack/test', {}),
  });

  const channels = useQuery({
    queryKey: ['slackChannels'],
    queryFn: () => api<Channel[]>('/integrations/slack/channels'),
    enabled: false,
  });

  const subscribe = useMutation({
    mutationFn: (c: Channel) =>
      post('/integrations/slack/subscriptions', { projectId, channelId: c.id, channelName: c.name }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slackSubs', projectId] }),
  });
  const unsubscribe = useMutation({
    mutationFn: (id: string) => del(`/integrations/slack/subscriptions/${id}`),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['slackSubs', projectId] }),
  });

  const s = status.data;
  const subscribedIds = new Set((subs.data ?? []).map((x) => x.channelId));

  return (
    <Panel title="Slack alerts" accent="bg-violet">
      <div className="space-y-4 p-4">
        <div className="flex items-center gap-2 text-sm">
          <span
            className={clsx(
              'h-2 w-2 rounded-full',
              s?.connected ? 'bg-green' : s?.connectable ? 'bg-amber' : 'bg-dim',
            )}
          />
          <span className="text-muted">
            {s?.connected
              ? 'Connected to Slack (Socket Mode)'
              : s?.connectable
                ? 'Configured — reconnecting…'
                : 'Not connected'}
          </span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="App-level token (xapp-)" hint={s?.appTokenConfigured ? 'Set. Leave blank to keep.' : 'For Socket Mode.'}>
            <input
              className="input font-mono text-xs"
              type="password"
              placeholder={s?.appTokenConfigured ? '•••••••• (unchanged)' : 'xapp-...'}
              value={appToken}
              onChange={(e) => setAppToken(e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="Bot token (xoxb-)" hint={s?.botTokenConfigured ? 'Set. Leave blank to keep.' : 'Reads channels/messages.'}>
            <input
              className="input font-mono text-xs"
              type="password"
              placeholder={s?.botTokenConfigured ? '•••••••• (unchanged)' : 'xoxb-...'}
              value={botToken}
              onChange={(e) => setBotToken(e.target.value)}
              autoComplete="off"
            />
          </Field>
        </div>

        <label className="flex items-center gap-2 text-sm text-ink">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable alert pickup
        </label>

        {test.data && (
          <p className={clsx('text-xs', test.data.ok ? 'text-green' : 'text-red')}>
            {test.data.ok ? `Authenticated with ${test.data.team}` : test.data.error}
          </p>
        )}

        <div className="flex items-center gap-2">
          <button className="btn-ghost" onClick={() => test.mutate()} disabled={test.isPending}>
            {test.isPending ? <Spinner /> : <Plug size={15} />} Test
          </button>
          <button className="btn-primary" onClick={() => save.mutate()} disabled={save.isPending}>
            {save.isPending ? <Spinner /> : save.isSuccess ? <Check size={15} /> : <Save size={15} />} Save
          </button>
        </div>

        {/* Channel subscriptions for this project */}
        <div className="border-t border-hairline pt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted">Watched channels</span>
            <button
              className="btn-ghost !text-xs"
              onClick={() => void channels.refetch()}
              disabled={!s?.botTokenConfigured || channels.isFetching}
            >
              {channels.isFetching ? <Spinner /> : <Plus size={13} />} Add channel
            </button>
          </div>

          {(subs.data ?? []).length === 0 ? (
            <p className="text-xs text-muted">No channels yet. This project receives no alerts until one is added.</p>
          ) : (
            <ul className="space-y-1.5">
              {subs.data!.map((sub) => (
                <li key={sub.id} className="flex items-center gap-2 rounded-inner border border-hairline bg-tile-2/50 px-3 py-1.5 text-xs">
                  <span className="flex-1 font-mono text-cyan">{sub.channelName}</span>
                  <button className="text-muted hover:text-red" onClick={() => unsubscribe.mutate(sub.id)} title="Stop watching">
                    <Trash2 size={13} />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {channels.data && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {channels.data.filter((c) => !subscribedIds.has(c.id)).map((c) => (
                <button
                  key={c.id}
                  className="rounded-full border border-edge bg-tile-2 px-2.5 py-1 font-mono text-[11px] text-muted hover:text-ink"
                  onClick={() => subscribe.mutate(c)}
                >
                  + {c.name}
                </button>
              ))}
              {channels.error && <span className="text-[11px] text-red">Save a bot token first, then Add channel.</span>}
            </div>
          )}
        </div>

        <p className="border-t border-hairline pt-3 text-xs leading-relaxed text-muted">
          SupOps reads alerts over an outbound Socket Mode connection — no public URL. Invite the
          bot to each alert channel in Slack, then add it here. Tokens are encrypted at rest.
        </p>
      </div>
    </Panel>
  );
}
