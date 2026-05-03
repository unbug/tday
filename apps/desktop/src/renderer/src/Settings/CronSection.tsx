import type { AgentId, AgentInfo, CronJob, CronJobStats } from '@tday/shared';
import { MiniMarkdown, Field } from './shared';
import {
  CRON_AGENT_IDS,
  CRON_AGENT_LABEL,
  CRON_AGENT_COLOR,
  describeCronExpr,
  fmtCronTime,
} from './cron-helpers';
import { ScheduleWidget } from './ScheduleWidget';

export interface CronSectionProps {
  jobs: CronJob[];
  stats: Record<string, CronJobStats>;
  agents: AgentInfo[];
  saving: boolean;
  editId: string | null;
  draft: Partial<CronJob>;
  home: string;
  onOpenNew: () => void;
  onOpenEdit: (job: CronJob) => void;
  onCloseEdit: () => void;
  onDraftChange: (patch: Partial<CronJob>) => void;
  onSave: () => Promise<void>;
  onClone: (jobId: string) => Promise<void>;
  onDelete: (jobId: string) => Promise<void>;
  onToggleEnabled: (jobId: string, enabled: boolean) => Promise<void>;
  onTrigger: (jobId: string) => Promise<void>;
  onRefreshStats: () => Promise<void>;
}

export function CronSection({
  jobs,
  stats,
  agents,
  saving,
  editId,
  draft,
  home,
  onOpenNew,
  onOpenEdit,
  onCloseEdit,
  onDraftChange,
  onSave,
  onClone,
  onDelete,
  onToggleEnabled,
  onTrigger,
  onRefreshStats,
}: CronSectionProps) {
  const browseDir = async () => {
    const picked = await window.tday.pickDir(draft.cwd || home);
    if (picked) onDraftChange({ cwd: picked });
  };

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden text-xs">
      {/* Left: job list + add button */}
      <div className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-zinc-800/60">
        <div className="scroll-themed flex-1 overflow-y-auto p-2">
          {jobs.length === 0 ? (
            <p className="px-2 py-4 text-center text-[11px] text-zinc-600">No cron jobs yet</p>
          ) : null}
          {jobs.map((job) => {
            const s = stats[job.id];
            return (
              <button
                key={job.id}
                onClick={() => onOpenEdit(job)}
                className={`w-full rounded-md px-2 py-2 text-left transition-colors ${
                  editId === job.id
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-900'
                }`}
              >
                <div className="flex items-center gap-2">
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: CRON_AGENT_COLOR[job.agentId] ?? '#71717a' }}
                  />
                  <span className="flex-1 truncate text-[11px] font-medium">{job.name}</span>
                  <span
                    className={`shrink-0 rounded px-1 text-[9px] uppercase tracking-wider ${
                      job.enabled
                        ? 'bg-emerald-500/20 text-emerald-300'
                        : 'bg-zinc-700/60 text-zinc-500'
                    }`}
                  >
                    {job.enabled ? 'on' : 'off'}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[10px] text-zinc-600">
                  {describeCronExpr(job.schedule)}
                </div>
                {s ? (
                  <div className="mt-0.5 truncate text-[10px] text-zinc-600">
                    next: {fmtCronTime(s.nextRunAt)}
                  </div>
                ) : null}
              </button>
            );
          })}
        </div>
        <div className="shrink-0 border-t border-zinc-800/60 p-2">
          <button
            onClick={onOpenNew}
            className="w-full rounded-md px-2 py-2 text-left text-[11px] text-fuchsia-300 hover:bg-zinc-900"
          >
            + Add cron job
          </button>
        </div>
      </div>

      {/* Right: editor or stats dashboard */}
      <div className="scroll-themed flex-1 overflow-y-auto p-4">
        {editId ? (
          /* ── Editor ── */
          <div className="space-y-3">
            <div className="pb-1 text-sm font-medium text-zinc-100">
              {editId === '__new__' ? 'New Cron Job' : 'Edit Cron Job'}
            </div>

            <Field label="Name">
              <input
                className="input"
                placeholder="e.g. Daily code review"
                value={draft.name ?? ''}
                onChange={(e) => onDraftChange({ name: e.target.value })}
              />
            </Field>

            <Field label="Agent">
              <select
                className="input"
                value={draft.agentId ?? 'codex'}
                onChange={(e) => onDraftChange({ agentId: e.target.value as AgentId })}
              >
                {CRON_AGENT_IDS.map((id) => {
                  const info = agents.find((a) => a.id === id);
                  const available = info?.detect.available ?? false;
                  return (
                    <option key={id} value={id} disabled={!available}>
                      {CRON_AGENT_LABEL[id] ?? id}
                      {!available ? ' (not installed)' : ''}
                    </option>
                  );
                })}
              </select>
            </Field>

            <Field label="Working directory">
              <div className="flex gap-1.5">
                <input
                  className="input flex-1"
                  placeholder={home}
                  value={draft.cwd ?? ''}
                  onChange={(e) => onDraftChange({ cwd: e.target.value })}
                />
                <button
                  onClick={() => void browseDir()}
                  className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800"
                >
                  Browse
                </button>
              </div>
            </Field>

            <Field label="Prompt / Goal">
              <textarea
                className="input min-h-[80px] resize-y"
                placeholder="Describe what the agent should do…"
                value={draft.prompt ?? ''}
                onChange={(e) => onDraftChange({ prompt: e.target.value })}
              />
            </Field>

            <Field label="Schedule">
              <ScheduleWidget
                value={draft.schedule ?? '0 9 * * *'}
                onChange={(expr) => onDraftChange({ schedule: expr })}
              />
            </Field>

            <label className="flex cursor-pointer items-center gap-2 text-zinc-300">
              <input
                type="checkbox"
                checked={draft.enabled ?? true}
                onChange={(e) => onDraftChange({ enabled: e.target.checked })}
              />
              Enabled
            </label>

            <div className="flex items-center gap-2 pt-2">
              <button
                onClick={() => void onSave()}
                disabled={saving || !draft.name?.trim() || !draft.schedule?.trim()}
                className="rounded-md bg-fuchsia-500/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-fuchsia-500 disabled:opacity-50"
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
              <button
                onClick={onCloseEdit}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                Cancel
              </button>
              {editId !== '__new__' ? (
                <>
                  <button
                    onClick={() => void onClone(editId)}
                    className="rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-500 hover:bg-zinc-800 hover:text-zinc-200"
                  >
                    Clone
                  </button>
                  <button
                    onClick={() => void onDelete(editId)}
                    className="ml-auto rounded-md border border-zinc-800 px-3 py-1.5 text-xs text-zinc-500 hover:bg-rose-500/10 hover:text-rose-300"
                  >
                    Delete
                  </button>
                </>
              ) : null}
            </div>
          </div>
        ) : (
          /* ── Stats dashboard ── */
          <div>
            <div className="mb-3 flex items-center justify-between">
              <div className="text-sm font-medium text-zinc-100">Cron Jobs Dashboard</div>
              <button
                onClick={() => void onRefreshStats()}
                className="rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-400 hover:bg-zinc-800"
              >
                Refresh
              </button>
            </div>

            {jobs.length === 0 ? (
              <div className="flex flex-col items-center gap-3 py-12 text-center">
                <div className="text-3xl text-zinc-700">⏰</div>
                <p className="text-sm text-zinc-500">No cron jobs configured.</p>
                <button
                  onClick={onOpenNew}
                  className="rounded-md bg-fuchsia-500/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-fuchsia-500"
                >
                  Add your first cron job
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {/* ── Summary bar ── */}
                {(() => {
                  const enabled = jobs.filter((j) => j.enabled).length;
                  const totalRuns = jobs.reduce(
                    (acc, j) => acc + (stats[j.id]?.runCount ?? 0),
                    0,
                  );
                  const errors = jobs.filter((j) => stats[j.id]?.lastStatus === 'error').length;
                  const nextTs =
                    jobs
                      .filter((j) => j.enabled)
                      .map((j) => stats[j.id]?.nextRunAt ?? null)
                      .filter((t): t is number => !!t && t > Date.now())
                      .sort((a, b) => a - b)[0] ?? null;
                  return (
                    <div className="grid grid-cols-4 gap-2 rounded-lg border border-zinc-800/60 bg-zinc-900/60 p-3">
                      <div className="text-center">
                        <div className="text-lg font-semibold text-zinc-100">{jobs.length}</div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-600">
                          Total
                        </div>
                      </div>
                      <div className="text-center">
                        <div
                          className={`text-lg font-semibold ${
                            enabled > 0 ? 'text-emerald-400' : 'text-zinc-500'
                          }`}
                        >
                          {enabled}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-600">
                          Active
                        </div>
                      </div>
                      <div className="text-center">
                        <div className="text-lg font-semibold text-zinc-100">{totalRuns}</div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-600">
                          Runs
                        </div>
                      </div>
                      <div className="text-center">
                        <div
                          className={`text-lg font-semibold ${
                            errors > 0 ? 'text-rose-400' : 'text-zinc-500'
                          }`}
                        >
                          {errors}
                        </div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-600">
                          Errors
                        </div>
                      </div>
                      {nextTs !== null ? (
                        <div className="col-span-4 border-t border-zinc-800/40 pt-2 text-center text-[10px] text-zinc-500">
                          Next run:{' '}
                          <span className="text-zinc-300">{fmtCronTime(nextTs)}</span>
                        </div>
                      ) : null}
                    </div>
                  );
                })()}

                {jobs.map((job) => {
                  const s = stats[job.id];
                  return (
                    <div
                      key={job.id}
                      className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3"
                    >
                      <div className="flex items-start gap-3">
                        <div
                          className="mt-0.5 h-2 w-2 shrink-0 rounded-full"
                          style={{ background: CRON_AGENT_COLOR[job.agentId] ?? '#71717a' }}
                        />
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-zinc-100">{job.name}</span>
                            <span
                              className="text-[10px] font-medium"
                              style={{
                                color: CRON_AGENT_COLOR[job.agentId] ?? '#71717a',
                              }}
                            >
                              {CRON_AGENT_LABEL[job.agentId] ?? job.agentId}
                            </span>
                            <span
                              className={`rounded px-1.5 text-[9px] uppercase tracking-wider ${
                                job.enabled
                                  ? 'bg-emerald-500/20 text-emerald-300'
                                  : 'bg-zinc-700/60 text-zinc-500'
                              }`}
                            >
                              {job.enabled ? 'enabled' : 'disabled'}
                            </span>
                            {s?.lastStatus === 'error' ? (
                              <span className="rounded bg-rose-500/20 px-1.5 text-[9px] text-rose-300">
                                error
                              </span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 text-[10px] text-zinc-500">
                            {describeCronExpr(job.schedule)}
                          </div>
                          <div className="mt-0.5 font-mono text-[10px] text-zinc-700">
                            {job.schedule}
                          </div>
                          <div
                            className="mt-0.5 truncate text-[10px] text-zinc-600"
                            title={job.cwd}
                          >
                            {job.cwd || home}
                          </div>
                          {job.prompt ? (
                            <MiniMarkdown
                              text={job.prompt}
                              className="mt-1 line-clamp-3 text-[10px] text-zinc-500"
                            />
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-zinc-400">
                            <input
                              type="checkbox"
                              checked={job.enabled}
                              onChange={(e) => void onToggleEnabled(job.id, e.target.checked)}
                            />
                            Active
                          </label>
                          <div className="flex gap-1">
                            <button
                              onClick={() => void onTrigger(job.id)}
                              title="Run now"
                              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                            >
                              ▶ Run
                            </button>
                            <button
                              onClick={() => void onClone(job.id)}
                              title="Clone"
                              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                            >
                              Clone
                            </button>
                            <button
                              onClick={() => onOpenEdit(job)}
                              className="rounded border border-zinc-700 px-2 py-0.5 text-[10px] text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                            >
                              Edit
                            </button>
                          </div>
                        </div>
                      </div>

                      {/* Stats row */}
                      {s ? (
                        <div className="mt-2 grid grid-cols-3 gap-2 border-t border-zinc-800/40 pt-2">
                          <div>
                            <div className="text-[9px] uppercase tracking-wider text-zinc-600">
                              Last run
                            </div>
                            <div className="text-[11px] text-zinc-400">
                              {fmtCronTime(s.lastRunAt)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[9px] uppercase tracking-wider text-zinc-600">
                              Next run
                            </div>
                            <div className="text-[11px] text-zinc-400">
                              {fmtCronTime(s.nextRunAt)}
                            </div>
                          </div>
                          <div>
                            <div className="text-[9px] uppercase tracking-wider text-zinc-600">
                              Run count
                            </div>
                            <div className="text-[11px] text-zinc-400">{s.runCount}</div>
                          </div>
                        </div>
                      ) : (
                        <div className="mt-2 border-t border-zinc-800/40 pt-2 text-[10px] text-zinc-700">
                          No runs yet
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
