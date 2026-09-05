/** See the run state machine in the plan. Terminal states end a run permanently. */
export const RUN_STATUSES = [
  'queued',
  'running',
  'awaiting_approval',
  'awaiting_input',
  'suspended',
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'halted',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = [
  'succeeded',
  'failed',
  'cancelled',
  'expired',
  'halted',
];

export const isTerminalRun = (s: RunStatus): boolean =>
  TERMINAL_RUN_STATUSES.includes(s);

/**
 * `building`  - assistant step being streamed, not yet part of the conversation
 * `pending`   - tool-result step whose sibling calls are not all terminal yet
 * `committed` - part of the conversation; immutable
 * `archived`  - superseded by a summary (context-budget guard); never deleted
 */
export const STEP_STATES = ['building', 'pending', 'committed', 'archived'] as const;
export type StepState = (typeof STEP_STATES)[number];

export const TOOL_CALL_STATES = [
  'proposed',
  'classified',
  'blocked',
  'auto_approved',
  'awaiting_approval',
  'approved',
  'denied',
  'expired',
  'executing',
  'succeeded',
  'failed',
  'timed_out',
  /** Worker died after dispatch. NEVER auto-retried for tier >= low. */
  'unknown_outcome',
] as const;
export type ToolCallState = (typeof TOOL_CALL_STATES)[number];

export const TERMINAL_TOOL_CALL_STATES: readonly ToolCallState[] = [
  'blocked',
  'denied',
  'expired',
  'succeeded',
  'failed',
  'timed_out',
  'unknown_outcome',
];

export const isTerminalToolCall = (s: ToolCallState): boolean =>
  TERMINAL_TOOL_CALL_STATES.includes(s);

export const TARGET_KINDS = ['ssh', 'docker', 'k8s', 'http'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

export const ENVS = ['dev', 'staging', 'prod'] as const;
export type Env = (typeof ENVS)[number];

export const RUN_TRIGGERS = ['manual', 'chat', 'webhook', 'alert', 'schedule', 'health', 'api'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

export const ROLES = ['owner', 'admin', 'operator', 'approver', 'viewer'] as const;
export type Role = (typeof ROLES)[number];

/** Where an alert came from. Slack is built now; the rest leave room for later. */
export const ALERT_SOURCES = ['slack', 'prometheus', 'grafana'] as const;
export type AlertSource = (typeof ALERT_SOURCES)[number];

/**
 * `new`           - just arrived, waiting on a human decision
 * `investigating` - a run was started from it (linked via runId)
 * `ignored`       - dismissed by a human; reversible
 * `resolved`      - the source (Alertmanager) sent a resolved notification
 */
export const ALERT_STATUSES = ['new', 'investigating', 'ignored', 'resolved'] as const;
export type AlertStatus = (typeof ALERT_STATUSES)[number];

/** `unknown` when the source message carried no severity we could read. */
export const ALERT_SEVERITIES = ['critical', 'warning', 'info', 'unknown'] as const;
export type AlertSeverity = (typeof ALERT_SEVERITIES)[number];

/** An open alert can still be acted on or updated by a repeat/resolved notification. */
export const OPEN_ALERT_STATUSES: readonly AlertStatus[] = ['new', 'investigating'];

/**
 * A health check is either a `quick` deterministic probe sweep (no LLM, fixed
 * read-only commands) or a `deep` AI agent run that reasons about each target.
 */
export const HEALTH_SCAN_TYPES = ['quick', 'deep'] as const;
export type HealthScanType = (typeof HEALTH_SCAN_TYPES)[number];

/** A scan cycle's lifecycle. `deep` scans stay `running` until their run finishes. */
export const HEALTH_CHECK_STATUSES = ['running', 'done', 'failed'] as const;
export type HealthCheckStatus = (typeof HEALTH_CHECK_STATUSES)[number];

/**
 * `open`          - a problem a scan surfaced, waiting on a human
 * `investigating` - a human started a deep investigation run from it (linked via runId)
 * `resolved`      - dismissed by a human, or gone on a later scan
 */
export const HEALTH_ISSUE_STATES = ['open', 'investigating', 'resolved'] as const;
export type HealthIssueState = (typeof HEALTH_ISSUE_STATES)[number];

export const OPEN_HEALTH_ISSUE_STATES: readonly HealthIssueState[] = ['open', 'investigating'];

/**
 * How a target elevates privilege before running a command. Applied by the
 * executor to EVERY command, so it is enforced in code rather than left to the
 * model to remember. `sudo-su` is `sudo su - <user> -c ...`, the common jump-host
 * pattern. A per-target `template` (with a `{{CMD}}` placeholder) overrides this.
 */
export const BECOME_METHODS = ['none', 'sudo', 'su', 'sudo-su'] as const;
export type BecomeMethod = (typeof BECOME_METHODS)[number];
