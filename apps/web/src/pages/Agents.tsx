import { useQuery } from '@tanstack/react-query';
import { Sparkles } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { PageHeader } from '../components/Layout';
import { Empty, Panel, RiskBadge } from '../components/ui';
import type { Agent } from '../lib/types';

interface ToolInfo {
  key: string;
  description: string;
  baselineRisk: 'read_only' | 'low' | 'medium' | 'high' | 'forbidden';
  targetKinds: string[];
  mutating: boolean;
}

export function Agents() {
  const projectId = useApp((s) => s.projectId);

  const agents = useQuery({
    queryKey: ['agents', projectId],
    queryFn: () => api<Agent[]>(`/agents?projectId=${projectId}`),
    enabled: !!projectId,
  });
  const tools = useQuery({
    queryKey: ['available-tools'],
    queryFn: () => api<ToolInfo[]>('/agents/available-tools'),
  });

  return (
    <>
      <PageHeader title="Agents" subtitle="The agents you can put to work — what each one knows how to do, and what it's allowed to touch" />

      <div className="grid gap-4 p-6 lg:grid-cols-3">
        <div className="space-y-4 lg:col-span-2">
          {agents.data?.length ? (
            agents.data.map((a) => (
              <Panel key={a.id} title={a.name} action={<span className="text-xs text-muted">{a.role}</span>}>
                <div className="space-y-3 p-4">
                  <p className="whitespace-pre-wrap text-sm leading-relaxed text-muted">{a.systemPrompt}</p>
                  <div className="flex flex-wrap gap-1.5">
                    {(a.toolKeys ?? ['(all project tools)']).map((k) => (
                      <span key={k} className="rounded border border-hairline bg-tile-2 px-2 py-0.5 font-mono text-[11px] text-cyan">
                        {k}
                      </span>
                    ))}
                  </div>
                </div>
              </Panel>
            ))
          ) : (
            <Panel>
              <Empty icon={<Sparkles size={28} />} title="No agents" hint="Seed the project to create a default triage agent." />
            </Panel>
          )}
        </div>

        <Panel title="Available tools" accent="bg-violet">
          <ul className="divide-y divide-hairline">
            {tools.data?.map((t) => (
              <li key={t.key} className="px-4 py-3">
                <div className="mb-1 flex items-center gap-2">
                  <code className="font-mono text-xs text-ink">{t.key}</code>
                  <RiskBadge tier={t.baselineRisk} />
                </div>
                <p className="text-xs leading-relaxed text-muted">{t.description}</p>
              </li>
            ))}
          </ul>
          <p className="border-t border-hairline px-4 py-3 text-xs text-muted">
            Keep each agent's list short. Tool-call accuracy falls off noticeably past
            roughly a dozen tools, and much sooner on small local models.
          </p>
        </Panel>
      </div>
    </>
  );
}
