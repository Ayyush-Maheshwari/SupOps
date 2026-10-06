import type { ResolvedTarget } from '@supops/core';
import { loadTargets, resolveSecret } from '@supops/core';
import type { ObservabilityConfig } from '@supops/db';
import { isObservabilityKind } from '@supops/shared';
import { db } from '../context.ts';

/** A project's enabled observability connections, with their credentials attached. */
export function projectConnections(projectId: string, kinds?: string[]): ResolvedTarget[] {
  return loadTargets(db, projectId)
    .filter((t) => isObservabilityKind(t.kind) && (!kinds || kinds.includes(t.kind)))
    .map((t) => {
      const secret = resolveSecret(db, t);
      return secret ? { ...t, secret: secret.value } : t;
    });
}

export const obsConfig = (t: ResolvedTarget) => t.config as unknown as ObservabilityConfig;

/** Alert import is on by default for Alertmanager, off for the others until switched on. */
export const importsAlerts = (t: ResolvedTarget) =>
  ['alertmanager', 'prometheus', 'grafana'].includes(t.kind) && (obsConfig(t).ingestAlerts ?? t.kind === 'alertmanager');

/** Watching is on by default for metrics connections. */
export const watchesMetrics = (t: ResolvedTarget) => ['prometheus', 'grafana'].includes(t.kind) && (obsConfig(t).watch ?? true);
