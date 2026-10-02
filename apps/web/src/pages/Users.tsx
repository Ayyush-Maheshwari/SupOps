import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Plus, ShieldCheck, UserPlus } from 'lucide-react';
import { api, del, patch, post } from '../lib/api';
import { PageHeader } from '../components/Layout';
import { Empty, Field, Panel, Spinner } from '../components/ui';
import type { AdminUser } from '../lib/types';

const ROLES = ['owner', 'admin', 'member'] as const;

export function Users() {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', globalRole: 'member', password: '' });

  const users = useQuery({ queryKey: ['users'], queryFn: () => api<AdminUser[]>('/users') });
  const authCfg = useQuery({ queryKey: ['authConfig'], queryFn: () => api<{ allowedEmailDomains: string[] }>('/auth/config') });
  const domains = authCfg.data?.allowedEmailDomains ?? [];
  const emailOk = domains.length === 0 || domains.includes(form.email.trim().toLowerCase().split('@')[1] ?? '');
  const invalidate = () => void qc.invalidateQueries({ queryKey: ['users'] });

  const create = useMutation({
    mutationFn: () => post<AdminUser>('/users', form),
    onSuccess: () => {
      setForm({ name: '', email: '', globalRole: 'member', password: '' });
      setAdding(false);
      invalidate();
    },
  });
  const update = useMutation({
    mutationFn: ({ id, body }: { id: string; body: Record<string, unknown> }) => patch<AdminUser>(`/users/${id}`, body),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => del(`/users/${id}`),
    onSuccess: invalidate,
  });

  return (
    <>
      <PageHeader
        title="Users"
        subtitle="Give each teammate their own login. Every approval is recorded against the account that made it."
        action={
          <button className="btn-primary" onClick={() => setAdding((v) => !v)}>
            <UserPlus size={16} /> Add user
          </button>
        }
      />

      <div className="space-y-4 p-6">
        {adding && (
          <Panel title="New user" accent="bg-violet">
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <Field label="Name"><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
              <Field
                label="Email"
                hint={domains.length ? `Must be @${domains.join(' or @')}` : undefined}
              >
                <input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
              </Field>
              <Field label="Role">
                <select className="input" value={form.globalRole} onChange={(e) => setForm({ ...form, globalRole: e.target.value })}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </Field>
              <Field label="Temporary password" hint="At least 6 characters. They can be reset later.">
                <input className="input" type="text" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
              </Field>
              <div className="flex items-center gap-2 sm:col-span-2">
                <button
                  className="btn-primary"
                  disabled={create.isPending || !form.name || !form.email || !emailOk || form.password.length < 6}
                  onClick={() => create.mutate()}
                >
                  {create.isPending ? <Spinner /> : <Plus size={15} />} Create user
                </button>
                <button className="btn-ghost" onClick={() => setAdding(false)}>Cancel</button>
                {create.error && (
                  <span className="text-sm text-red">
                    {create.error instanceof Error ? create.error.message : 'Could not create user'}
                  </span>
                )}
              </div>
            </div>
          </Panel>
        )}

        <Panel>
          {users.isLoading ? (
            <div className="grid place-items-center py-12 text-muted"><Spinner /></div>
          ) : users.data?.length ? (
            <ul className="divide-y divide-hairline">
              {users.data.map((u) => (
                <li key={u.id} className="flex flex-wrap items-center gap-3 px-5 py-3.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={clsx('text-[13px] font-medium', u.disabledAt ? 'text-muted line-through' : 'text-ink')}>{u.name}</span>
                      {u.disabledAt && <span className="chip border border-edge bg-tile-2 text-muted">disabled</span>}
                    </div>
                    <div className="truncate text-[11px] text-muted">{u.email}</div>
                  </div>

                  <select
                    className="input !min-h-[32px] !w-28 !py-1 text-xs"
                    value={u.globalRole}
                    onChange={(e) => update.mutate({ id: u.id, body: { globalRole: e.target.value } })}
                  >
                    {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                  </select>

                  <button
                    className="btn-ghost !min-h-[32px] !text-xs"
                    onClick={() => {
                      const pw = window.prompt(`New password for ${u.name} (min 6 chars):`);
                      if (pw && pw.length >= 6) update.mutate({ id: u.id, body: { password: pw } });
                    }}
                  >
                    Reset password
                  </button>
                  <button
                    className="btn-ghost !min-h-[32px] !text-xs"
                    onClick={() => update.mutate({ id: u.id, body: { disabled: !u.disabledAt } })}
                  >
                    {u.disabledAt ? 'Enable' : 'Disable'}
                  </button>
                  <button
                    className="btn-ghost !min-h-[32px] !text-xs !text-red hover:!bg-red/10"
                    title="Permanently delete this user (their past attribution becomes unknown). Disable is safer."
                    onClick={() => {
                      if (window.confirm(`Permanently delete ${u.name} (${u.email})? Their past runs/approvals will lose attribution. Disabling is usually safer.`)) {
                        remove.mutate(u.id);
                      }
                    }}
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon={<ShieldCheck size={26} />} title="No users" hint="Add a teammate to give them their own login." />
          )}
        </Panel>

        {update.error && (
          <p className="text-sm text-red">{update.error instanceof Error ? update.error.message : 'Could not update user'}</p>
        )}
        {remove.error && (
          <p className="text-sm text-red">{remove.error instanceof Error ? remove.error.message : 'Could not delete user'}</p>
        )}
      </div>
    </>
  );
}
