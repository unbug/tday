import { useCallback, useMemo, useRef, useState } from 'react';
import type {
  ApiStyle,
  ProvidersConfig,
  ProviderProfile,
  ProviderKind,
} from '@tday/shared';
import { PROVIDER_PRESETS, presetForKind } from '@tday/shared';
import { ProviderLogo } from '../ProviderLogo';
import { Field, StyleToggle } from './shared';

type ProbeResult = {
  models: string[];
  latencyMs: number;
  ok: boolean;
  probing: boolean;
  error?: string;
};

export interface ProvidersSectionProps {
  cfg: ProvidersConfig | null;
  onCfgChange: (cfg: ProvidersConfig) => void;
  onSaved: () => void;
}

export function ProvidersSection({ cfg, onCfgChange, onSaved }: ProvidersSectionProps) {
  const [activeId, setActiveId] = useState<string>(() => cfg?.default ?? cfg?.profiles[0]?.id ?? '');
  const [savedTick, setSavedTick] = useState(0);
  const [probeState, setProbeState] = useState<Record<string, ProbeResult>>({});
  const probeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [newModelInput, setNewModelInput] = useState('');

  const profile = useMemo(
    () => cfg?.profiles.find((p) => p.id === activeId) ?? null,
    [cfg, activeId],
  );
  const profilePreset = profile ? presetForKind(profile.kind) : null;

  const updateProfile = (patch: Partial<ProviderProfile>) => {
    if (!cfg || !profile) return;
    onCfgChange({
      ...cfg,
      profiles: cfg.profiles.map((p) => (p.id === profile.id ? { ...p, ...patch } : p)),
    });
  };

  const saveProviders = (cfgToSave?: ProvidersConfig) => {
    const c = cfgToSave ?? cfg;
    if (!c) return;
    setSavedTick((t) => t + 1);
    void window.tday.saveProviders(c);
    onSaved();
  };

  const scheduleProbe = useCallback((id: string, url: string) => {
    if (probeTimer.current) clearTimeout(probeTimer.current);
    if (!url.trim()) return;
    probeTimer.current = setTimeout(() => {
      setProbeState((s) => ({ ...s, [id]: { models: [], latencyMs: 0, ok: false, probing: true } }));
      window.tday
        .probeUrl(url.trim())
        .then((result) => {
          setProbeState((s) => ({ ...s, [id]: { ...result, probing: false } }));
        })
        .catch(() => {
          setProbeState((s) => ({
            ...s,
            [id]: { models: [], latencyMs: 0, ok: false, probing: false, error: 'Failed' },
          }));
        });
    }, 800);
  }, []);

  const runDiscovery = async () => {
    if (!profile) return;
    const url = profile.baseUrl?.trim();
    if (!url) return;
    saveProviders();
    setProbeState((s) => ({
      ...s,
      [profile.id]: { models: [], latencyMs: 0, ok: false, probing: true },
    }));
    try {
      const result = await window.tday.probeUrl(url);
      setProbeState((s) => ({ ...s, [profile.id]: { ...result, probing: false } }));
      if (result.ok && result.models.length > 0) {
        const patch: Partial<ProviderProfile> = { discoveredModels: result.models };
        if (!profile.model) patch.model = result.models[0];
        updateProfile(patch);
        setTimeout(() => saveProviders(), 0);
      }
    } catch {
      setProbeState((s) => ({
        ...s,
        [profile.id]: { models: [], latencyMs: 0, ok: false, probing: false, error: 'Failed' },
      }));
    }
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
    onCfgChange({ ...cfg, default: cfg.default ?? id, profiles: [...cfg.profiles, next] });
    setActiveId(id);
  };

  const removeProfile = (id: string) => {
    if (!cfg) return;
    const profiles = cfg.profiles.filter((p) => p.id !== id);
    const def = cfg.default === id ? profiles[0]?.id : cfg.default;
    onCfgChange({ ...cfg, profiles, default: def });
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
    const allPresetUrls = Object.values(preset.baseUrls).map((u) => u?.replace(/\/$/, '') ?? '');
    const currentIsPreset =
      !profile.baseUrl || allPresetUrls.includes(profile.baseUrl.replace(/\/$/, ''));
    updateProfile({
      apiStyle: style,
      baseUrl: currentIsPreset ? (newPresetUrl ?? '') : profile.baseUrl ?? '',
    });
  };

  return (
    <div className="flex flex-1 overflow-hidden">
      {/* Left: profile list */}
      <div className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-zinc-800/60">
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

      {/* Right: profile editor */}
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
                          <span className="text-zinc-400">
                            {probeState[profile.id].models.length} model
                            {probeState[profile.id].models.length !== 1 ? 's' : ''} found
                          </span>
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
                const probedModels = probed?.models ?? [];
                const persistedModels = profile.discoveredModels ?? [];
                const baseModels = probedModels.length > 0 ? probedModels : persistedModels;
                const allModels = [
                  ...baseModels,
                  ...profilePreset.models.filter((m) => !baseModels.includes(m)),
                ];
                const extraModels = profile.extraModels ?? [];
                const addExtraModel = (m: string) => {
                  const val = m.trim();
                  if (!val || extraModels.includes(val)) return;
                  updateProfile({ extraModels: [...extraModels, val] });
                  setNewModelInput('');
                };
                const removeExtraModel = (m: string) => {
                  updateProfile({ extraModels: extraModels.filter((x) => x !== m) });
                };
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
                      {[...allModels, ...extraModels].map((m) => (
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
                    {/* Extra (user-added) models */}
                    <div className="mt-2 border-t border-zinc-800/50 pt-2">
                      <div className="mb-1 text-[10px] uppercase tracking-wider text-zinc-600">
                        Extra models
                      </div>
                      {extraModels.length > 0 ? (
                        <div className="mb-1.5 flex flex-wrap gap-1">
                          {extraModels.map((m) => (
                            <span
                              key={m}
                              className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                                profile.model === m
                                  ? 'bg-fuchsia-500/25 text-fuchsia-200'
                                  : 'bg-zinc-800 text-zinc-300'
                              }`}
                            >
                              <button
                                className="hover:text-white"
                                onClick={() => updateProfile({ model: m })}
                              >
                                {m}
                              </button>
                              <button
                                onClick={() => removeExtraModel(m)}
                                className="ml-0.5 text-zinc-500 hover:text-rose-400"
                                title="Remove"
                              >
                                ×
                              </button>
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="flex gap-1.5">
                        <input
                          className="input flex-1 text-[11px]"
                          placeholder="model-id e.g. deepseek-r1"
                          value={newModelInput}
                          onChange={(e) => setNewModelInput(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') { e.preventDefault(); addExtraModel(newModelInput); }
                          }}
                        />
                        <button
                          onClick={() => addExtraModel(newModelInput)}
                          disabled={!newModelInput.trim()}
                          className="shrink-0 rounded-md border border-zinc-700 px-2.5 py-1 text-[11px] text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                        >
                          Add
                        </button>
                      </div>
                    </div>
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
                  onChange={(e) => {
                    if (e.target.checked && cfg) {
                      onCfgChange({ ...cfg, default: profile.id });
                    }
                  }}
                />
                Use as default
              </label>
              <button
                onClick={() => saveProviders()}
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
  );
}
