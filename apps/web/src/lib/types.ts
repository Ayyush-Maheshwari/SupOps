import type { RiskAssessment, RiskTier, RunStatus, ToolCallState } from '@supops/shared';

export interface Project {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  killSwitch: boolean;
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

export interface Agent {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  role: string;
  systemPrompt: string;
  toolKeys: string[] | null;
  enabled: boolean;
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
  trigger?: string;
  /** Present on the list endpoint: the run's risk fingerprint, in execution order. */
  actions?: RunAction[];
  targets?: string[];
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

export interface ApprovalHistoryEntry {
  id: string;
  runId: string;
  runTitle: string;
  toolKey: string;
  renderedCommand: string | null;
  tier: RiskTier | null;
  verdict: 'approved' | 'denied';
  decidedByName: string | null;
  decidedAt: number | null;
  decisionComment: string | null;
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
    content: string | null;
    tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    tool_call_id?: string;
  };
}

export interface RunDetail {
  run: Run & { toolsSnapshot: unknown[]; targetsSnapshot: unknown[] };
  steps: RunStep[];
  toolCalls: ToolCall[];
  events: Array<{ seq: number; type: string; payload: Record<string, unknown> }>;
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
  severity: 'warning' | 'critical';
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
