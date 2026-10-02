import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_RISK_POLICY } from '@supops/db';
import type { ResolvedTarget, ToolDef } from './types.ts';
import { kubectlTool } from './builtin.ts';
import { kubeconfigJson, kubeSecretValues, planKubectl } from './executors/kubectl.ts';
import { kubeCredentialFromInput } from './kube-credential.ts';
import { assessRisk } from '../risk/index.ts';

const cluster: ResolvedTarget = {
  id: 'k1', slug: 'yta-gke', kind: 'k8s', env: 'staging', sensitivity: 1, description: null,
  config: { kind: 'k8s', server: 'https://34.1.2.3', allowedNamespaces: [] },
  credentialId: null, protectedPaths: null, writablePaths: null, unitAllowlist: null,
};
const limited: ResolvedTarget = {
  ...cluster,
  config: { kind: 'k8s', server: 'https://34.1.2.3', allowedNamespaces: ['yta'], defaultNamespace: 'yta' },
};

const tier = (args: string, target = cluster) =>
  assessRisk({
    def: kubectlTool as unknown as ToolDef<never>,
    args: { args, intent: 'x', expected_effect: 'y' },
    rendered: `kubectl ${args}`,
    target,
    policy: DEFAULT_RISK_POLICY,
  }).tier;

test('reads run freely, changes are gated, cluster-wide deletes are forbidden', () => {
  assert.equal(tier('get pods -A'), 'read_only');
  assert.equal(tier('logs deploy/api -n yta --tail=200'), 'read_only');
  assert.equal(tier('describe pod api-7d9 -n yta'), 'read_only');
  assert.equal(tier('delete pod api-7d9 -n yta'), 'medium');
  assert.equal(tier('rollout restart deploy/api -n yta'), 'medium');
  assert.equal(tier('patch deploy api -n yta -p {}'), 'high');
  assert.equal(tier('delete namespace yta'), 'forbidden');
});

test('reading Secrets pauses for approval; describing them does not', () => {
  assert.equal(tier('get secret db-creds -n yta -o yaml'), 'medium');
  assert.equal(tier('get secrets -A'), 'medium');
  assert.equal(tier('get cm,secret -n yta'), 'medium');
  assert.equal(tier('get --raw /api/v1/namespaces/yta/secrets'), 'medium');
  assert.equal(tier('describe secret db-creds -n yta'), 'read_only');
  assert.equal(tier('get --raw /version'), 'read_only');
});

test('a leading "kubectl" in args is tolerated', () => {
  assert.equal(tier('kubectl get nodes'), 'read_only');
});

test('shell constructs are refused -- there is no shell', () => {
  assert.equal(tier('get pods | sh'), 'forbidden');
  assert.equal(tier('get pods; rm -rf /'), 'forbidden');
  assert.equal(tier('get pods > /tmp/x'), 'forbidden');
  assert.equal(tier('get pods $(whoami)'), 'forbidden');
});

test('identity, local-file and streaming flags are refused', () => {
  for (const a of [
    'get pods --as=system:admin', 'get pods --kubeconfig=/root/.kube/config', 'get pods --context prod',
    'apply -f /app/data/.secrets.env', 'create secret generic x --from-file=/app/data/.secrets.env',
    'get pods -w', 'logs -f api', 'exec -it api -- sh', 'config view --raw', 'cp api:/etc/passwd /tmp/p',
    'port-forward svc/api 8080:80',
  ]) {
    const plan = planKubectl(a, {});
    assert.equal(plan.ok, false, a);
  }
});

test('allowed namespaces confine -n and forbid -A', () => {
  assert.equal(planKubectl('get pods -n yta', limited.config as never).ok, true);
  assert.equal(planKubectl('get pods', limited.config as never).ok, true);
  assert.equal(planKubectl('get pods -n kube-system', limited.config as never).ok, false);
  assert.equal(planKubectl('get pods --namespace=kube-system', limited.config as never).ok, false);
  assert.equal(planKubectl('get pods -A', limited.config as never).ok, false);
  assert.equal(tier('get pods -n kube-system', limited), 'forbidden');
});

test('exec recurses into the container command', () => {
  assert.equal(tier('exec api-7d9 -n yta -- df -h'), 'read_only');
  assert.equal(tier('exec api-7d9 -n yta -- rm -rf /data'), 'high');
  assert.equal(tier('exec api-7d9 -n yta -- rm -rf /'), 'forbidden');
});

const TOKEN = 'eyJhbGciOiJSUzI1NiIsImtpZCI6ImFiYyJ9.payload.sig';
const kubeconfig = `
apiVersion: v1
kind: Config
current-context: supops
clusters:
- name: gke
  cluster:
    server: https://34.1.2.3
    certificate-authority-data: Q0FEQVRB
users:
- name: supops
  user:
    token: ${TOKEN}
contexts:
- name: supops
  context: { cluster: gke, user: supops, namespace: yta }
`;

test('a token kubeconfig becomes a self-contained credential', () => {
  const r = kubeCredentialFromInput(kubeconfig);
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.deepEqual(r.cred, { server: 'https://34.1.2.3', caData: 'Q0FEQVRB', token: TOKEN, namespace: 'yta' });
  const json = JSON.parse(kubeconfigJson(r.cred, 'yta'));
  assert.equal(json.users[0].user.token, TOKEN);
  assert.equal(json.contexts[0].context.namespace, 'yta');
  assert.deepEqual(kubeSecretValues(r.cred).map((s) => s.id), ['k8s-token']);
});

test('cloud-plugin and file-referencing kubeconfigs are rejected with guidance', () => {
  const gcloud = kubeconfig.replace(`token: ${TOKEN}`, 'exec:\n      command: gke-gcloud-auth-plugin');
  const r = kubeCredentialFromInput(gcloud);
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /service account/);
  const files = kubeconfig.replace('certificate-authority-data: Q0FEQVRB', 'certificate-authority: /home/me/ca.crt');
  const f = kubeCredentialFromInput(files);
  assert.equal(f.ok, false);
  if (!f.ok) assert.match(f.error, /--flatten/);
});

test('server + token JSON is accepted directly', () => {
  const r = kubeCredentialFromInput(JSON.stringify({ server: 'https://k3s:6443', token: TOKEN, caData: 'Q0E=' }));
  assert.ok(r.ok);
});
