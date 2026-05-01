import { memo, useEffect, useMemo, useState } from 'react';
import type {
  AgentId,
  AgentInfo,
  AgentsConfig,
  ApiStyle,
  ProviderProfile,
  ProvidersConfig,
  ProviderKind,
} from '@tday/shared';
import { PROVIDER_PRESETS, presetForKind } from '@tday/shared';
import { ProviderLogo } from './ProviderLogo';

interface Props {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

type Section = 'providers' | 'agents';

export function Settings({ open, onClose, onSaved }: Props) {
  const [section, setSection] = useState<Section>('providers');
  const [cfg, setCfg] = useState<ProvidersConfig | null>(null);
  const [agents, setAgents] = useState<AgentInfo[]>([]);
  const [activeId, setActiveId] = useState<string>('');
  const [savedTick, setSavedTick] = useState(0);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [installPct, setInstallPct] = useState(0);
  const SHARED_KEY = 'tday:sharedAgentConfig';
  const [shared, setShared] = useState<boolean>(() => {
    try {
      return localStorage.getItem(SHARED_KEY) === '1';
    } catch {
      return false;
    }
  });

  const refresh = async () => {
    const [c, a] = await Promise.all([
      window.tday.listProviders() as Promise<ProvidersConfig>,
      window.tday.listAgents() as Promise<AgentInfo[]>,
    ]);
    setCfg(c);
    setAgents(a);
    setActiveId((cur) => cur || c.default || c.profiles[0]?.id || '');
  };

  // Preload eagerly on mount so data is ready before the user opens settings.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void refresh(); }, []);

  // Re-fetch when opened in case data changed externally.
  useEffect(() => {
    if (!open) return;
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

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
    const url = preset.baseUrls[style];
    // For providers that don't ship a canonical URL for this dialect, leave
    // the field empty so the user can fill in their own — we still allow the
    // toggle (req #3: every provider exposes both base_url options).
    updateProfile({
      apiStyle: style,
      baseUrl: url ?? '',
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
    try {
      localStorage.setItem(SHARED_KEY, next ? '1' : '0');
    } catch {
      // ignore
    }
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
        className="relative h-[600px] w-[840px] max-w-[96vw] overflow-hidden rounded-xl border border-zinc-800 bg-zinc-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex h-full flex-col text-zinc-100">
          <div className="flex items-center justify-between border-b border-zinc-800/60 px-5 py-3">
            <div className="flex items-center gap-1">
              <SectionTab active={section === 'providers'} onClick={() => setSection('providers')}>
                Providers
              </SectionTab>
              <SectionTab active={section === 'agents'} onClick={() => setSection('agents')}>
                Agents
              </SectionTab>
            </div>
            <div className="flex items-center gap-3">
              <span
                className="select-text rounded bg-zinc-800/60 px-2 py-0.5 font-mono text-[10px] text-zinc-400"
                title="Tday version"
              >
                v{__APP_VERSION__}
              </span>
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
              <div className="scroll-themed flex w-56 shrink-0 flex-col overflow-y-auto border-r border-zinc-800/60 p-2">
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
                <details open className="mt-2">
                  <summary className="cursor-pointer rounded-md px-2 py-2 text-xs text-fuchsia-300 hover:bg-zinc-900">
                    + Add provider
                  </summary>
                  <div className="mt-1 max-h-72 overflow-y-auto pl-1">
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
                      <input
                        className="input"
                        placeholder={
                          profilePreset.baseUrls[profile.apiStyle ?? 'openai'] ??
                          'https://api.example.com/v1'
                        }
                        value={profile.baseUrl ?? ''}
                        onChange={(e) => updateProfile({ baseUrl: e.target.value })}
                      />
                    </Field>
                    <Field label="Model">
                      <input
                        className="input"
                        list={`models-${profile.id}`}
                        placeholder={profilePreset.models[0] ?? 'model-id'}
                        value={profile.model ?? ''}
                        onChange={(e) => updateProfile({ model: e.target.value })}
                      />
                      {profilePreset.models.length > 0 ? (
                        <datalist id={`models-${profile.id}`}>
                          {profilePreset.models.map((m) => (
                            <option key={m} value={m} />
                          ))}
                        </datalist>
                      ) : null}
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
          ) : (
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
          )}
        </div>
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
