import type { ContentPart } from '@supops/shared';
import type { RiskAssessment, RiskTier, RunStatus, ToolCallState } from '@supops/shared';

export interface ProjectPolicy {
  autoExecuteMaxTier: RiskTier;
  autoExecuteCeiling?: RiskTier;
  prodAutoExecuteCap?: RiskTier;
  toolAutoExecuteCap?: Record<string, RiskTier>;
  triggerAutoExecuteCap?: Partial<Record<string, RiskTier>>;
  approverRoleByTier: Partial<Record<RiskTier, string>>;
  requireSecondPersonAtTier: RiskTier | null;
  ttlMsByTier: Partial<Record<RiskTier, number>>;
  onExpiry: 'continue_as_denied' | 'abort_run';
}

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  killSwitch: boolean;
  riskPolicy?: ProjectPolicy;
  /** Instructions added to every run's system prompt. */
  systemPromptExtra?: string | null;
}

export interface AuditEntry {
  id: string;
  at: number;
  actorName: string | null;
  entity: string;
  entityId: string | null;
  action: string;
  before: unknown;
  after: unknown;
}

export interface Target {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  kind: string;
  env: 'dev' | 'staging' | 'prod';
  description: string | null;
  sensitivity: number;
  healthState: 'unknown' | 'ok' | 'degraded' | 'unreachable';
  lastCheckedAt: number | null;
  hasCredential: boolean;
  becomeUsers?: string[];
  config: Record<string, unknown>;
}

/**
 * A machine reached via a jump (config.via) is not a top-level target -- it lives
 * under its jump's umbrella. It stays a real, reachable target, but the UI must not
 * count or list it as a separate target. The Targets page is the one exception: it
 * shows these grouped beneath their jump.
 */
export const isBehindJump = (t: Target): boolean =>
  !!(t.config as { via?: { alias?: string } }).via?.alias;

/** Only the top-level targets -- jumps and direct hosts, not the machines behind a jump. */
export const topLevelTargets = (list: Target[] | undefined): Target[] =>
  (list ?? []).filter((t) => !isBehindJump(t));

export interface AgentBudget {
  maxIterations: number;
  maxToolCalls: number;
  maxWallClockMs: number;
  maxOutputBytesPerCall: number;
  maxSessionToolCalls?: number;
  maxOutputTokens?: number;
}

export interface Agent {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  role: string;
  description?: string | null;
  systemPrompt: string;
  model?: string | null;
  toolKeys: string[] | null;
  enabled: boolean;
  budget?: AgentBudget;
  riskPolicyOverride?: { autoExecuteMaxTier?: RiskTier; prodAutoExecuteCap?: RiskTier; requireSecondPersonAtTier?: RiskTier | null } | null;
  /** Ships with SupOps: cannot be deleted (triage/console can be reset). */
  builtIn?: boolean;
  /** Health-check agents follow their spec; only model and enabled are editable. */
  healthAgent?: boolean;
  effectivePolicy?: ProjectPolicy | null;
}

export interface RunAction {
  tier: RiskTier | null;
  state: ToolCallState;
  toolKey: string;
  command: string | null;
}

export interface Run {
  id: string;
  projectId: string;
  agentId: string;
  title: string;
  status: RunStatus;
  statusReason: string | null;
  model: string;
  iteration: number;
  promptTokens: number;
  completionTokens: number;
  startedAt: number;
  endedAt: number | null;
  /** Console sessions stay open between turns instead of ending. */
  interactive?: boolean;
  /** Kept by history clean-up regardless of age. */
  pinned?: boolean;
  trigger?: string;
  /** Who started the run; `startedByName` is resolved server-side. Null for scheduled runs. */
  startedBy?: string | null;
  startedByName?: string | null;
  /** Present on the list endpoint: the run's risk fingerprint, in execution order. */
  actions?: RunAction[];
  targets?: string[];
  /** Present on the list endpoint: who approved/rejected this run's gated steps. */
  approvals?: RunApprovals;
  /** The policy frozen at start; `advisory` marks a run with no system access. */
  policySnapshot?: { advisory?: boolean; unattended?: boolean; networkChecks?: boolean };
}

export interface ToolCall {
  id: string;
  runId: string;
  toolCallId: string;
  callIndex: number;
  toolKey: string;
  argsJson: Record<string, unknown>;
  renderedCommand: string | null;
  tier: RiskTier | null;
  riskJson: RiskAssessment | null;
  state: ToolCallState;
  resultJson: { ok: boolean; text: string; exitCode?: number } | null;
  isError: boolean;
  decisionComment: string | null;
  /** Who decided this action, and when. `decidedByName` is resolved server-side. */
  decidedBy?: string | null;
  decidedByName?: string | null;
  decidedAt?: number | null;
}

/** Who decided a run's gated steps, rolled up per person. */
export interface RunApprovals {
  approved: number;
  denied: number;
  by: Array<{ name: string; approved: number; denied: number }>;
}

/** One run's decided approvals (the history is grouped per run, not per step). */
export interface ApprovalHistoryEntry extends RunApprovals {
  runId: string;
  runTitle: string;
  kind: 'investigate' | 'console' | 'health' | 'alert';
  status: RunStatus;
  startedAt: number;
  startedByName: string | null;
  lastDecidedAt: number | null;
  lastComment: string | null;
}

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  globalRole: 'owner' | 'admin' | 'member';
  disabledAt: number | null;
  createdAt: number;
}

export interface RunStep {
  id: string;
  seq: number;
  messageJson: {
    role: 'system' | 'user' | 'assistant' | 'tool';
    /** A user turn with screenshots is multimodal parts; everything else is text. */
    content: string | ContentPart[] | null;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  };
}

export interface RunDetail {
  run: Run & { toolsSnapshot: unknown[]; targetsSnapshot: unknown[] };
  steps: RunStep[];
  toolCalls: ToolCall[];
  events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
  /** Project knowledge the run was given, and how each document was chosen. */
  knowledge?: Array<{ docId: string; via: 'pinned' | 'matched' | 'runbook'; title: string; kind: string }>;
}

export interface PendingApproval {
  toolCall: ToolCall;
  run: Run | null;
}

export interface DashboardData {
  runs: Record<string, number>;
  tiers: Partial<Record<RiskTier, number>>;
  states: Record<string, number>;
  /** The autonomy split: how much the agent did without asking anyone. */
  autonomy: { auto: number; approved: number; refused: number; blocked: number };
  activity: Array<{ day: string; runs: number; failed: number }>;
  targetHealth: Record<string, number>;
  approvals: {
    pending: number;
    oldestWaitingSince: number | null;
    decided: number;
    approveRate: number | null;
    avgDecisionMs: number | null;
  };
}

export interface Alert {
  id: string;
  projectId: string;
  source: string;
  channelId: string | null;
  channelName: string | null;
  fingerprint: string;
  title: string;
  severity: 'critical' | 'warning' | 'info' | 'unknown';
  status: 'new' | 'investigating' | 'ignored' | 'resolved';
  summary: string | null;
  labels: Record<string, string> | null;
  count: number;
  runId: string | null;
  incidentId?: string | null;
  /** The automatic read-only diagnosis of the alert's incident. */
  diagnosis?: {
    triageState: 'none' | 'evidence' | 'running' | 'done' | 'skipped' | 'failed';
    triageNote: string | null;
    rootCause: string | null;
    confidence: string | null;
    runId: string | null;
  } | null;
  slackPermalink: string | null;
  receivedAt: number | string;
  lastSeenAt: number | string;
}

export interface AlertList {
  alerts: Alert[];
  statusCounts: Record<string, number>;
  channels: Array<{ channelId: string; channelName: string | null }>;
}

export interface HealthTargetMetric {
  targetId: string;
  slug: string;
  healthState: 'ok' | 'degraded' | 'unreachable' | 'unknown';
  diskPct: number | null;
  memPct: number | null;
  load1: number | null;
  cores: number | null;
  failedUnits: number;
  namespaces: number | null;
  pods: number | null;
  badPods: number | null;
}

export interface HealthCheckSummary {
  checked: number;
  ok: number;
  degraded: number;
  unreachable: number;
  issues: number;
  notes?: number;
  targets?: HealthTargetMetric[];
}

export interface HealthCheck {
  id: string;
  type: 'quick' | 'deep';
  trigger: 'manual' | 'schedule';
  status: 'running' | 'done' | 'failed';
  runId: string | null;
  summaryJson: HealthCheckSummary | null;
  startedAt: number | string;
  finishedAt: number | string | null;
}

export interface HealthIssue {
  id: string;
  projectId: string;
  targetId: string;
  severity: 'notice' | 'warning' | 'critical';
  title: string;
  detail: string | null;
  state: 'open' | 'investigating' | 'resolved';
  runId: string | null;
  createdAt: number | string;
  lastSeenAt: number | string;
}

export interface HealthSchedule {
  enabled: boolean;
  intervalMs: number;
  scanType: 'quick' | 'deep';
  nextCheckAt: number | null;
  lastCheckAt: number | null;
}

export interface HealthOverview {
  latest: HealthCheck | null;
  issues: HealthIssue[];
  schedule: HealthSchedule;
}

// ---- observability ----------------------------------------------------------------

export type Severity = 'critical' | 'warning' | 'info' | 'unknown';

export interface Incident {
  id: string;
  projectId: string;
  title: string;
  severity: Severity;
  status: 'open' | 'resolved' | 'ignored';
  origin: 'alerts' | 'prediction' | 'threshold';
  /** The diagnosis' verdict: act_now | can_wait | none. */
  action: 'act_now' | 'can_wait' | 'none' | null;
  ignoredUntil: string | null;
  ignoredBy: string | null;
  ignoreReason: string | null;
  groupReason: string | null;
  targetIds: string[] | null;
  triageState: 'none' | 'evidence' | 'running' | 'done' | 'skipped' | 'failed';
  triageNote: string | null;
  runId: string | null;
  rootCause: string | null;
  confidence: 'high' | 'medium' | 'low' | 'inconclusive' | null;
  openedAt: string;
  lastSeenAt: string;
  resolvedAt: string | null;
  mergedInto: string | null;
  alertCount?: number;
}

export interface Observation {
  id: string;
  kind: 'anomaly' | 'forecast';
  severity: 'critical' | 'warning' | 'info';
  message: string;
  targetId: string | null;
  watchId: string;
  series: string;
  details: {
    etaMs?: number;
    confidence?: string;
    z?: number;
    baseline?: number;
    direction?: 'up' | 'down';
    over?: boolean;
    worsening?: boolean;
    slopePerHour?: number;
    limit?: { value: number; when: 'below' | 'above' };
    unit?: string;
    value?: number;
    name?: string;
    signal?: string;
  } | null;
  startedAt: string;
  incidentId: string | null;
  unit?: string;
  title?: string;
}

export interface ObsConnection {
  id: string;
  slug: string;
  kind: string;
  importsAlerts: boolean;
  watches: boolean;
  poll: { at: number; ok: boolean; firing: number; error?: string } | null;
  watchCount: number;
  watchErrors: number;
  lastSampledAt: number | null;
}

export interface ObservabilitySettings {
  alertPollMs: number;
  watchIntervalMs: number;
  autoTriage: boolean;
  triageMinSeverity: 'critical' | 'warning' | 'info';
  triageMaxPerHour: number;
  predictWarningHours: number;
  predictCriticalHours: number;
}

export interface ObservabilityOverview {
  incidents: Incident[];
  observations: Observation[];
  connections: ObsConnection[];
  settings: ObservabilitySettings;
  /** Series being watched right now. */
  watched: number;
}

export interface Evidence {
  id: string;
  ref: string;
  check: string;
  title: string;
  connection: string | null;
  query: string | null;
  status: 'interesting' | 'normal' | 'unavailable' | 'error';
  summary: string;
}

export interface IncidentDetail {
  incident: Incident & { targets: string[] };
  alerts: Array<Alert & { startsAt: string | null; resolvedAt: string | null; connectionId: string | null }>;
  evidence: Evidence[];
  observations: Observation[];
  run: { id: string; status: RunStatus; title: string; startedAt: string; endedAt: string | null } | null;
  fixRun: { id: string; status: RunStatus; startedAt: string } | null;
  /** From the service map: what this incident's systems rely on, and what relies on them. */
  map: {
    dependsOn: Array<{ id: string; name: string; type: string; depth: number; certainty: string; problems: string[] }>;
    affected: Array<{ id: string; name: string; type: string; depth: number; certainty: string; problems: string[] }>;
  };
  timeline: Array<{ at: number; kind: string; text: string }>;
  mergeCandidates: Array<{ id: string; title: string }>;
}

export interface WatchItem {
  key: string;
  name: string;
  labels: Record<string, string>;
  value: number;
  /** 0-100: how close to trouble. */
  score: number;
  reasons: string[];
  etaMs: number | null;
  /** The registered machine it is about, when matched. */
  target: string | null;
  flags: string[];
}

export interface Watch {
  id: string;
  connectionId: string;
  connection: string | null;
  key: string;
  title: string;
  query: string;
  unit: string;
  builtin: boolean;
  badDirection: 'up' | 'down' | 'both';
  limit: { value: number; when: 'below' | 'above' } | null;
  group: 'resources' | 'traffic' | 'kubernetes' | 'stack' | 'custom';
  enabled: boolean;
  lastRunAt: string | null;
  lastError: string | null;
  seriesCount: number;
  series: WatchItem[];
}

export interface SeriesChartData {
  points: Array<[number, number]>;
  unit: string;
  limit: { value: number; when: 'below' | 'above' } | null;
  band: { low: number; high: number } | null;
  forecast: { slopePerHour: number; etaMs: number } | null;
}

export interface AtRiskItem {
  watchId: string;
  key: string;
  name: string;
  value: number;
  score: number;
  reasons: string[];
  title: string;
  unit: string;
  group: Watch['group'];
}
