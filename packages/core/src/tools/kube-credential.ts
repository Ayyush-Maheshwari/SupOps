import { parse } from 'yaml';
import type { KubeCredential } from './executors/kubectl.ts';

type Named<T> = { name?: string } & T;
interface Kubeconfig {
  clusters?: Named<{ cluster?: Record<string, unknown> }>[];
  users?: Named<{ user?: Record<string, unknown> }>[];
  contexts?: Named<{ context?: { cluster?: string; user?: string; namespace?: string } }>[];
  'current-context'?: string;
}

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);

/**
 * Turn what the operator pasted into the credential SupOps stores for a cluster.
 *
 * Accepts a kubeconfig (YAML or JSON) or a plain `{ server, token, caData }` object.
 * Only self-contained credentials work: exec/auth-provider plugins (gcloud, aws,
 * kubelogin) need cloud CLIs and logins on the SupOps host, and file references
 * (`certificate-authority: /path`) point at files that aren't here. Each failure
 * says what to paste instead.
 */
export function kubeCredentialFromInput(raw: string): { ok: true; cred: KubeCredential } | { ok: false; error: string } {
  let doc: unknown;
  try {
    doc = parse(raw);
  } catch (err) {
    return { ok: false, error: `Could not read that as a kubeconfig: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (!doc || typeof doc !== 'object') return { ok: false, error: 'Paste a kubeconfig, or a JSON object with server + token.' };

  const direct = doc as Record<string, unknown>;
  if (str(direct.server) && !('clusters' in direct)) {
    const cred: KubeCredential = {
      server: str(direct.server)!,
      ...(str(direct.token) ? { token: str(direct.token)! } : {}),
      ...(str(direct.caData) ? { caData: str(direct.caData)! } : {}),
      ...(direct.insecure === true ? { insecure: true } : {}),
    };
    return cred.token ? { ok: true, cred } : { ok: false, error: 'A token is required alongside the API server URL.' };
  }

  const kc = doc as Kubeconfig;
  const contexts = kc.contexts ?? [];
  const ctx =
    contexts.find((c) => c.name === kc['current-context']) ?? (contexts.length === 1 ? contexts[0] : undefined);
  if (!ctx?.context) {
    return { ok: false, error: 'The kubeconfig has no current-context. Set one, or paste a single-context kubeconfig.' };
  }
  const cluster = kc.clusters?.find((c) => c.name === ctx.context!.cluster)?.cluster;
  const user = kc.users?.find((u) => u.name === ctx.context!.user)?.user;
  if (!cluster || !str(cluster.server)) return { ok: false, error: `Context "${ctx.name}" points at a cluster with no server URL.` };
  if (!user) return { ok: false, error: `Context "${ctx.name}" points at a user that is not in the file.` };

  if (user.exec || user['auth-provider']) {
    return {
      ok: false,
      error:
        'This kubeconfig logs in through a cloud plugin (gcloud / aws / kubelogin), which cannot run on the ' +
        'SupOps server. Create a SupOps service account with the setup script and paste the kubeconfig it prints.',
    };
  }
  if (str(cluster['certificate-authority']) || str(user['client-certificate']) || str(user['client-key'])) {
    return {
      ok: false,
      error: 'This kubeconfig references certificate files on your machine. Export it self-contained with ' +
        '`kubectl config view --minify --flatten` and paste that.',
    };
  }

  const token = str(user.token);
  const clientCertData = str(user['client-certificate-data']);
  const clientKeyData = str(user['client-key-data']);
  if (!token && !(clientCertData && clientKeyData)) {
    return { ok: false, error: 'The kubeconfig user has no token or client certificate. Use the setup script to get a token.' };
  }
  return {
    ok: true,
    cred: {
      server: str(cluster.server)!,
      ...(str(cluster['certificate-authority-data']) ? { caData: str(cluster['certificate-authority-data'])! } : {}),
      ...(cluster['insecure-skip-tls-verify'] === true ? { insecure: true } : {}),
      ...(token ? { token } : {}),
      ...(clientCertData ? { clientCertData } : {}),
      ...(clientKeyData ? { clientKeyData } : {}),
      ...(str(ctx.context.namespace) ? { namespace: str(ctx.context.namespace)! } : {}),
    },
  };
}
