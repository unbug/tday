import { useEffect, useState } from 'react';
import type { AgentInfo, UsageSummary, UsageFilter } from '@tday/shared';
import { StatCard, DailyBarChart, fmtNum } from './shared';
import type { UsageDateMode } from './types';

export interface UsageSectionProps {
  agents: AgentInfo[];
}

export function UsageSection({ agents }: UsageSectionProps) {
  const [usageData, setUsageData] = useState<UsageSummary | null>(null);
  const [usageDateMode, setUsageDateMode] = useState<UsageDateMode>('30d');
  const [usageCustomFrom, setUsageCustomFrom] = useState('');
  const [usageCustomTo, setUsageCustomTo] = useState('');
  const [usageAgentId, setUsageAgentId] = useState('');

  const loadUsage = async (
    mode: UsageDateMode,
    customFrom: string,
    customTo: string,
    agentId: string,
  ) => {
    const now = Date.now();
    const todayStart = (() => {
      const d = new Date();
      d.setHours(0, 0, 0, 0);
      return d.getTime();
    })();
    const filter: UsageFilter = {};
    if (agentId) filter.agentId = agentId;
    switch (mode) {
      case 'today':
        filter.fromTs = todayStart;
        break;
      case '7d':
        filter.fromTs = now - 7 * 86400000;
        break;
      case '30d':
        filter.fromTs = now - 30 * 86400000;
        break;
      case '90d':
        filter.fromTs = now - 90 * 86400000;
        break;
      case 'custom':
        if (customFrom) filter.fromTs = new Date(customFrom).getTime();
        if (customTo) {
          const d = new Date(customTo);
          d.setHours(23, 59, 59, 999);
          filter.toTs = d.getTime();
        }
        break;
    }
    try {
      const summary = await window.tday.queryUsage(filter);
      setUsageData(summary);
    } catch {
      // ignore
    }
  };

  useEffect(() => {
    void loadUsage(usageDateMode, usageCustomFrom, usageCustomTo, usageAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [usageDateMode, usageCustomFrom, usageCustomTo, usageAgentId]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden text-xs">
      {/* Left sidebar: filters */}
      <div className="scroll-themed flex w-48 shrink-0 flex-col gap-3 overflow-y-auto border-r border-zinc-800/60 p-3">
        {/* Date range */}
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">Period</div>
          <div className="flex flex-col gap-1">
            {(['today', '7d', '30d', '90d', 'custom'] as const).map((mode) => (
              <button
                key={mode}
                onClick={() => setUsageDateMode(mode)}
                className={`rounded-md px-2.5 py-1 text-left text-[11px] transition-colors ${
                  usageDateMode === mode
                    ? 'bg-fuchsia-500/20 text-fuchsia-200'
                    : 'text-zinc-400 hover:bg-zinc-900'
                }`}
              >
                {mode === 'today' ? 'Today' : mode === 'custom' ? 'Custom…' : mode}
              </button>
            ))}
          </div>
          {usageDateMode === 'custom' ? (
            <div className="mt-2 flex flex-col gap-1.5">
              <input
                type="date"
                value={usageCustomFrom}
                onChange={(e) => setUsageCustomFrom(e.target.value)}
                className="input-date h-6 py-0 text-[11px]"
              />
              <input
                type="date"
                value={usageCustomTo}
                onChange={(e) => setUsageCustomTo(e.target.value)}
                className="input-date h-6 py-0 text-[11px]"
              />
            </div>
          ) : null}
        </div>

        {/* Agent filter */}
        <div>
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-zinc-500">Agent</div>
          <div className="flex flex-col gap-1">
            {[
              { id: '', label: 'All agents' },
              ...agents.map((a) => ({ id: a.id, label: a.displayName })),
            ].map(({ id, label }) => (
              <button
                key={id}
                onClick={() => setUsageAgentId(id)}
                className={`truncate rounded-md px-2.5 py-1 text-left text-[11px] transition-colors ${
                  usageAgentId === id
                    ? 'bg-fuchsia-500/20 text-fuchsia-200'
                    : 'text-zinc-400 hover:bg-zinc-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <button
          onClick={() =>
            void loadUsage(usageDateMode, usageCustomFrom, usageCustomTo, usageAgentId)
          }
          className="rounded-md bg-zinc-900 px-2.5 py-1.5 text-[11px] text-zinc-400 hover:bg-zinc-800"
        >
          Refresh
        </button>
      </div>

      {/* Right area: stats */}
      <div className="scroll-themed flex-1 overflow-y-auto p-4">
        {usageData ? (
          <>
            {/* Summary cards */}
            <div className="mb-4 grid grid-cols-3 gap-2">
              <StatCard
                label="Total tokens"
                value={fmtNum(usageData.totalInputTokens + usageData.totalOutputTokens)}
                sub={`${fmtNum(usageData.totalInputTokens)} in · ${fmtNum(usageData.totalOutputTokens)} out`}
              />
              <StatCard
                label="Requests"
                value={String(usageData.totalRequests)}
                sub={
                  usageData.totalToolCalls > 0
                    ? `${fmtNum(usageData.totalToolCalls)} tool calls`
                    : undefined
                }
              />
              <StatCard
                label="Est. cost"
                value={
                  usageData.costUsd === null
                    ? '—'
                    : usageData.costUsd === 0
                    ? 'Free'
                    : `$${usageData.costUsd.toFixed(4)}`
                }
              />
              <StatCard
                label="Cache hit"
                value={`${(usageData.cacheHitRate * 100).toFixed(1)}%`}
                sub={`${fmtNum(usageData.totalCachedTokens)} cached`}
              />
              <StatCard
                label="Throughput"
                value={`${fmtNum(usageData.throughputTokensPerMin)} tok/min`}
                sub={`${usageData.throughputReqPerDay.toFixed(1)} req/d`}
              />
            </div>

            {/* Daily bar chart */}
            {usageData.daily.length > 0 ? (
              <div className="mb-4">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  Daily tokens (
                  {usageDateMode === 'today'
                    ? 'today'
                    : usageDateMode === 'custom'
                    ? 'custom range'
                    : usageDateMode}
                  )
                </div>
                <DailyBarChart data={usageData.daily} />
              </div>
            ) : null}

            {/* Model breakdown */}
            {Object.keys(usageData.byModel).length > 0 ? (
              <div className="mb-4">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  By model
                </div>
                <div className="overflow-hidden rounded-md border border-zinc-800/60">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-zinc-800/60 text-zinc-500">
                        <th className="px-3 py-1.5 text-left font-normal">Model</th>
                        <th className="px-3 py-1.5 text-right font-normal">Reqs</th>
                        <th className="px-3 py-1.5 text-right font-normal">Input</th>
                        <th className="px-3 py-1.5 text-right font-normal">Output</th>
                        <th className="px-3 py-1.5 text-right font-normal">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(usageData.byModel)
                        .sort(
                          ([, a], [, b]) =>
                            b.inputTokens +
                            b.outputTokens -
                            (a.inputTokens + a.outputTokens) ||
                            b.requests - a.requests,
                        )
                        .map(([model, m]) => (
                          <tr
                            key={model}
                            className="border-b border-zinc-800/40 last:border-0 hover:bg-zinc-900/40"
                          >
                            <td className="max-w-[180px] truncate px-3 py-1.5 font-mono text-zinc-300">
                              {model}
                            </td>
                            <td className="px-3 py-1.5 text-right text-zinc-400">{m.requests}</td>
                            <td className="px-3 py-1.5 text-right text-zinc-400">
                              {fmtNum(m.inputTokens)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-zinc-400">
                              {fmtNum(m.outputTokens)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-zinc-400">
                              {m.costUsd === null
                                ? '—'
                                : m.costUsd === 0
                                ? 'Free'
                                : `$${m.costUsd.toFixed(4)}`}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}

            {/* Agent breakdown */}
            {Object.keys(usageData.byAgent).length > 0 ? (
              <div>
                <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-500">
                  By agent
                </div>
                <div className="overflow-hidden rounded-md border border-zinc-800/60">
                  <table className="w-full text-[11px]">
                    <thead>
                      <tr className="border-b border-zinc-800/60 text-zinc-500">
                        <th className="px-3 py-1.5 text-left font-normal">Agent</th>
                        <th className="px-3 py-1.5 text-right font-normal">Reqs</th>
                        <th className="px-3 py-1.5 text-right font-normal">Tokens</th>
                        <th className="px-3 py-1.5 text-right font-normal">Cost</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Object.entries(usageData.byAgent)
                        .sort(
                          ([, a], [, b]) =>
                            b.inputTokens +
                            b.outputTokens -
                            (a.inputTokens + a.outputTokens) ||
                            b.requests - a.requests,
                        )
                        .map(([agId, ag]) => (
                          <tr
                            key={agId}
                            className="border-b border-zinc-800/40 last:border-0 hover:bg-zinc-900/40"
                          >
                            <td className="px-3 py-1.5 text-zinc-300">{agId}</td>
                            <td className="px-3 py-1.5 text-right text-zinc-400">{ag.requests}</td>
                            <td className="px-3 py-1.5 text-right text-zinc-400">
                              {fmtNum(ag.inputTokens + ag.outputTokens)}
                            </td>
                            <td className="px-3 py-1.5 text-right text-zinc-400">
                              {ag.costUsd === null
                                ? '—'
                                : ag.costUsd === 0
                                ? 'Free'
                                : `$${ag.costUsd.toFixed(4)}`}
                            </td>
                          </tr>
                        ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ) : null}
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-zinc-500">
            No usage data. Start a conversation to record tokens.
          </div>
        )}
      </div>
    </div>
  );
}
