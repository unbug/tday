import { useCallback, useEffect, useRef, useState } from 'react';
import type { AgentHistoryEntry, AgentId, AgentInfo, CronJob, CronJobStats, ProvidersConfig } from '@tday/shared';
import type { Section } from './Settings/types';
import { SectionTab } from './Settings/shared';
import { ProvidersSection } from './Settings/ProvidersSection';
import { AgentsSection } from './Settings/AgentsSection';
import { UsageSection } from './Settings/UsageSection';
import { HistorySection } from './Settings/HistorySection';
import { CronSection } from './Settings/CronSection';
import { describeCronExpr } from './Settings/cron-helpers';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  initialSection?: Section;
  onSectionChange?: (section: Section) => void;
  agentHistory?: AgentHistoryEntry[];
  agentHistoryLoading?: boolean;
  onRestoreHistory?: (entry: AgentHistoryEntry) => void;
  onHideHistory?: (id: string) => void;
  home?: string;
}

const TABS: { id: Section; label: string }[] = [
  { id: 'usage',     label: 'Usage' },
  { id: 'providers', label: 'Providers' },
  { id: 'agents',    label: 'Agents' },
  { id: 'cron',      label: 'Cron' },
  { id: 'history',   label: 'History' },
];

export function Settings({
  open,
  onClose,
  onSaved,
  initialSection,
  agentHistory = [],
  agentHistoryLoading = false,
  onRestoreHistory,
  onHideHistory,
  home = '~',
  onSectionChange,
}: Props) {
  const [section, setSection] = useState<Section>(initialSection ?? 'usage');
  const changeSection = (s: Section) => { setSection(s); onSectionChange?.(s); };
  const [cfg, setCfg] = useState<ProvidersConfig | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [shared, setShared] = useState(false);
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [cronStats, setCronStats] = useState<Record<string, CronJobStats>>({});
  const [cronEditId, setCronEditId] = useState<string | null>(null);
  const [cronDraft, setCronDraft] = useState<Partial<CronJob>>({});
  const [cronSaving, setCronSaving] = useState(false);
  const [dialogSize, setDialogSize] = useState({ w: 880, h: 640 });
  const resizeStartRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    resizeStartRef.current = { x: e.clientX, y: e.clientY, w: dialogSize.w, h: dialogSize.h };
    const onMove = (ev: MouseEvent) => {
      if (!resizeStartRef.current) return;
      const { x, y, w, h } = resizeStartRef.current;
      const newW = Math.max(720, Math.min(w + ev.clientX - x, window.innerWidth * 0.97));
      const newH = Math.max(500, Math.min(h + ev.clientY - y, window.innerHeight * 0.95));
      setDialogSize({ w: Math.round(newW), h: Math.round(newH) });
    };
    const onUp = () => {
      resizeStartRef.current = null;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, [dialogSize]);

  useEffect(() => {
    if (!open) return;
    if (initialSection) setSection(initialSection);
    // Always refresh agents (may have changed since last open); only load providers
    // if not yet cached — ProvidersSection updates cfg via onCfgChange when user edits.
    void (async () => {
      const [c, a] = await Promise.all([
        cfg ? Promise.resolve(cfg) : (window.tday.listProviders() as Promise<ProvidersConfig>),
        window.tday.listAgents() as Promise<AgentInfo[]>,
      ]);
      setCfg(c);
      setAgents(a);
    })();
    void window.tday.getAllSettings().then((s) => {
      setShared(s['tday:sharedAgentConfig'] === true);
    });
    void Promise.all([window.tday.listCronJobs(), window.tday.getCronStats()]).then(
      ([jobs, stats]) => {
        setCronJobs(jobs);
        setCronStats(stats);
      },
    );
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const handleNavigateToCron = useCallback((agentId: string, job?: CronJob) => {
    setSection('cron');
    if (job) {
      setCronEditId(job.id);
      setCronDraft({ ...job });
    } else {
      setCronEditId('__new__');
      setCronDraft({ agentId: agentId as AgentId, schedule: '0 9 * * 1-5', enabled: true, cwd: home, prompt: '', name: '' });
    }
  }, [home]);

  const refreshCronStats = useCallback(async () => {
    const stats = await window.tday.getCronStats();
    setCronStats(stats);
  }, []);

  const handleCronOpenNew = useCallback(() => {
    setCronEditId('__new__');
    setCronDraft({ agentId: (agents[0]?.id ?? '') as AgentId, schedule: '0 9 * * 1-5', enabled: true, cwd: home, prompt: '', name: '' });
  }, [agents, home]);

  const handleCronOpenEdit = useCallback((job: CronJob) => {
    setCronEditId(job.id);
    setCronDraft({ ...job });
  }, []);

  const handleCronCloseEdit = useCallback(() => {
    setCronEditId(null);
    setCronDraft({});
  }, []);

  const handleCronSave = useCallback(async () => {
    setCronSaving(true);
    try {
      // Auto-generate a name from the schedule description when the user
      // didn't provide one, so they can save without filling in a name.
      const effectiveDraft: Partial<CronJob> =
        cronDraft.name?.trim()
          ? cronDraft
          : { ...cronDraft, name: describeCronExpr(cronDraft.schedule ?? '') || 'Cron job' };
      let updated: CronJob[];
      if (cronEditId === '__new__') {
        const newJob: CronJob = {
          id: `cron-${Date.now()}`,
          createdAt: Date.now(),
          ...(effectiveDraft as Omit<CronJob, 'id' | 'createdAt'>),
        };
        updated = [...cronJobs, newJob];
      } else {
        updated = cronJobs.map((j) => (j.id === cronEditId ? { ...j, ...effectiveDraft } as CronJob : j));
      }
      await window.tday.saveCronJobs(updated);
      const [jobs, stats] = await Promise.all([window.tday.listCronJobs(), window.tday.getCronStats()]);
      setCronJobs(jobs);
      setCronStats(stats);
      setCronEditId(null);
      setCronDraft({});
    } finally {
      setCronSaving(false);
    }
  }, [cronEditId, cronDraft, cronJobs]);

  const handleCronClone = useCallback(async (jobId: string) => {
    const job = cronJobs.find((j) => j.id === jobId);
    if (!job) return;
    const clone: CronJob = { ...job, id: `cron-${Date.now()}`, name: job.name + ' (copy)', createdAt: Date.now() };
    const updated = [...cronJobs, clone];
    await window.tday.saveCronJobs(updated);
    const jobs = await window.tday.listCronJobs();
    setCronJobs(jobs);
  }, [cronJobs]);

  const handleCronDelete = useCallback(async (jobId: string) => {
    const updated = cronJobs.filter((j) => j.id !== jobId);
    await window.tday.saveCronJobs(updated);
    const jobs = await window.tday.listCronJobs();
    setCronJobs(jobs);
    if (cronEditId === jobId) { setCronEditId(null); setCronDraft({}); }
  }, [cronJobs, cronEditId]);

  const handleCronToggle = useCallback(async (jobId: string, enabled: boolean) => {
    const updated = cronJobs.map((j) => (j.id === jobId ? { ...j, enabled } : j));
    await window.tday.saveCronJobs(updated);
    const [jobs, stats] = await Promise.all([window.tday.listCronJobs(), window.tday.getCronStats()]);
    setCronJobs(jobs);
    setCronStats(stats);
  }, [cronJobs]);

  const handleCronTrigger = useCallback(async (jobId: string) => {
    await window.tday.triggerCronJob(jobId);
    const stats = await window.tday.getCronStats();
    setCronStats(stats);
  }, []);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.72)' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="relative flex flex-col overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        style={{ width: dialogSize.w, height: dialogSize.h }}
      >
        <div className="relative z-10 flex shrink-0 items-center gap-1 border-b border-zinc-800/60 px-4 pb-0 pt-4">
          {TABS.map((t) => (
            <SectionTab key={t.id} active={section === t.id} onClick={() => changeSection(t.id)}>
              {t.label}
            </SectionTab>
          ))}
          <div className="flex-1" />
          <button onClick={onClose} className="mb-1 rounded p-1 text-zinc-500 hover:bg-zinc-900 hover:text-zinc-300">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        <div className="flex min-h-0 flex-1 overflow-hidden">
          {section === 'providers' && (
            <ProvidersSection cfg={cfg} onCfgChange={setCfg} onSaved={onSaved ?? (() => {})} />
          )}
          {section === 'agents' && (
            <AgentsSection
              agents={agents}
              onAgentsChange={setAgents}
              cfg={cfg}
              shared={shared}
              onSharedChange={setShared}
              cronJobs={cronJobs}
              home={home}
              onNavigateToCron={handleNavigateToCron}
            />
          )}
          {section === 'usage' && <UsageSection agents={agents} />}
          {section === 'history' && (
            <HistorySection
              entries={agentHistory}
              loading={agentHistoryLoading}
              onRestore={onRestoreHistory ?? (() => {})}
              onHide={onHideHistory ?? (() => {})}
            />
          )}
          {section === 'cron' && (
            <CronSection
              jobs={cronJobs}
              stats={cronStats}
              agents={agents}
              saving={cronSaving}
              editId={cronEditId}
              draft={cronDraft}
              home={home}
              onOpenNew={handleCronOpenNew}
              onOpenEdit={handleCronOpenEdit}
              onCloseEdit={handleCronCloseEdit}
              onDraftChange={(patch) => setCronDraft((prev) => ({ ...prev, ...patch }))}
              onSave={handleCronSave}
              onClone={handleCronClone}
              onDelete={handleCronDelete}
              onToggleEnabled={handleCronToggle}
              onTrigger={handleCronTrigger}
              onRefreshStats={refreshCronStats}
            />
          )}
        </div>

        <div
          onMouseDown={handleResizeStart}
          className="absolute bottom-0 right-0 h-4 w-4 cursor-se-resize"
          style={{ background: 'linear-gradient(135deg, transparent 50%, rgba(255,255,255,0.1) 50%)' }}
        />
      </div>
    </div>
  );
}
