import type { BecomeMethod, Env, RiskTier, Role, ToolSpec } from '@supops/shared';

/**
 * Autonomy policy. Set on a project; an agent may narrow it but NEVER widen it
 * (enforced at agent-save time, not at runtime, so the guarantee is a data
 * invariant rather than something the hot path has to remember).
 */
export interface RiskPolicy {
  /** Tiers at or below this execute without asking. Default 'low'. */
  autoExecuteMaxTier: RiskTier;
  approverRoleByTier: Partial<Record<RiskTier, Role>>;
  /** At or above this tier the approver must differ from whoever started the run. */
  requireSecondPersonAtTier: RiskTier | null;
  ttlMsByTier: Partial<Record<RiskTier, number>>;
  onExpiry: 'continue_as_denied' | 'abort_run';
  /** Per run. Default 1 -- prevents approval storms that train people to click yes. */
  maxConcurrentApprovals: number;
}

export const DEFAULT_RISK_POLICY: RiskPolicy = {
  autoExecuteMaxTier: 'low',
  approverRoleByTier: { medium: 'operator', high: 'admin' },
  requireSecondPersonAtTier: 'high',
  ttlMsByTier: { medium: 30 * 60_000, high: 2 * 60 * 60_000 },
  onExpiry: 'continue_as_denied',
  maxConcurrentApprovals: 1,
};

export type TargetConfig =
  | {
      kind: 'ssh';
      host: string;
      port: number;
      user: string;
      sudo: boolean;
      /** Pinned on first connect; a change means MITM or a rebuild. Never auto-accept silently. */
      hostKeyFingerprint?: string;
      /**
       * How to elevate privilege before every command. Enforced by the executor,
       * not by the model. The elevation password (if any) is a separate credential
       * referenced by the target's `becomeCredentialId`, never stored here.
       */
      become?: {
        method: BecomeMethod;
        /** Target user for `su` / `sudo -u`. Required for su and sudo-su. */
        user?: string;
        /** Request a PTY, for sudoers configured with `Defaults requiretty`. */
        pty?: boolean;
        /**
         * Advanced escape hatch for environments that need something other than
         * sudo/su. Must contain `{{CMD}}`, which is replaced with the shell-quoted
         * command. When set, it overrides `method`.
         */
        template?: string;
      };
      /**
       * A second hop: after connecting to `host` (the jump/bastion), reach the real
       * machine by running `ssh <alias> …` ON the jump, so the jump's own ~/.ssh/config
       * resolves the alias, hostname and key. Transport only -- never part of the
       * classified command. Commands (and any elevation) run on the inner machine.
       */
      via?: {
        alias: string;
        /** Force a PTY on the inner ssh (`-tt`). Default true; needed for far-side sudo. */
        pty?: boolean;
        /** Rare extra ssh flags, e.g. `-o StrictHostKeyChecking=accept-new`. */
        sshFlags?: string;
      };
      /**
       * Run each command in a login+interactive shell (`bash -lic`) so the login
       * user's aliases, functions and PATH from ~/.bashrc / ~/.profile are available.
       * Needed when a command is a shell alias (e.g. `prodrosa`) rather than a binary.
       * Transport only -- the classified command is still the raw command, not the
       * shell wrapper.
       */
      loginShell?: boolean;
      /**
       * A command run before every command, in the same shell invocation (e.g. an
       * alias that logs into a cluster). Runs statelessly on each call. Transport only.
       */
      prelude?: string;
    }
  | { kind: 'docker'; socketPath?: string; host?: string; port?: number; containerAllowlist?: string[] }
  | { kind: 'k8s'; context: string; allowedNamespaces: string[]; minReplicas: number; maxReplicas: number }
  | {
      kind: 'http';
      baseUrl: string;
      allowPrivateNetwork: boolean;
      allowedCidrs?: string[];
      defaultHeaders?: Record<string, string>;
    };

export type CredentialType =
  | 'ssh_password'
  | 'ssh_key'
  | 'sudo_password'
  | 'docker_tls'
  | 'kubeconfig'
  | 'bearer'
  | 'basic'
  | 'header';

/** Budget guards. Without these a wedged agent burns a daily free-tier quota in minutes. */
export interface RunBudget {
  maxIterations: number;
  maxToolCalls: number;
  /** Running time only -- explicitly EXCLUDES time parked in awaiting_approval. */
  maxWallClockMs: number;
  /** 8KB head + 8KB tail, middle elided with a byte count so the model knows. */
  maxOutputBytesPerCall: number;
}

export const DEFAULT_RUN_BUDGET: RunBudget = {
  maxIterations: 40,
  maxToolCalls: 120,
  maxWallClockMs: 30 * 60_000,
  maxOutputBytesPerCall: 16_384,
};

/** What the model was shown, frozen at run start for audit and reproducibility. */
export interface TargetSummary {
  slug: string;
  kind: string;
  env: Env;
  description: string | null;
}

export interface ToolOutput {
  ok: boolean;
  /** Already truncated, already redacted. This is what reaches the model. */
  text: string;
  exitCode?: number;
  durationMs?: number;
  truncated?: boolean;
  originalBytes?: number;
}

export type { ToolSpec };
