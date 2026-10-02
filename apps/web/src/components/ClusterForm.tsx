import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Check, Copy } from 'lucide-react';
import { patch, post } from '../lib/api';
import { copyText } from '../lib/clipboard';
import { Field, Panel, Spinner } from './ui';
import type { Target } from '../lib/types';

type Access = 'view' | 'edit';

/**
 * One-time setup, run by someone with admin on the cluster (Cloud Shell, a laptop with
 * `gcloud`/`aws`/`az` credentials, or the k3s master). It creates a `supops` service
 * account and prints a self-contained kubeconfig to paste below -- so SupOps needs no
 * cloud CLI or cloud login of its own, and the same steps work on every provider.
 */
const setupScript = (access: Access) => String.raw`# Run where kubectl already has admin on the cluster. Prints a kubeconfig for SupOps.
set -e
kubectl create namespace supops-system --dry-run=client -o yaml | kubectl apply -f -
kubectl -n supops-system create serviceaccount supops --dry-run=client -o yaml | kubectl apply -f -
# ${access === 'view' ? 'Read-only' : 'Read + change workloads (changes still need approval in SupOps)'}
kubectl create clusterrolebinding supops-${access} --clusterrole=${access} \
  --serviceaccount=supops-system:supops --dry-run=client -o yaml | kubectl apply -f -
# Health checks also read nodes, namespaces, volumes and metrics (not in the built-in roles).
kubectl apply -f - <<'EOF'
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: supops-cluster-read }
rules:
- apiGroups: [""]
  resources: [nodes, namespaces, persistentvolumes]
  verbs: [get, list]
- apiGroups: [metrics.k8s.io]
  resources: [nodes, pods]
  verbs: [get, list]
- apiGroups: [storage.k8s.io]
  resources: [storageclasses]
  verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: supops-cluster-read }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: supops-cluster-read }
subjects: [{ kind: ServiceAccount, name: supops, namespace: supops-system }]
---
apiVersion: v1
kind: Secret
metadata:
  name: supops-token
  namespace: supops-system
  annotations: { kubernetes.io/service-account.name: supops }
type: kubernetes.io/service-account-token
EOF
sleep 3
SERVER=$(kubectl config view --minify -o jsonpath='{.clusters[0].cluster.server}')
CA=$(kubectl -n supops-system get secret supops-token -o jsonpath='{.data.ca\.crt}')
TOKEN=$(kubectl -n supops-system get secret supops-token -o jsonpath='{.data.token}' | base64 -d)
cat <<EOF
apiVersion: v1
kind: Config
current-context: supops
clusters: [{ name: cluster, cluster: { server: $SERVER, certificate-authority-data: $CA } }]
users: [{ name: supops, user: { token: $TOKEN } }]
contexts: [{ name: supops, context: { cluster: cluster, user: supops } }]
EOF`;

/** Add or edit a Kubernetes cluster target (reached through its API server). */
export function ClusterForm({
  projectId,
  existing,
  onDone,
}: {
  projectId: string;
  existing?: Target;
  onDone: () => void;
}) {
  const qc = useQueryClient();
  const isEdit = !!existing;
  const cfg = (existing?.config ?? {}) as { server?: string; defaultNamespace?: string; allowedNamespaces?: string[] };
  const [form, setForm] = useState({
    slug: existing?.slug ?? '',
    name: existing?.name ?? '',
    env: existing?.env ?? ('staging' as 'dev' | 'staging' | 'prod'),
    description: existing?.description ?? '',
    // Never prefilled: the server never returns credentials. Blank on edit = keep.
    kubeconfig: '',
    defaultNamespace: cfg.defaultNamespace ?? '',
    allowedNamespaces: (cfg.allowedNamespaces ?? []).join(', '),
  });
  const [access, setAccess] = useState<Access>('view');
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const set = (k: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm((f) => ({ ...f, [k]: e.target.value }));

  const save = useMutation({
    mutationFn: () => {
      const config = {
        kind: 'k8s' as const,
        server: cfg.server ?? '',
        ...(form.defaultNamespace.trim() ? { defaultNamespace: form.defaultNamespace.trim() } : {}),
        allowedNamespaces: form.allowedNamespaces.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
      };
      const body = {
        name: form.name || form.slug,
        env: form.env,
        description: form.description,
        config,
        ...(form.kubeconfig.trim() ? { secret: form.kubeconfig } : {}),
      };
      return isEdit
        ? patch<Target>(`/targets/${existing.id}`, body)
        : post<Target>('/targets', { ...body, projectId, slug: form.slug });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['targets', projectId] });
      onDone();
    },
    onError: (e) => setError(e instanceof Error ? e.message : 'Could not save the cluster'),
  });

  const copy = async () => {
    const ok = await copyText(setupScript(access));
    setCopied(ok ? 'yes' : 'failed');
    setTimeout(() => setCopied(null), 2500);
  };

  return (
    <Panel title={isEdit ? `Edit ${existing.slug}` : 'Add a Kubernetes cluster'} accent="bg-blue" className="p-4">
      <div className="grid gap-4 p-4 sm:grid-cols-2">
        <Field label="Slug" hint={isEdit ? 'Fixed — agents and past runs refer to it.' : 'The name the agent will use, e.g. yta-gke.'}>
          <input className="input disabled:opacity-60" placeholder="yta-gke" value={form.slug} onChange={set('slug')} disabled={isEdit} />
        </Field>
        <Field label="Display name">
          <input className="input" placeholder="YTA production (GKE)" value={form.name} onChange={set('name')} />
        </Field>
        <Field label="Environment" hint="Production raises the risk tier of anything that changes state.">
          <select className="input" value={form.env} onChange={set('env')}>
            <option value="dev">dev</option>
            <option value="staging">staging</option>
            <option value="prod">prod</option>
          </select>
        </Field>
        <Field label="Description" hint="Helps the agent pick the right cluster.">
          <input className="input" placeholder="GKE asia-south1, app in namespace yta" value={form.description} onChange={set('description')} />
        </Field>

        <div className="sm:col-span-2">
          <details className="rounded-inner border border-hairline bg-tile-2/40 p-3" open={!isEdit}>
            <summary className="cursor-pointer text-sm text-ink">1 · Create a SupOps service account on the cluster</summary>
            <p className="mt-2 text-[11px] text-muted">
              Run this once wherever kubectl already has admin: GCP Cloud Shell (after
              <code className="mx-1 font-mono">gcloud container clusters get-credentials …</code>), a laptop logged
              in to AWS/Azure, or the k3s master. It prints a kubeconfig with a token. SupOps needs no cloud CLI or login.
            </p>
            <div className="mt-2 flex items-center gap-2">
              <select className="input !w-auto" value={access} onChange={(e) => setAccess(e.target.value as Access)}>
                <option value="view">Read-only (view)</option>
                <option value="edit">Read + change workloads (edit)</option>
              </select>
              <button type="button" className="btn-ghost" onClick={() => void copy()}>
                {copied === 'yes' ? <Check size={14} /> : <Copy size={14} />} {copied === 'yes' ? 'Copied' : 'Copy script'}
              </button>
              {copied === 'failed' && (
                <span className="text-[11px] text-amber">The browser blocked copying: select the script below and press Ctrl+C.</span>
              )}
            </div>
            <pre className="mt-2 max-h-56 select-all overflow-auto rounded-inner border border-hairline bg-tile-2/60 p-2 font-mono text-[10px] text-muted">
              {setupScript(access)}
            </pre>
            <p className="mt-2 text-[11px] text-muted">
              Private clusters (e.g. GKE with authorized networks): the SupOps server's IP must be allowed to reach the API server.
            </p>
          </details>
        </div>

        <div className="sm:col-span-2">
          <Field
            label={isEdit ? '2 · Replace kubeconfig (optional)' : '2 · Paste the kubeconfig it printed'}
            hint={isEdit
              ? 'Leave blank to keep the stored credential.'
              : 'Or any self-contained kubeconfig with a token/client cert (kubectl config view --minify --flatten). Encrypted at rest; cloud-plugin logins are not supported.'}
          >
            <textarea
              className="input min-h-[120px] font-mono text-[11px]"
              placeholder={'apiVersion: v1\nkind: Config\nclusters: …'}
              value={form.kubeconfig}
              onChange={set('kubeconfig')}
              spellCheck={false}
              autoComplete="off"
            />
          </Field>
        </div>

        <Field label="Default namespace" hint="Used when a command names none. Blank = the kubeconfig's, else default.">
          <input className="input font-mono text-xs" placeholder="yta" value={form.defaultNamespace} onChange={set('defaultNamespace')} />
        </Field>
        <Field label="Allowed namespaces (optional)" hint="Comma-separated. When set, agents can only name these and never use -A.">
          <input className="input font-mono text-xs" placeholder="yta, yta-staging" value={form.allowedNamespaces} onChange={set('allowedNamespaces')} />
        </Field>
      </div>

      {error && <p className="px-4 text-sm text-red">{error}</p>}

      <div className="flex justify-end gap-2 border-t border-hairline px-4 py-3">
        <button className="btn-ghost" onClick={onDone}>Cancel</button>
        <button
          className="btn-primary"
          onClick={() => save.mutate()}
          disabled={save.isPending || !form.slug || (!isEdit && !form.kubeconfig.trim())}
        >
          {save.isPending ? <Spinner /> : null} {isEdit ? 'Save changes' : 'Add cluster'}
        </button>
      </div>
    </Panel>
  );
}
