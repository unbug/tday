import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgentId,
  AgentInfo,
  AgentsConfig,
  ApiStyle,
  ProviderProfile,
  ProvidersConfig,
  ProviderKind,
  UsageSummary,
  UsageFilter,
  AgentHistoryEntry,
  CronJob,
  CronJobStats,
} from '@tday/shared';
import { PROVIDER_PRESETS, presetForKind } from '@tday/shared';
import { ProviderLogo } from './ProviderLogo';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
  initialSection?: Section;
  // History integration
  agentHistory?: AgentHistoryEntry[];
  agentHistoryLoading?: boolean;
  onRestoreHistory?: (entry: AgentHistoryEntry) => void;
  onHideHistory?: (id: string) => void;
  // Cron: open a tab for manual trigger
  home?: string;
}

type Section = 'providers' | 'agents' | 'usage' | 'history' | 'cron';
type UsageDateMode = 'today' | '7d' | '30d' | '90d' | 'custom';

export function Settings({ open, onClose, onSaved, initialSection, agentHistory = [], agentHistoryLoading = false, onRestoreHistory, onHideHistory, home = '~' }: Props) {
  const [section, setSection] = useState<Section>(initialSection ?? 'providers');
  const [cfg, setCfg] = useState<ProvidersConfig | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [savedTick, setSavedTick] = useState(0);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installPct, setInstallPct] = useState(0);
  // Per-profile probe results: profileId -> { models, latencyMs, ok, probing }
  const [probeState, setProbeState] = useState<Record<string, { models: string[]; latencyMs: number; ok: boolean; probing: boolean; error?: string }>>({});
  const [usageData, setUsageData] = useState<UsageSummary | null>(null);
  const [usageDateMode, setUsageDateMode] = useState<UsageDateMode>('30d');
  const [usageCustomFrom, setUsageCustomFrom] = useState('');
  const [usageCustomTo, setUsageCustomTo] = useState('');
  const [usageAgentId, setUsageAgentId] = useState('');
  // Ref for debounced probe timer — must be declared before any early return
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // ── CronJob state ────────────────────────────────────────────────────────────
  const [cronJobs, setCronJobs] = useState<CronJob[]>([]);
  const [cronStats, setCronStats] = useState<Record<string, CronJobStats>>({});
  const [cronEditId, setCronEditId] = useState<string | null>(null); // null = no editor open
  const [cronDraft, setCronDraft] = useState<Partial<CronJob>>({});
  const [cronSaving, setCronSaving] = useState(false);
  // Jump to initialSection when it changes (e.g. opened from Usage shortcut)
  useEffect(() => {
    if (open && initialSection) setSection(initialSection);
  }, [open, initialSection]);

  const scheduleProbe = useCallback((id: string, url: string) => {
    if (probeTimer.current) clearTimeout(probeTimer.current);
    if (!url.trim()) return;
    probeTimer.current = setTimeout(() => {
      setProbeState((s) => ({ ...s, [id]: { models: [], latencyMs: 0, ok: false, probing: true } }));
      window.tday.probeUrl(url.trim()).then((result) => {
        setProbeState((s) => ({ ...s, [id]: { ...result, probing: false } }));
      }).catch(() => {
        setProbeState((s) => ({ ...s, [id]: { models: [], latencyMs: 0, ok: false, probing: false, error: 'Failed' } }));
      });
    }, 800);
  }, []);
  const SHARED_KEY = 'tday:sharedAgentConfig';
  const [shared, setShared] = useState<boolean>(false);

  // ── Resizable dialog ────────────────────────────────────────────────────────
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

  const refresh = async () => {
    const [c, a] = await Promise.all([
      window.tday.listProviders() as Promise<ProvidersConfig>,
      window.tday.listAgents() as Promise<AgentInfo[]>,
    ]);
    setCfg(c);
    setAgents(a);
    setActiveId((cur) => cur || c.default || c.profiles[0]?.id || '');
  };

  const loadUsage = async (mode: UsageDateMode, customFrom: string, customTo: string, agentId: string) => {
    const now = Date.now();
    const todayStart = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime(); })();
    const filter: UsageFilter = {};
    if (agentId) filter.agentId = agentId;
    switch (mode) {
      case 'today': filter.fromTs = todayStart; break;
      case '7d':    filter.fromTs = now - 7 * 86400000; break;
      case '30d':   filter.fromTs = now - 30 * 86400000; break;
      case '90d':   filter.fromTs = now - 90 * 86400000; break;
      case 'custom':
        if (customFrom) filter.fromTs = new Date(customFrom).getTime();
        if (customTo) { const d = new Date(customTo); d.setHours(23, 59, 59, 999); filter.toTs = d.getTime(); }
        break;
    }
    try {
      const summary = await window.tday.queryUsage(filter);
      setUsageData(summary);
    } catch {
      // ignore
    }
  };

  // Settings is lazily mounted (only enters the DOM on first open), so we
  // don't need an eager mount effect — the open effect handles first load.
  useEffect(() => {
    if (!open) return;
    if (!cfg) void refresh();
    void window.tday.getAllSettings().then((s) => {
      setShared(s['tday:sharedAgentConfig'] === true);
    });
    // Load cron data on open
    void Promise.all([
      window.tday.listCronJobs(),
      window.tday.getCronStats(),
    ]).then(([jobs, stats]) => {
      setCronJobs(jobs);
      setCronStats(stats);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Load usage stats when usage section is active.
  useEffect(() => {
    if (section === 'usage') void loadUsage(usageDateMode, usageCustomFrom, usageCustomTo, usageAgentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [section, usageDateMode, usageCustomFrom, usageCustomTo, usageAgentId]);

  const profile = useMemo(
    () => cfg?.profiles.find((p) => p.id === activeId) ?? null,
    [cfg, activeId],
  );

  if (!open) return null;

  const updateProfile = (patch: Partial<ProviderProfile>) => {
    if (!cfg || !profile) return;
    setCfg({
      ...cfg,
      profiles: cfg.profiles.map((p) => (p.id === profile.id ? { ...p, ...patch } : p)),
    });
  };

  const setDefault = (id: string) => {
    if (!cfg) return;
    setCfg({ ...cfg, default: id });
  };

  const addProfileForKind = (kind: ProviderKind) => {
    if (!cfg) return;
    const preset = presetForKind(kind);
    const baseId = kind;
    let i = 1;
    let id: string = baseId;
    while (cfg.profiles.some((p) => p.id === id)) {
      id = `${baseId}-${++i}`;
    }
    const style = preset.defaultStyle;
    const next: ProviderProfile = {
      id,
      label: preset.label,
      kind,
      apiStyle: style,
      baseUrl: preset.baseUrls[style] ?? '',
      model: preset.models[0] ?? '',
      apiKey: '',
    };
    setCfg({
      ...cfg,
      default: cfg.default ?? id,
      profiles: [...cfg.profiles, next],
    });
    setActiveId(id);
  };

  const removeProfile = (id: string) => {
    if (!cfg) return;
    const profiles = cfg.profiles.filter((p) => p.id !== id);
    const def = cfg.default === id ? profiles[0]?.id : cfg.default;
    setCfg({ ...cfg, profiles, default: def });
    if (activeId === id) setActiveId(profiles[0]?.id ?? '');
  };

  const switchKind = (kind: ProviderKind) => {
    if (!profile) return;
    const preset = presetForKind(kind);
    const style: ApiStyle = preset.defaultStyle;
    updateProfile({
      kind,
      apiStyle: style,
      baseUrl: preset.baseUrls[style] ?? profile.baseUrl ?? '',
      model: preset.models[0] ?? profile.model ?? '',
    });
  };

  const switchStyle = (style: ApiStyle) => {
    if (!profile) return;
    const preset = presetForKind(profile.kind);
    const newPresetUrl = preset.baseUrls[style];
    // Only reset baseUrl if the current value still matches one of the preset URLs
    // (i.e. the user hasn't set a custom address like a LAN IP).
    const allPresetUrls = Object.values(preset.baseUrls).map((u) => u?.replace(/\/$/, '') ?? '');
    const currentIsPreset = !profile.baseUrl || allPresetUrls.includes(profile.baseUrl.replace(/\/$/, ''));
    updateProfile({
      apiStyle: style,
      baseUrl: currentIsPreset ? (newPresetUrl ?? '') : profile.baseUrl ?? '',
    });
  };

  // Optimistic: update UI immediately, persist in background.
  const saveProviders = () => {
    if (!cfg) return;
    setSavedTick((t) => t + 1);
    void window.tday.saveProviders(cfg);
    onSaved?.();
  };

  const persistAgents = (next: AgentInfo[]) => {
    const defaultAgentId = (next.find((a) => a.isDefault)?.id ?? 'pi') as AgentId;
    const cfgOut: AgentsConfig = {
      defaultAgentId,
      agents: Object.fromEntries(
        next.map((a) => [
          a.id,
          { providerId: a.providerId || undefined, model: a.model || undefined },
        ]),
      ) as AgentsConfig['agents'],
    };
    void window.tday.saveAgents(cfgOut);
    onSaved?.();
  };

  const setAsDefault = (agentId: AgentId) => {
    const next = agents.map((a) => ({ ...a, isDefault: a.id === agentId }));
    setAgents(next);
    persistAgents(next);
  };

  const bindProvider = (agentId: string, providerId: string) => {
    const next = shared
      ? agents.map((a) => ({ ...a, providerId: providerId || undefined }))
      : agents.map((a) =>
          a.id === agentId ? { ...a, providerId: providerId || undefined } : a,
        );
    setAgents(next);
    persistAgents(next);
  };

  const setAgentModel = (agentId: string, model: string) => {
    setAgents((list) =>
      shared
        ? list.map((a) => ({ ...a, model }))
        : list.map((a) => (a.id === agentId ? { ...a, model } : a)),
    );
  };

  const flushAgentModel = () => {
    persistAgents(agents);
  };

  const toggleShared = (next: boolean) => {
    setShared(next);
    void window.tday.setSetting(SHARED_KEY, next);
    if (next) {
      // Apply the first agent's provider/model to all agents so "shared" is
      // actually a single value, not an inconsistent merge.
      const first = agents[0];
      if (first) {
        const synced = agents.map((a) => ({
          ...a,
          providerId: first.providerId,
          model: first.model,
        }));
        setAgents(synced);
        persistAgents(synced);
      }
    }
  };

  const runDiscovery = async () => {
    if (!profile) return;
    const url = profile.baseUrl?.trim();
    if (!url) return;
    // Persist the current URL before probing so closing settings won't revert it.
    saveProviders();
    setProbeState((s) => ({ ...s, [profile.id]: { models: [], latencyMs: 0, ok: false, probing: true } }));
    try {
      const result = await window.tday.probeUrl(url);
      setProbeState((s) => ({ ...s, [profile.id]: { ...result, probing: false } }));
      if (result.ok && result.models.length > 0) {
        // Persist discovered models so chips survive settings close/reopen.
        const patch: Partial<import('@tday/shared').ProviderProfile> = { discoveredModels: result.models };
        // Auto-fill model field if currently empty.
        if (!profile.model) patch.model = result.models[0];
        updateProfile(patch);
        // Save immediately so discovered models aren't lost.
        setTimeout(() => saveProviders(), 0);
      }
    } catch {
      setProbeState((s) => ({ ...s, [profile.id]: { models: [], latencyMs: 0, ok: false, probing: false, error: 'Failed' } }));
    }
  };

  // Auto-probe when base URL changes (debounced)
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
      await refresh();
    } finally {
      off();
      setTimeout(() => setInstallingId(null), 600);
    }
  };

  const profilePreset = profile ? presetForKind(profile.kind) : null;

  return (
    <div
      className="no-drag absolute inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        style={{
          width: `${dialogSize.w}px`,
          height: `${dialogSize.h}px`,
          maxWidth: '97vw',
          maxHeight: '95vh',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-full flex-col text-zinc-100">
          <div className="flex shrink-0 items-center justify-between border-b border-zinc-800/60 px-5 py-3">
            <div className="flex items-center gap-1">
              <SectionTab active={section === 'providers'} onClick={() => setSection('providers')}>
                Providers
              </SectionTab>
              <SectionTab active={section === 'agents'} onClick={() => setSection('agents')}>
                Agents
              </SectionTab>
              <SectionTab active={section === 'usage'} onClick={() => setSection('usage')}>
                Usage
              </SectionTab>
              <SectionTab active={section === 'history'} onClick={() => setSection('history')}>
                History
              </SectionTab>
              <SectionTab active={section === 'cron'} onClick={() => setSection('cron')}>
                Cron
              </SectionTab>
            </div>
            <div className="flex items-center gap-3">
              <button
                className="rounded-md px-2 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100"
                onClick={onClose}
                aria-label="Close"
              >
                ×
              </button>
            </div>
          </div>

          {section === 'providers' ? (
            <div className="flex flex-1 overflow-hidden">
              <div className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-zinc-800/60">
                {/* Provider list — fills remaining height */}
                <div className="scroll-themed flex-1 overflow-y-auto p-2">
                  {cfg?.profiles.map((p) => (
                    <button
                      key={p.id}
                      onClick={() => setActiveId(p.id)}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs ${
                        p.id === activeId
                          ? 'bg-zinc-800 text-zinc-100'
                          : 'text-zinc-400 hover:bg-zinc-900'
                      }`}
                    >
                      <ProviderLogo kind={p.kind} size={18} />
                      <span className="flex-1 truncate">{p.label}</span>
                      {cfg?.default === p.id ? (
                        <span className="rounded bg-fuchsia-500/20 px-1 text-[9px] uppercase tracking-wider text-fuchsia-300">
                          default
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
                {/* Add provider — pinned at bottom */}
                <div className="shrink-0 border-t border-zinc-800/60 p-2">
                  <details open>
                    <summary className="cursor-pointer rounded-md px-2 py-2 text-xs text-fuchsia-300 hover:bg-zinc-900">
                      + Add provider
                    </summary>
                    <div className="mt-1 max-h-56 overflow-y-auto pl-1">
                      {PROVIDER_PRESETS.map((preset) => (
                        <button
                          key={preset.kind}
                          onClick={() => addProfileForKind(preset.kind)}
                          className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[11px] text-zinc-400 hover:bg-zinc-900 hover:text-zinc-100"
                        >
                          <ProviderLogo kind={preset.kind} size={14} />
                          <span className="truncate">{preset.label}</span>
                        </button>
                      ))}
                    </div>
                  </details>
                </div>
              </div>
              <div className="scroll-themed flex-1 overflow-y-auto p-5 text-xs">
                {profile && profilePreset ? (
                  <div className="space-y-3">
                    <div className="flex items-center gap-3 pb-2">
                      <ProviderLogo kind={profile.kind} size={28} />
                      <div className="flex-1">
                        <div className="text-sm font-medium text-zinc-100">{profile.label}</div>
                        <div className="text-[10px] uppercase tracking-wider text-zinc-500">
                          {profile.kind}
                          {profilePreset.description ? ` · ${profilePreset.description}` : ''}
                        </div>
                      </div>
                      {cfg && cfg.profiles.length > 1 ? (
                        <button
                          onClick={() => removeProfile(profile.id)}
                          className="rounded-md px-2 py-1 text-[10px] text-zinc-500 hover:bg-zinc-800 hover:text-rose-300"
                        >
                          Delete
                        </button>
                      ) : null}
                    </div>
                    <Field label="Label">
                      <input
                        className="input"
                        value={profile.label}
                        onChange={(e) => updateProfile({ label: e.target.value })}
                      />
                    </Field>
                    <Field label="Provider">
                      <select
                        className="input"
                        value={profile.kind}
                        onChange={(e) => switchKind(e.target.value as ProviderKind)}
                      >
                        {PROVIDER_PRESETS.map((p) => (
                          <option key={p.kind} value={p.kind}>
                            {p.label}
                          </option>
                        ))}
                      </select>
                    </Field>
                    <Field label="API style">
                      <div className="flex gap-2">
                        <StyleToggle
                          active={(profile.apiStyle ?? 'openai') === 'openai'}
                          onClick={() => switchStyle('openai')}
                        >
                          OpenAI-compatible
                        </StyleToggle>
                        <StyleToggle
                          active={profile.apiStyle === 'anthropic'}
                          onClick={() => switchStyle('anthropic')}
                        >
                          Anthropic-compatible
                        </StyleToggle>
                      </div>
                    </Field>
                    <Field label="Base URL">
                      <div className="flex gap-1.5">
                        <input
                          className="input flex-1"
                          placeholder={
                            profilePreset.baseUrls[profile.apiStyle ?? 'openai'] ??
                            'https://api.example.com/v1'
                          }
                          value={profile.baseUrl ?? ''}
                          onChange={(e) => {
                            updateProfile({ baseUrl: e.target.value });
                            scheduleProbe(profile.id, e.target.value);
                          }}
                          onBlur={() => saveProviders()}
                        />
                        <button
                          onClick={() => void runDiscovery()}
                          disabled={probeState[profile.id]?.probing}
                          title="Scan this URL for available models"
                          className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
                        >
                          {probeState[profile.id]?.probing ? '…' : 'Scan'}
                        </button>
                      </div>
                      {/* Probe status badge */}
                      {probeState[profile.id] && !probeState[profile.id].probing ? (
                        <div className="mt-1 flex items-center gap-1.5 text-[10px]">
                          {probeState[profile.id].ok ? (
                            <>
                              <span className="text-emerald-400">● reachable</span>
                              <span className="text-zinc-500">·</span>
                              <span className="text-zinc-400">{probeState[profile.id].latencyMs}ms</span>
                              {probeState[profile.id].models.length > 0 ? (
                                <>
                                  <span className="text-zinc-500">·</span>
                                  <span className="text-zinc-400">{probeState[profile.id].models.length} model{probeState[profile.id].models.length !== 1 ? 's' : ''} found</span>
                                </>
                              ) : null}
                            </>
                          ) : (
                            <span className="text-rose-400">
                              ● {probeState[profile.id].error ?? 'Not reachable'}
                            </span>
                          )}
                        </div>
                      ) : null}
                    </Field>
                    <Field label="Model">
                      {(() => {
                        const probed = probeState[profile.id];
                        // Merge: live probe result > persisted discovered models > preset static list
                        const probedModels = probed?.models ?? [];
                        const persistedModels = profile.discoveredModels ?? [];
                        const baseModels = probedModels.length > 0 ? probedModels : persistedModels;
                        const allModels = [
                          ...baseModels,
                          ...profilePreset.models.filter((m) => !baseModels.includes(m)),
                        ];
                        return (
                          <>
                            <input
                              className="input"
                              list={`models-${profile.id}`}
                              placeholder={allModels[0] ?? 'model-id'}
                              value={profile.model ?? ''}
                              onChange={(e) => updateProfile({ model: e.target.value })}
                            />
                            <datalist id={`models-${profile.id}`}>
                              {allModels.map((m) => (
                                <option key={m} value={m} />
                              ))}
                            </datalist>
                            {baseModels.length > 0 ? (
                              <div className="mt-1 flex flex-wrap gap-1">
                                {probedModels.map((m) => (
                                  <button
                                    key={m}
                                    onClick={() => updateProfile({ model: m })}
                                    className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                                      profile.model === m
                                        ? 'bg-fuchsia-500/25 text-fuchsia-200'
                                        : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
                                    }`}
                                  >
                                    {m}
                                  </button>
                                ))}
                              </div>
                            ) : null}
                          </>
                        );
                      })()}
                    </Field>
                    <Field label="API Key">
                      <input
                        className="input"
                        type="password"
                        placeholder="sk-…"
                        value={profile.apiKey ?? ''}
                        onChange={(e) => updateProfile({ apiKey: e.target.value })}
                      />
                    </Field>
                    <div className="flex items-center justify-between pt-2">
                      <label className="flex cursor-pointer items-center gap-2 text-zinc-300">
                        <input
                          type="checkbox"
                          checked={cfg?.default === profile.id}
                          onChange={(e) => e.target.checked && setDefault(profile.id)}
                        />
                        Use as default
                      </label>
                      <button
                        onClick={saveProviders}
                        className="rounded-md bg-fuchsia-500/90 px-4 py-1.5 text-xs font-medium text-white hover:bg-fuchsia-500"
                      >
                        Save
                      </button>
                    </div>
                    {savedTick > 0 ? (
                      <p className="pt-1 text-[10px] text-emerald-400">
                        Saved to ~/.tday/providers.json
                      </p>
                    ) : null}
                  </div>
                ) : (
                  <p className="text-zinc-500">No provider selected.</p>
                )}
              </div>
            </div>
          ) : section === 'agents' ? (
            <div className="scroll-themed flex-1 overflow-y-auto p-4">
              <p className="px-2 pb-2 text-[11px] text-zinc-500">
                Bind a provider to a harness agent — every new tab launches that agent
                with the bound provider/model automatically. Pick a default to use when
                opening new tabs.
              </p>
              <label className="mx-2 mb-3 flex cursor-pointer items-center gap-2 rounded-md border border-zinc-800/60 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-300">
                <input
                  type="checkbox"
                  checked={shared}
                  onChange={(e) => toggleShared(e.target.checked)}
                />
                <span className="flex-1">
                  Use one provider/model for <strong>all</strong> agents
                </span>
                <span className="text-[10px] text-zinc-500">
                  changes propagate to every harness
                </span>
              </label>
              <div className="space-y-2">
                {agents.map((a) => {
                  const bound = cfg?.profiles.find((p) => p.id === a.providerId);
                  const boundPreset = bound ? presetForKind(bound.kind) : null;
                  const modelOptions = boundPreset?.models ?? [];
                  const isInstalling = installingId === a.id;
                  return (
                    <div
                      key={a.id}
                      className="rounded-lg border border-zinc-800/60 bg-zinc-900/40 p-3"
                    >
                      <div className="flex items-center gap-3">
                        <div className="flex h-9 w-9 items-center justify-center rounded-md bg-zinc-800/60 text-sm font-semibold text-zinc-200">
                          {a.displayName.charAt(0)}
                        </div>
                        <div className="flex-1">
                          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
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
                            <div className="text-[11px] text-zinc-500">{a.description}</div>
                          ) : null}
                        </div>
                        {/* Install / Update / Uninstall actions */}
                        <div className="flex items-center gap-1">
                          {!a.detect.available && a.npmPackage ? (
                            <button
                              onClick={() => installAgent(a.id, 'install')}
                              disabled={isInstalling}
                              className="rounded-md bg-fuchsia-500/90 px-3 py-1 text-xs font-medium text-white hover:bg-fuchsia-500 disabled:opacity-60"
                            >
                              {isInstalling ? `${installPct}%` : 'Install'}
                            </button>
                          ) : null}
                          {a.detect.available && a.npmPackage ? (
                            <>
                              <button
                                onClick={() => installAgent(a.id, 'update')}
                                disabled={isInstalling}
                                className="rounded-md border border-zinc-700 px-2 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-60"
                                title="Update to latest"
                              >
                                {isInstalling ? `${installPct}%` : 'Update'}
                              </button>
                              <button
                                onClick={() => installAgent(a.id, 'uninstall')}
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
                        <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
                          <div
                            className="h-full bg-gradient-to-r from-fuchsia-500 to-sky-400 transition-all duration-300"
                            style={{ width: `${Math.max(2, installPct)}%` }}
                          />
                        </div>
                      ) : null}

                      <div className="mt-3 grid grid-cols-2 gap-2">
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

                      <div className="mt-3 flex items-center justify-end">
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
                    </div>
                  );
                })}
              </div>
            </div>
          ) : section === 'usage' ? (
            <div className="flex min-h-0 flex-1 overflow-hidden text-xs">
              {/* Left sidebar: filters + summary */}
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
                    {[{ id: '', label: 'All agents' }, ...agents.map((a) => ({ id: a.id, label: a.displayName }))].map(({ id, label }) => (
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
                  onClick={() => void loadUsage(usageDateMode, usageCustomFrom, usageCustomTo, usageAgentId)}
                  className="rounded-md px-2.5 py-1.5 text-[11px] bg-zinc-900 text-zinc-400 hover:bg-zinc-800"
                >
                  Refresh
                </button>
              </div>

              {/* Right area: summary cards + charts + breakdown tables */}
              <div className="scroll-themed flex-1 overflow-y-auto p-4">
              {usageData ? (
                <>
                  {/* Summary cards */}
                  <div className="mb-4 grid grid-cols-3 gap-2">
                    <StatCard label="Total tokens" value={fmtNum(usageData.totalInputTokens + usageData.totalOutputTokens)}
                      sub={`${fmtNum(usageData.totalInputTokens)} in · ${fmtNum(usageData.totalOutputTokens)} out`}
                    />
                    <StatCard label="Requests" value={String(usageData.totalRequests)}
                      sub={usageData.totalToolCalls > 0 ? `${fmtNum(usageData.totalToolCalls)} tool calls` : undefined}
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
                        Daily tokens ({usageDateMode === 'today' ? 'today' : usageDateMode === 'custom' ? 'custom range' : usageDateMode})
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
                              .sort(([, a], [, b]) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.requests - a.requests)
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
                                  {m.costUsd === null ? '—' : m.costUsd === 0 ? 'Free' : `$${m.costUsd.toFixed(4)}`}
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
                              .sort(([, a], [, b]) => (b.inputTokens + b.outputTokens) - (a.inputTokens + a.outputTokens) || b.requests - a.requests)
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
                                  {ag.costUsd === null ? '—' : ag.costUsd === 0 ? 'Free' : `$${ag.costUsd.toFixed(4)}`}
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
          ) : section === 'history' ? (
            <HistorySection
              entries={agentHistory}
              loading={agentHistoryLoading}
              onRestore={(entry) => {
                onRestoreHistory?.(entry);
              }}
              onHide={(id) => {
                onHideHistory?.(id);
              }}
            />
          ) : section === 'cron' ? (
            <CronSection
              jobs={cronJobs}
              stats={cronStats}
              agents={agents}
              saving={cronSaving}
              editId={cronEditId}
              draft={cronDraft}
              home={home}
              onOpenNew={() => {
                setCronEditId('__new__');
                setCronDraft({ agentId: 'codex', schedule: '0 9 * * 1-5', enabled: true, cwd: home, prompt: '', name: '' });
              }}
              onOpenEdit={(job) => {
                setCronEditId(job.id);
                setCronDraft({ ...job });
              }}
              onCloseEdit={() => { setCronEditId(null); setCronDraft({}); }}
              onDraftChange={(patch) => setCronDraft((d) => ({ ...d, ...patch }))}
              onSave={async () => {
                if (!cronDraft.name?.trim() || !cronDraft.schedule?.trim()) return;
                setCronSaving(true);
                try {
                  let next: CronJob[];
                  if (cronEditId === '__new__') {
                    const newJob: CronJob = {
                      id: `cron-${Date.now()}`,
                      name: cronDraft.name!.trim(),
                      agentId: (cronDraft.agentId ?? 'codex') as AgentId,
                      cwd: cronDraft.cwd ?? home,
                      prompt: cronDraft.prompt ?? '',
                      schedule: cronDraft.schedule!.trim(),
                      enabled: cronDraft.enabled ?? true,
                      createdAt: Date.now(),
                    };
                    next = [...cronJobs, newJob];
                  } else {
                    next = cronJobs.map((j) =>
                      j.id === cronEditId
                        ? {
                            ...j,
                            name: cronDraft.name!.trim(),
                            agentId: (cronDraft.agentId ?? j.agentId) as AgentId,
                            cwd: cronDraft.cwd ?? j.cwd,
                            prompt: cronDraft.prompt ?? j.prompt,
                            schedule: cronDraft.schedule!.trim(),
                            enabled: cronDraft.enabled ?? j.enabled,
                          }
                        : j,
                    );
                  }
                  await window.tday.saveCronJobs(next);
                  const stats = await window.tday.getCronStats();
                  setCronJobs(next);
                  setCronStats(stats);
                  setCronEditId(null);
                  setCronDraft({});
                } finally {
                  setCronSaving(false);
                }
              }}
              onClone={async (jobId) => {
                const src = cronJobs.find((j) => j.id === jobId);
                if (!src) return;
                const cloned: CronJob = {
                  ...src,
                  id: `cron-${Date.now()}`,
                  name: `Copy of ${src.name}`,
                  enabled: false,
                  createdAt: Date.now(),
                };
                const next = [...cronJobs, cloned];
                await window.tday.saveCronJobs(next);
                const stats = await window.tday.getCronStats();
                setCronJobs(next);
                setCronStats(stats);
                setCronEditId(cloned.id);
                setCronDraft({ ...cloned });
              }}
              onDelete={async (jobId) => {
                const next = cronJobs.filter((j) => j.id !== jobId);
                await window.tday.saveCronJobs(next);
                setCronJobs(next);
                if (cronEditId === jobId) { setCronEditId(null); setCronDraft({}); }
              }}
              onToggleEnabled={async (jobId, enabled) => {
                const next = cronJobs.map((j) => j.id === jobId ? { ...j, enabled } : j);
                await window.tday.saveCronJobs(next);
                const stats = await window.tday.getCronStats();
                setCronJobs(next);
                setCronStats(stats);
              }}
              onTrigger={async (jobId) => {
                await window.tday.triggerCronJob(jobId);
                // Refresh stats after trigger
                setTimeout(async () => {
                  const stats = await window.tday.getCronStats();
                  setCronStats(stats);
                }, 200);
              }}
              onRefreshStats={async () => {
                const stats = await window.tday.getCronStats();
                setCronStats(stats);
              }}
            />
          ) : null}
        </div>
        {/* Resize handle — bottom-right corner */}
        <div
          className="absolute bottom-0 right-0 z-20 h-5 w-5 cursor-se-resize"
          style={{
            background:
              'linear-gradient(135deg, transparent 40%, rgba(113,113,122,0.35) 40%, rgba(113,113,122,0.35) 55%, transparent 55%, transparent 70%, rgba(113,113,122,0.35) 70%)',
          }}
          onMouseDown={handleResizeStart}
          title="Drag to resize"
        />
      </div>
    </div>
  );
}

// ── CronSection ───────────────────────────────────────────────────────────────

const CRON_AGENT_IDS: AgentId[] = [
  'pi', 'claude-code', 'codex', 'copilot', 'opencode', 'gemini', 'qwen-code', 'crush', 'hermes',
];

// ── Schedule helpers ─────────────────────────────────────────────────────────

type SchedMode = 'interval' | 'at' | 'cron';
type IntervalUnit = 'min' | 'hour' | 'day';
type AtRepeat = 'daily' | 'weekdays' | 'weekly' | 'monthly';

interface SchedState {
  mode: SchedMode;
  intervalVal: number;
  intervalUnit: IntervalUnit;
  atHour: number;
  atMin: number;
  atRepeat: AtRepeat;
  atWeekday: number;
  atMonthDay: number;
  customExpr: string;
}

const DEFAULT_SCHED: SchedState = {
  mode: 'interval', intervalVal: 30, intervalUnit: 'min',
  atHour: 9, atMin: 0, atRepeat: 'daily', atWeekday: 1, atMonthDay: 1,
  customExpr: '0 9 * * *',
};

function parseCronSchedule(expr: string): SchedState {
  const f = (expr ?? '').trim().split(/\s+/);
  if (f.length !== 5) return { ...DEFAULT_SCHED, mode: 'cron', customExpr: expr };
  const [mf, hf, domf, , dowf] = f;
  const mStep = mf.match(/^\*\/(\d+)$/);
  if (mStep && hf === '*' && domf === '*') {
    return { ...DEFAULT_SCHED, mode: 'interval', intervalVal: +mStep[1], intervalUnit: 'min' };
  }
  const hStep = hf.match(/^\*\/(\d+)$/);
  if (mf === '0' && hStep && domf === '*') {
    return { ...DEFAULT_SCHED, mode: 'interval', intervalVal: +hStep[1], intervalUnit: 'hour' };
  }
  const domStep = domf.match(/^\*\/(\d+)$/);
  if (mf === '0' && hf === '0' && domStep) {
    return { ...DEFAULT_SCHED, mode: 'interval', intervalVal: +domStep[1], intervalUnit: 'day' };
  }
  const mNum = parseInt(mf, 10);
  const hNum = parseInt(hf, 10);
  if (!isNaN(mNum) && mNum >= 0 && mNum <= 59 && !isNaN(hNum) && hNum >= 0 && hNum <= 23) {
    const base = { ...DEFAULT_SCHED, mode: 'at' as const, atHour: hNum, atMin: mNum };
    if (domf === '*' && dowf === '*') return { ...base, atRepeat: 'daily' };
    if (domf === '*' && dowf === '1-5') return { ...base, atRepeat: 'weekdays' };
    if (domf === '*') {
      const wd = parseInt(dowf, 10);
      if (!isNaN(wd) && wd >= 0 && wd <= 6) return { ...base, atRepeat: 'weekly', atWeekday: wd };
    }
    if (dowf === '*') {
      const dom = parseInt(domf, 10);
      if (!isNaN(dom) && dom >= 1 && dom <= 31) return { ...base, atRepeat: 'monthly', atMonthDay: dom };
    }
  }
  return { ...DEFAULT_SCHED, mode: 'cron', customExpr: expr };
}

function buildCronExpr(s: SchedState): string {
  if (s.mode === 'interval') {
    const v = Math.max(1, s.intervalVal);
    if (s.intervalUnit === 'min') return `*/${v} * * * *`;
    if (s.intervalUnit === 'hour') return `0 */${v} * * *`;
    return `0 0 */${v} * *`;
  }
  if (s.mode === 'at') {
    const m = s.atMin.toString().padStart(2, '0');
    const h = s.atHour.toString();
    if (s.atRepeat === 'daily') return `${m} ${h} * * *`;
    if (s.atRepeat === 'weekdays') return `${m} ${h} * * 1-5`;
    if (s.atRepeat === 'weekly') return `${m} ${h} * * ${s.atWeekday}`;
    if (s.atRepeat === 'monthly') return `${m} ${h} ${s.atMonthDay} * *`;
  }
  return s.customExpr;
}

const WEEKDAY_LABEL = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function describeCronExpr(expr: string): string {
  const s = parseCronSchedule(expr);
  if (s.mode === 'interval') {
    const v = Math.max(1, s.intervalVal);
    if (s.intervalUnit === 'min') return `Every ${v} min`;
    if (s.intervalUnit === 'hour') return `Every ${v} hr`;
    return `Every ${v} day${v > 1 ? 's' : ''}`;
  }
  if (s.mode === 'at') {
    const t = `${s.atHour.toString().padStart(2,'0')}:${s.atMin.toString().padStart(2,'0')}`;
    if (s.atRepeat === 'daily') return `Daily at ${t}`;
    if (s.atRepeat === 'weekdays') return `Weekdays at ${t}`;
    if (s.atRepeat === 'weekly') return `Every ${WEEKDAY_LABEL[s.atWeekday] ?? `day ${s.atWeekday}`} at ${t}`;
    if (s.atRepeat === 'monthly') return `Monthly on day ${s.atMonthDay} at ${t}`;
  }
  return expr;
}

// ── ScheduleWidget ────────────────────────────────────────────────────────────

function ScheduleWidget({ value, onChange }: { value: string; onChange: (expr: string) => void }) {
  const [s, setS] = useState<SchedState>(() => parseCronSchedule(value));

  // Re-parse when the editor opens a different job.
  useEffect(() => { setS(parseCronSchedule(value)); }, [value]);

  const update = (patch: Partial<SchedState>) => {
    const next = { ...s, ...patch };
    setS(next);
    onChange(buildCronExpr(next));
  };

  const modeBtn = (m: SchedMode, label: string) => (
    <button
      key={m}
      onClick={() => update({ mode: m })}
      className={`rounded px-2.5 py-1 text-[11px] transition-colors ${
        s.mode === m
          ? 'bg-fuchsia-500/25 text-fuchsia-200'
          : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2">
      {/* Mode tabs */}
      <div className="flex gap-1">
        {modeBtn('interval', 'Interval')}
        {modeBtn('at', 'At time')}
        {modeBtn('cron', 'Custom')}
      </div>

      {s.mode === 'interval' && (
        <div className="flex items-center gap-2">
          <span className="text-zinc-500">Every</span>
          <input
            type="number"
            min={1}
            className="input w-16 text-center"
            value={s.intervalVal}
            onChange={(e) => update({ intervalVal: Math.max(1, parseInt(e.target.value, 10) || 1) })}
          />
          <select
            className="input w-24"
            value={s.intervalUnit}
            onChange={(e) => update({ intervalUnit: e.target.value as IntervalUnit })}
          >
            <option value="min">minutes</option>
            <option value="hour">hours</option>
            <option value="day">days</option>
          </select>
        </div>
      )}

      {s.mode === 'at' && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">Time</span>
            <input
              type="number"
              min={0} max={23}
              className="input w-14 text-center"
              value={s.atHour}
              onChange={(e) => update({ atHour: Math.min(23, Math.max(0, parseInt(e.target.value, 10) || 0)) })}
            />
            <span className="text-zinc-600">:</span>
            <input
              type="number"
              min={0} max={59}
              className="input w-14 text-center"
              value={s.atMin}
              onChange={(e) => update({ atMin: Math.min(59, Math.max(0, parseInt(e.target.value, 10) || 0)) })}
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {(['daily','weekdays','weekly','monthly'] as AtRepeat[]).map((r) => (
              <button
                key={r}
                onClick={() => update({ atRepeat: r })}
                className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
                  s.atRepeat === r
                    ? 'bg-fuchsia-500/25 text-fuchsia-200'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {r === 'daily' ? 'Daily' : r === 'weekdays' ? 'Weekdays' : r === 'weekly' ? 'Weekly' : 'Monthly'}
              </button>
            ))}
          </div>
          {s.atRepeat === 'weekly' && (
            <div className="flex gap-1">
              {WEEKDAY_LABEL.map((label, i) => (
                <button
                  key={i}
                  onClick={() => update({ atWeekday: i })}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                    s.atWeekday === i
                      ? 'bg-fuchsia-500/25 text-fuchsia-200'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {s.atRepeat === 'monthly' && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">Day</span>
              <input
                type="number"
                min={1} max={31}
                className="input w-14 text-center"
                value={s.atMonthDay}
                onChange={(e) => update({ atMonthDay: Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)) })}
              />
              <span className="text-zinc-500">of the month</span>
            </div>
          )}
        </div>
      )}

      {s.mode === 'cron' && (
        <div className="space-y-2">
          {/* Date-time picker — fills cron fields from a picked date */}
          <div>
            <label className="mb-1 block text-[10px] text-zinc-500">Pick a date &amp; time (auto-fills expression)</label>
            <input
              type="datetime-local"
              className="input-date w-full"
              onChange={(e) => {
                if (!e.target.value) return;
                const d = new Date(e.target.value);
                const expr = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
                update({ customExpr: expr });
              }}
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] text-zinc-500">Or type a cron expression directly</label>
            <input
              className="input w-full font-mono"
              placeholder="0 9 * * 1-5"
              value={s.customExpr}
              onChange={(e) => update({ customExpr: e.target.value })}
            />
            <p className="mt-1 text-[10px] text-zinc-600">
              Format: <code>min hour dom month dow</code> — e.g. <code>0 9 * * 1-5</code> = weekdays at 9am
            </p>
          </div>
        </div>
      )}

      {/* Preview */}
      <p className="text-[10px] text-zinc-500">
        Schedule: <span className="text-zinc-300">{describeCronExpr(buildCronExpr(s))}</span>
        <span className="ml-2 font-mono text-zinc-600">{buildCronExpr(s)}</span>
      </p>
    </div>
  );
}

const CRON_AGENT_LABEL: Record<string, string> = {
  pi: 'Pi', 'claude-code': 'Claude', codex: 'Codex', copilot: 'Copilot',
  opencode: 'OpenCode', gemini: 'Gemini', 'qwen-code': 'Qwen', crush: 'Crush', hermes: 'Hermes',
};
const CRON_AGENT_COLOR: Record<string, string> = {
  pi: '#a78bfa', 'claude-code': '#f97316', codex: '#22d3ee', copilot: '#60a5fa',
  opencode: '#34d399', gemini: '#4ade80', 'qwen-code': '#f472b6', crush: '#fb7185', hermes: '#fbbf24',
};

function fmtCronTime(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  const now = new Date();
  const diff = d.getTime() - now.getTime();
  // Future: relative
  if (diff > 0) {
    const m = Math.round(diff / 60000);
    if (m < 2) return 'in <1 min';
    if (m < 60) return `in ${m} min`;
    const h = Math.round(m / 60);
    if (h < 24) return `in ${h}h`;
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  // Past: absolute
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface CronSectionProps {
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

function CronSection({
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
                  editId === job.id ? 'bg-zinc-800 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900'
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
                      job.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-700/60 text-zinc-500'
                    }`}
                  >
                    {job.enabled ? 'on' : 'off'}
                  </span>
                </div>
                <div className="mt-0.5 truncate text-[10px] text-zinc-600">{describeCronExpr(job.schedule)}</div>
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
                      {CRON_AGENT_LABEL[id] ?? id}{!available ? ' (not installed)' : ''}
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
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="font-medium text-zinc-100">{job.name}</span>
                            <span
                              className="text-[10px] font-medium"
                              style={{ color: CRON_AGENT_COLOR[job.agentId] ?? '#71717a' }}
                            >
                              {CRON_AGENT_LABEL[job.agentId] ?? job.agentId}
                            </span>
                            <span
                              className={`rounded px-1.5 text-[9px] uppercase tracking-wider ${
                                job.enabled ? 'bg-emerald-500/20 text-emerald-300' : 'bg-zinc-700/60 text-zinc-500'
                              }`}
                            >
                              {job.enabled ? 'enabled' : 'disabled'}
                            </span>
                            {s?.lastStatus === 'error' ? (
                              <span className="rounded bg-rose-500/20 px-1.5 text-[9px] text-rose-300">error</span>
                            ) : null}
                          </div>
                          <div className="mt-0.5 text-[10px] text-zinc-500">{describeCronExpr(job.schedule)}</div>
                          <div className="mt-0.5 font-mono text-[10px] text-zinc-700">{job.schedule}</div>
                          <div className="mt-0.5 truncate text-[10px] text-zinc-600" title={job.cwd}>
                            {job.cwd || home}
                          </div>
                          {job.prompt ? (
                            <div className="mt-1 line-clamp-2 text-[10px] text-zinc-500">
                              {job.prompt}
                            </div>
                          ) : null}
                        </div>
                        <div className="flex shrink-0 flex-col items-end gap-1">
                          {/* Enable toggle */}
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
                            <div className="text-[9px] uppercase tracking-wider text-zinc-600">Last run</div>
                            <div className="text-[11px] text-zinc-400">{fmtCronTime(s.lastRunAt)}</div>
                          </div>
                          <div>
                            <div className="text-[9px] uppercase tracking-wider text-zinc-600">Next run</div>
                            <div className="text-[11px] text-zinc-400">{fmtCronTime(s.nextRunAt)}</div>
                          </div>
                          <div>
                            <div className="text-[9px] uppercase tracking-wider text-zinc-600">Run count</div>
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

function SectionTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
        active
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
}

const StyleToggle = memo(function StyleToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md border px-3 py-1.5 text-[11px] transition-colors ${
        active
          ? 'border-fuchsia-500/60 bg-fuchsia-500/15 text-fuchsia-200'
          : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
});

const Field = memo(function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {children}
    </label>
  );
});

function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

function StatCard({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-900/60 p-3 text-center">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
      {sub ? <div className="mt-0.5 text-[10px] text-zinc-500">{sub}</div> : null}
    </div>
  );
}

function DailyBarChart({ data }: { data: Array<{ date: string; inputTokens: number; outputTokens: number }> }) {
  const maxTokens = Math.max(...data.map((d) => d.inputTokens + d.outputTokens), 1);
  const barW = Math.max(4, Math.floor(720 / data.length) - 2);
  const chartH = 60;
  return (
    <div className="overflow-x-auto">
      <svg
        width={data.length * (barW + 2)}
        height={chartH + 18}
        className="block"
        style={{ minWidth: '100%' }}
      >
        {data.map((d, i) => {
          const total = d.inputTokens + d.outputTokens;
          const totalH = Math.round((total / maxTokens) * chartH);
          const inputH = Math.round((d.inputTokens / maxTokens) * chartH);
          const outputH = totalH - inputH;
          const x = i * (barW + 2);
          return (
            <g key={d.date}>
              {/* output tokens (top, lighter) */}
              {outputH > 0 && (
                <rect
                  x={x} y={chartH - totalH}
                  width={barW} height={outputH}
                  fill="#a78bfa" opacity={0.7}
                />
              )}
              {/* input tokens (bottom, brighter) */}
              {inputH > 0 && (
                <rect
                  x={x} y={chartH - inputH}
                  width={barW} height={inputH}
                  fill="#c084fc" opacity={0.9}
                />
              )}
              {/* date label — show every ~7 bars */}
              {i % Math.ceil(data.length / 8) === 0 ? (
                <text
                  x={x + barW / 2} y={chartH + 13}
                  fontSize={8} fill="#71717a" textAnchor="middle"
                >
                  {d.date.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-fuchsia-400/90" />
          Input
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-violet-400/70" />
          Output
        </span>
      </div>
    </div>
  );
}

// ── History Section ───────────────────────────────────────────────────────────

const HIST_AGENT_LABEL: Record<string, string> = {
  pi: 'Pi', 'claude-code': 'Claude', codex: 'Codex', copilot: 'Copilot',
  opencode: 'OpenCode', gemini: 'Gemini', 'qwen-code': 'Qwen', crush: 'Crush', hermes: 'Hermes',
};
const HIST_AGENT_COLOR: Record<string, string> = {
  pi: '#a78bfa', 'claude-code': '#f97316', codex: '#22d3ee', copilot: '#60a5fa',
  opencode: '#34d399', gemini: '#4ade80', 'qwen-code': '#f472b6', crush: '#fb7185', hermes: '#fbbf24',
};
function histAgentLabel(id: string) { return HIST_AGENT_LABEL[id] ?? id; }
function histAgentColor(id: string) { return HIST_AGENT_COLOR[id] ?? '#71717a'; }

type HistTimeGroup = 'Today' | 'Yesterday' | 'This Week' | 'This Month' | 'Older';
const HIST_TIME_ORDER: HistTimeGroup[] = ['Today', 'Yesterday', 'This Week', 'This Month', 'Older'];
function histTimeGroup(ts: number): HistTimeGroup {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86_400_000;
  const weekStart = today - ((now.getDay() || 7) - 1) * 86_400_000;
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  if (ts >= today) return 'Today';
  if (ts >= yesterday) return 'Yesterday';
  if (ts >= weekStart) return 'This Week';
  if (ts >= monthStart) return 'This Month';
  return 'Older';
}
function histRelative(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

interface HistorySectionProps {
  entries: AgentHistoryEntry[];
  loading: boolean;
  onRestore: (entry: AgentHistoryEntry) => void;
  onHide: (id: string) => void;
}

function HistorySection({ entries, loading, onRestore, onHide }: HistorySectionProps) {
  const [search, setSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('all');
  const [groupByAgent, setGroupByAgent] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const agentIds = useMemo(() => {
    const seen = new Set<string>();
    for (const e of entries) seen.add(e.agentId);
    return Array.from(seen).sort((a, b) => histAgentLabel(a).localeCompare(histAgentLabel(b)));
  }, [entries]);

  const filtered = useMemo(() => {
    let result = entries;
    if (agentFilter !== 'all') result = result.filter((e) => e.agentId === agentFilter);
    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter(
        (e) =>
          e.title.toLowerCase().includes(q) ||
          e.cwd.toLowerCase().includes(q) ||
          histAgentLabel(e.agentId).toLowerCase().includes(q),
      );
    }
    return result;
  }, [entries, agentFilter, search]);

  const grouped = useMemo((): Array<[string, AgentHistoryEntry[]]> => {
    if (groupByAgent) {
      const map = new Map<string, AgentHistoryEntry[]>();
      for (const e of filtered) {
        const key = histAgentLabel(e.agentId);
        if (!map.has(key)) map.set(key, []);
        map.get(key)!.push(e);
      }
      return Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
    }
    const map = new Map<HistTimeGroup, AgentHistoryEntry[]>();
    for (const e of filtered) {
      const g = histTimeGroup(e.updatedAt);
      if (!map.has(g)) map.set(g, []);
      map.get(g)!.push(e);
    }
    return HIST_TIME_ORDER.filter((g) => map.has(g)).map((g) => [g, map.get(g)!]);
  }, [filtered, groupByAgent]);

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Agent sidebar */}
      <div className="scroll-themed flex w-40 shrink-0 flex-col overflow-y-auto border-r border-zinc-800/60 p-2 text-xs">
        {[{ id: 'all', label: 'All' }, ...agentIds.map((id) => ({ id, label: histAgentLabel(id) }))].map(
          ({ id, label }) => (
            <button
              key={id}
              onClick={() => setAgentFilter(id)}
              className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left ${
                agentFilter === id
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900'
              }`}
            >
              {id !== 'all' && (
                <span
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ background: histAgentColor(id) }}
                />
              )}
              <span className="truncate">{label}</span>
              {id !== 'all' && (
                <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
                  {entries.filter((e) => e.agentId === id).length}
                </span>
              )}
            </button>
          ),
        )}
      </div>

      {/* Main list */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        {/* Toolbar */}
        <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800/40 px-3 py-2">
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search sessions…"
            className="input h-7 flex-1 py-0 text-xs"
          />
          <button
            onClick={() => setGroupByAgent(false)}
            className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
              !groupByAgent ? 'bg-fuchsia-500/20 text-fuchsia-200' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            By Time
          </button>
          <button
            onClick={() => setGroupByAgent(true)}
            className={`rounded-md px-2.5 py-1 text-[11px] transition-colors ${
              groupByAgent ? 'bg-fuchsia-500/20 text-fuchsia-200' : 'bg-zinc-900 text-zinc-400 hover:bg-zinc-800'
            }`}
          >
            By Agent
          </button>
        </div>

        {loading ? (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
            Loading history…
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-1 items-center justify-center text-xs text-zinc-600">
            {search ? 'No matches' : 'No history yet'}
          </div>
        ) : (
          <div className="scroll-themed flex-1 overflow-y-auto">
            {grouped.map(([groupLabel, groupEntries]) => (
              <div key={groupLabel}>
                <div className="sticky top-0 z-10 bg-zinc-950/90 px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">
                  {groupLabel}
                </div>
                {groupEntries.map((entry) => (
                  <div
                    key={entry.id}
                    className="group flex items-start gap-2.5 px-3 py-2 hover:bg-zinc-900/60"
                  >
                    <button
                      onClick={() => onRestore(entry)}
                      className="flex min-w-0 flex-1 items-start gap-2.5 text-left"
                    >
                      <span
                        className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                        style={{ background: histAgentColor(entry.agentId) }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <span
                            className="shrink-0 text-[10px] font-medium"
                            style={{ color: histAgentColor(entry.agentId) }}
                          >
                            {histAgentLabel(entry.agentId)}
                          </span>
                          <span className="truncate text-xs text-zinc-200">{entry.title}</span>
                        </div>
                        <div className="mt-0.5 flex items-center gap-2 text-[10px] text-zinc-600">
                          <span className="min-w-0 flex-1 truncate" title={entry.cwd}>
                            {entry.cwd.replace(/^.*[/\\](.+[/\\].+)$/, '…/$1').replace(/\\/g, '/')}
                          </span>
                          <span className="shrink-0">{histRelative(entry.updatedAt)}</span>
                          {entry.messageCount > 0 && (
                            <span className="shrink-0 rounded bg-zinc-800 px-1 text-[9px] text-zinc-500">
                              {entry.messageCount} msgs
                            </span>
                          )}
                          {entry.source === 'tday' && (
                            <span className="shrink-0 rounded bg-zinc-800 px-1 text-[9px] text-zinc-600">
                              tracked
                            </span>
                          )}
                        </div>
                      </div>
                    </button>
                    <button
                      onClick={() => onHide(entry.id)}
                      title="Hide from history"
                      className="mt-0.5 shrink-0 rounded p-0.5 text-zinc-700 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                      </svg>
                    </button>
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
