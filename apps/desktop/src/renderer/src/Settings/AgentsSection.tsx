import { useState } from 'react';
import type { AgentId, AgentInfo, AgentsConfig, CronJob, ProvidersConfig } from '@tday/shared';
import { presetForKind } from '@tday/shared';
import { ProviderLogo } from '../ProviderLogo';
import { describeCronExpr, CRON_AGENT_COLOR } from './cron-helpers';

const SHARED_KEY = 'tday:sharedAgentConfig';

function buildAgentsCfg(agentList: AgentInfo[]): AgentsConfig {
  const defaultAgentId = (agentList.find((a) => a.isDefault)?.id ?? 'pi') as AgentId;
  return {
    defaultAgentId,
    agents: Object.fromEntries(
      agentList.map((a) => [
        a.id,
        { providerId: a.providerId || undefined, model: a.model || undefined },
      ]),
    ) as AgentsConfig['agents'],
  };
}

export interface AgentsSectionProps {
  agents: AgentInfo[];
  onAgentsChange: (agents: AgentInfo[]) => void;
  cfg: ProvidersConfig | null;
  shared: boolean;
  onSharedChange: (val: boolean) => void;
  cronJobs: CronJob[];
  home: string;
  onNavigateToCron: (agentId: AgentId, job?: CronJob) => void;
}

export function AgentsSection({
  agents,
  onAgentsChange,
  cfg,
  shared,
  onSharedChange,
  cronJobs,
  home,
  onNavigateToCron,
}: AgentsSectionProps) {
  const [activeAgentId, setActiveAgentId] = useState<string>('');
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installPct, setInstallPct] = useState(0);

  const persistAgents = (next: AgentInfo[]) => {
    void window.tday.saveAgents(buildAgentsCfg(next));
  };

  const bindProvider = (agentId: string, providerId: string) => {
    const next = shared
      ? agents.map((a) => ({ ...a, providerId: providerId || undefined }))
      : agents.map((a) => (a.id === agentId ? { ...a, providerId: providerId || undefined } : a));
    onAgentsChange(next);
    persistAgents(next);
  };

  const setAgentModel = (agentId: string, model: string) => {
    const next = shared
      ? agents.map((a) => ({ ...a, model }))
      : agents.map((a) => (a.id === agentId ? { ...a, model } : a));
    onAgentsChange(next);
  };

  const flushAgentModel = () => persistAgents(agents);

  const setAsDefault = (agentId: AgentId) => {
    const next = agents.map((a) => ({ ...a, isDefault: a.id === agentId }));
    onAgentsChange(next);
    persistAgents(next);
  };

  const toggleShared = (next: boolean) => {
    onSharedChange(next);
    void window.tday.setSetting(SHARED_KEY, next);
    if (next) {
      const first = agents[0];
      if (first) {
        const synced = agents.map((a) => ({
          ...a,
          providerId: first.providerId,
          model: first.model,
        }));
        onAgentsChange(synced);
        persistAgents(synced);
      }
    }
  };

  const installAgent = async (agentId: string, action: 'install' | 'update' | 'uninstall') => {
    setInstallingId(agentId);
    setInstallPct(0);
    const off = window.tday.onInstallProgress((e) => {
      if (e.agentId !== agentId) return;
      if (typeof e.percent === 'number') setInstallPct(e.percent);
      if (e.kind === 'done') setInstallPct(100);
    });
    try {
      const id = agentId as AgentId;
      if (action === 'install') await window.tday.installAgent(id);
      else if (action === 'update') await window.tday.updateAgent(id);
      else await window.tday.uninstallAgent(id);
      // Refresh agents list after install/uninstall
      const refreshed = await window.tday.listAgents() as AgentInfo[];
      onAgentsChange(refreshed);
    } finally {
      off();
      setTimeout(() => setInstallingId(null), 600);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Left: agent list */}
      <div className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-zinc-800/60">
        <div className="scroll-themed flex-1 overflow-y-auto p-2">
          {agents.map((a) => {
            const effectiveId = activeAgentId || agents[0]?.id;
            return (
              <button
                key={a.id}
                onClick={() => setActiveAgentId(a.id)}
                className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors ${
                  a.id === effectiveId
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-900'
                }`}
              >
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded bg-zinc-800/80 text-[11px] font-semibold text-zinc-300">
                  {a.displayName.charAt(0)}
                </div>
                <span className="flex-1 truncate">{a.displayName}</span>
                {a.isDefault ? (
                  <span className="rounded bg-fuchsia-500/20 px-1 text-[9px] text-fuchsia-300">
                    ●
                  </span>
                ) : null}
                <span
                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                    a.detect.available ? 'bg-emerald-400' : 'bg-zinc-600'
                  }`}
                />
              </button>
            );
          })}
        </div>
        {/* Shared toggle pinned at bottom */}
        <div className="shrink-0 border-t border-zinc-800/60 p-3">
          <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
            <input
              type="checkbox"
              checked={shared}
              onChange={(e) => toggleShared(e.target.checked)}
            />
            <span className="flex-1">Shared provider</span>
          </label>
          <div className="mt-0.5 text-[10px] text-zinc-600">applies to all agents</div>
        </div>
      </div>

      {/* Right: agent details */}
      <div className="scroll-themed flex-1 overflow-y-auto p-5 text-xs">
        {(() => {
          const a = agents.find((x) => x.id === (activeAgentId || agents[0]?.id));
          if (!a) return <p className="text-zinc-500">No agents detected.</p>;
          const bound = cfg?.profiles.find((p) => p.id === a.providerId);
          const boundPreset = bound ? presetForKind(bound.kind) : null;
          const modelOptions = boundPreset?.models ?? [];
          const isInstalling = installingId === a.id;
          const agentCrons = cronJobs.filter((j) => j.agentId === a.id);
          return (
            <div className="space-y-4">
              {/* Header */}
              <div className="flex items-center gap-3 border-b border-zinc-800/40 pb-3">
                <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-zinc-800/60 text-sm font-semibold text-zinc-200">
                  {a.displayName.charAt(0)}
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-sm font-medium text-zinc-100">
                    {a.displayName}
                    {a.detect.available ? (
                      <span className="rounded bg-emerald-500/20 px-1.5 text-[10px] text-emerald-300">
                        installed{a.detect.version ? ` · ${a.detect.version}` : ''}
                      </span>
                    ) : (
                      <span className="rounded bg-zinc-700/60 px-1.5 text-[10px] text-zinc-300">
                        {a.npmPackage ? 'not installed' : 'not on PATH'}
                      </span>
                    )}
                    {a.isDefault ? (
                      <span className="rounded bg-fuchsia-500/20 px-1.5 text-[10px] text-fuchsia-300">
                        default
                      </span>
                    ) : null}
                  </div>
                  {a.description ? (
                    <div className="mt-0.5 text-[11px] text-zinc-500">{a.description}</div>
                  ) : null}
                </div>
                <div className="flex shrink-0 items-center gap-1">
                  {!a.detect.available && a.npmPackage ? (
                    <button
                      onClick={() => void installAgent(a.id, 'install')}
                      disabled={isInstalling}
                      className="rounded-md bg-fuchsia-500/90 px-3 py-1 text-xs font-medium text-white hover:bg-fuchsia-500 disabled:opacity-60"
                    >
                      {isInstalling ? `${installPct}%` : 'Install'}
                    </button>
                  ) : null}
                  {a.detect.available && a.npmPackage ? (
                    <>
                      <button
                        onClick={() => void installAgent(a.id, 'update')}
                        disabled={isInstalling}
                        className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-60"
                        title="Update to latest"
                      >
                        {isInstalling ? `${installPct}%` : 'Update'}
                      </button>
                      <button
                        onClick={() => void installAgent(a.id, 'uninstall')}
                        disabled={isInstalling}
                        className="rounded-md border border-zinc-800 px-2 py-1 text-[11px] text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300 disabled:opacity-60"
                        title="Uninstall"
                      >
                        Uninstall
                      </button>
                    </>
                  ) : null}
                </div>
              </div>

              {isInstalling ? (
                <div className="h-1 overflow-hidden rounded-full bg-zinc-800">
                  <div
                    className="h-full bg-gradient-to-r from-fuchsia-500 to-sky-400 transition-all duration-300"
                    style={{ width: `${Math.max(2, installPct)}%` }}
                  />
                </div>
              ) : null}

              {/* Provider + Model */}
              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                    Bind provider
                  </span>
                  <div className="relative">
                    <select
                      className="input pl-8"
                      value={a.providerId ?? ''}
                      onChange={(e) => void bindProvider(a.id, e.target.value)}
                    >
                      <option value="">— none —</option>
                      {cfg?.profiles.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    {bound ? (
                      <span className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2">
                        <ProviderLogo kind={bound.kind} size={14} />
                      </span>
                    ) : null}
                  </div>
                </label>
                <label className="block">
                  <span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
                    Model override
                  </span>
                  <input
                    className="input"
                    list={`agent-models-${a.id}`}
                    placeholder={bound?.model ?? 'use provider default'}
                    value={a.model ?? ''}
                    onChange={(e) => setAgentModel(a.id, e.target.value)}
                    onBlur={() => flushAgentModel()}
                  />
                  {modelOptions.length > 0 ? (
                    <datalist id={`agent-models-${a.id}`}>
                      {modelOptions.map((m) => (
                        <option key={m} value={m} />
                      ))}
                    </datalist>
                  ) : null}
                </label>
              </div>

              {/* Default for new tabs */}
              <div className="flex items-center justify-end border-b border-zinc-800/40 pb-3">
                <label className="flex cursor-pointer items-center gap-2 text-[11px] text-zinc-400">
                  <input
                    type="radio"
                    name="default-agent"
                    checked={!!a.isDefault}
                    onChange={() => setAsDefault(a.id)}
                  />
                  Default for new tabs
                </label>
              </div>

              {/* Cron jobs for this agent */}
              <div>
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-[10px] uppercase tracking-wider text-zinc-500">
                    Scheduled jobs
                  </span>
                  <button
                    onClick={() => onNavigateToCron(a.id as AgentId)}
                    className="text-[10px] text-fuchsia-400 hover:underline"
                  >
                    + Add
                  </button>
                </div>
                {agentCrons.length === 0 ? (
                  <p className="text-[11px] text-zinc-600">No cron jobs for this agent.</p>
                ) : (
                  <div className="space-y-1">
                    {agentCrons.map((job) => (
                      <button
                        key={job.id}
                        onClick={() => onNavigateToCron(a.id as AgentId, job)}
                        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[11px] text-zinc-300 transition-colors hover:bg-zinc-800/60"
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{ background: CRON_AGENT_COLOR[job.agentId] ?? '#71717a' }}
                        />
                        <span
                          className={`shrink-0 rounded px-1 text-[9px] ${
                            job.enabled
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : 'bg-zinc-700/60 text-zinc-500'
                          }`}
                        >
                          {job.enabled ? 'on' : 'off'}
                        </span>
                        <span className="flex-1 truncate">{job.name}</span>
                        <span className="shrink-0 text-[10px] text-zinc-600">
                          {describeCronExpr(job.schedule)}
                        </span>
                        <span className="shrink-0 text-zinc-600">›</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
