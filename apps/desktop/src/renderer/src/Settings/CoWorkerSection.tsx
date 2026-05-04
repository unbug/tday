import { useState, useEffect, useCallback } from 'react';
import type { CoWorker } from '@tday/shared';
import { MiniMarkdown } from './shared';

export interface CoWorkerSectionProps {
  coworkers: CoWorker[];
  onCoworkersChange: (updated: CoWorker[]) => void;
}

type DraftKind = 'builtin' | 'online' | 'custom';
type CustomSource = 'text' | 'file' | 'url';

function timeAgo(ts: number | undefined): string {
  if (!ts) return 'never';
  const d = Date.now() - ts;
  if (d < 60_000) return 'just now';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  return `${Math.floor(d / 86_400_000)}d ago`;
}

export function CoWorkerSection({ coworkers, onCoworkersChange }: CoWorkerSectionProps) {
  const [selected, setSelected] = useState<CoWorker | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<Partial<CoWorker>>({});
  const [draftKind, setDraftKind] = useState<DraftKind>('custom');
  const [customSource, setCustomSource] = useState<CustomSource>('text');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [resetting, setResetting] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [refreshingRegistry, setRefreshingRegistry] = useState(false);
  const [previewFetching, setPreviewFetching] = useState(false);
  const [previewContent, setPreviewContent] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // Online browse mode
  const [onlineBrowsing, setOnlineBrowsing] = useState(true);
  const [onlineCategory, setOnlineCategory] = useState<string>('All');

  const builtins = coworkers.filter((c) => c.isBuiltIn ?? c.id.startsWith('builtin:'));
  const presetOnlineList = coworkers.filter((c) => c.isPreset && c.id.startsWith('online:'));
  const userOnlineList = coworkers.filter((c) => !c.isPreset && c.id.startsWith('online:'));
  const customList = coworkers.filter(
    (c) => !c.isBuiltIn && !c.id.startsWith('builtin:') && !c.id.startsWith('online:'),
  );

  // Derive ordered categories from presets
  const onlineCategories = ['All', ...Array.from(
    new Set(presetOnlineList.map((c) => c.category).filter(Boolean) as string[])
  )];

  const filteredOnlineCards = onlineCategory === 'All'
    ? presetOnlineList
    : presetOnlineList.filter((c) => c.category === onlineCategory);

  useEffect(() => {
    if (!selected && coworkers.length > 0 && !onlineBrowsing) setSelected(coworkers[0]);
  }, [coworkers, selected, onlineBrowsing]);

  useEffect(() => {
    if (selected && !editing) {
      const fresh = coworkers.find((c) => c.id === selected.id);
      if (fresh) setSelected(fresh);
    }
  }, [coworkers]); // eslint-disable-line react-hooks/exhaustive-deps

  const selectItem = (cw: CoWorker) => {
    setEditing(false);
    setSelected(cw);
    setOnlineBrowsing(false);
    setPreviewContent(null);
    setPreviewError(null);
  };

  const selectOnlineCategory = (cat: string) => {
    setOnlineCategory(cat);
    setOnlineBrowsing(true);
    setSelected(null);
    setEditing(false);
    setPreviewContent(null);
    setPreviewError(null);
  };

  const openNew = () => {
    setDraftKind('custom');
    setDraft({ emoji: '🤖', name: '', description: '', systemPrompt: '', url: '', promptFile: '' });
    setCustomSource('text');
    setSelected(null);
    setOnlineBrowsing(false);
    setEditing(true);
    setPreviewContent(null);
    setPreviewError(null);
  };

  const openEdit = (cw: CoWorker) => {
    const kind: DraftKind = (cw.isBuiltIn ?? cw.id.startsWith('builtin:'))
      ? 'builtin'
      : cw.id.startsWith('online:')
      ? 'online'
      : 'custom';
    setDraftKind(kind);
    setDraft({ ...cw });
    setSelected(cw);
    setEditing(true);
    setPreviewContent(null);
    setPreviewError(null);
    if (kind === 'custom') {
      setCustomSource(cw.url ? 'url' : cw.promptFile ? 'file' : 'text');
    }
  };

  const cancelEdit = () => {
    setEditing(false);
    setDraft({});
    setPreviewContent(null);
    setPreviewError(null);
    // Return to online browse for new items or when editing online CoWorkers
    if (!selected || draftKind === 'online') setOnlineBrowsing(true);
  };

  const fetchPreview = useCallback(async (url: string) => {
    if (!url.trim()) return;
    setPreviewFetching(true);
    setPreviewError(null);
    setPreviewContent(null);
    try {
      const content = await window.tday.fetchCoworkerUrl(url);
      setPreviewContent(content);
    } catch (e) {
      setPreviewError(e instanceof Error ? e.message : 'Fetch failed');
    } finally {
      setPreviewFetching(false);
    }
  }, []);

  const handleClone = useCallback(
    async (cw: CoWorker) => {
      const clone: CoWorker = {
        id: `custom:${Date.now()}`,
        name: `${cw.name} (copy)`,
        emoji: cw.emoji,
        description: cw.description,
        systemPrompt: cw.cachedContent ?? cw.systemPrompt,
        createdAt: Date.now(),
      };
      await window.tday.saveCoworker(clone);
      const fresh = await window.tday.listCoworkers();
      onCoworkersChange(fresh);
      setDraftKind('custom');
      setCustomSource('text');
      setDraft({ ...clone });
      setSelected(clone);
      setEditing(true);
    },
    [onCoworkersChange],
  );

  const handleSave = useCallback(async () => {
    if (!draft.name?.trim()) return;
    setSaving(true);
    try {
      let coworker: CoWorker;
      if (!draft.id && draftKind !== 'builtin') {
        // ── New form: use customSource to determine kind ──
        const base = {
          name: draft.name.trim(),
          emoji: draft.emoji?.trim() || (customSource === 'url' ? '🌐' : '🤖'),
          description: draft.description?.trim() ?? '',
          createdAt: Date.now(),
        };
        if (customSource === 'url') {
          const url = draft.url?.trim();
          coworker = { ...base, id: `online:${Date.now()}`, systemPrompt: '', url };
          await window.tday.saveCoworker(coworker);
          if (url) { try { await window.tday.refreshCoworkerCache(coworker.id); } catch { /* cache later */ } }
        } else if (customSource === 'file') {
          coworker = { ...base, id: `custom:${Date.now()}`, systemPrompt: '', promptFile: draft.promptFile?.trim() || undefined };
          await window.tday.saveCoworker(coworker);
        } else {
          coworker = { ...base, id: `custom:${Date.now()}`, systemPrompt: draft.systemPrompt?.trim() ?? '' };
          await window.tday.saveCoworker(coworker);
        }
      } else if (draftKind === 'online') {
        if (!draft.url?.trim()) return;
        coworker = {
          id: draft.id?.startsWith('online:') ? draft.id : `online:${Date.now()}`,
          name: draft.name.trim(),
          emoji: draft.emoji?.trim() || '🌐',
          description: draft.description?.trim() ?? '',
          systemPrompt: '',
          url: draft.url.trim(),
          createdAt: draft.createdAt ?? Date.now(),
        };
        await window.tday.saveCoworker(coworker);
        try { await window.tday.refreshCoworkerCache(coworker.id); } catch { /* cache later */ }
      } else if (draftKind === 'builtin') {
        coworker = {
          id: draft.id!,
          name: draft.name.trim(),
          emoji: draft.emoji?.trim() || '🤖',
          description: draft.description?.trim() ?? '',
          systemPrompt: draft.systemPrompt?.trim() ?? '',
          isBuiltIn: true,
          createdAt: draft.createdAt,
        };
        await window.tday.saveCoworker(coworker);
      } else {
        const id = draft.id ?? `custom:${Date.now()}`;
        const base = {
          id,
          name: draft.name.trim(),
          emoji: draft.emoji?.trim() || '🤖',
          description: draft.description?.trim() ?? '',
          createdAt: draft.createdAt ?? Date.now(),
        };
        if (customSource === 'file') {
          coworker = { ...base, systemPrompt: '', promptFile: draft.promptFile?.trim() || undefined };
        } else if (customSource === 'url') {
          coworker = { ...base, systemPrompt: '', url: draft.url?.trim() || undefined };
        } else {
          coworker = { ...base, systemPrompt: draft.systemPrompt?.trim() ?? '' };
        }
        await window.tday.saveCoworker(coworker);
        if (customSource === 'url' && coworker.url) {
          try { await window.tday.refreshCoworkerCache(coworker.id); } catch { /* cache later */ }
        }
      }
      const fresh = await window.tday.listCoworkers();
      onCoworkersChange(fresh);
      setSelected(fresh.find((c) => c.id === coworker.id) ?? coworker);
      setEditing(false);
      setDraft({});
    } finally {
      setSaving(false);
    }
  }, [draft, draftKind, customSource, onCoworkersChange]);

  const handleDelete = useCallback(
    async (id: string) => {
      setDeleting(id);
      try {
        await window.tday.deleteCoworker(id);
        const fresh = await window.tday.listCoworkers();
        onCoworkersChange(fresh);
        if (selected?.id === id) setSelected(fresh[0] ?? null);
      } finally {
        setDeleting(null);
      }
    },
    [selected, onCoworkersChange],
  );

  const handleReset = useCallback(
    async (id: string) => {
      setResetting(id);
      try {
        await window.tday.resetCoworker(id);
        const fresh = await window.tday.listCoworkers();
        onCoworkersChange(fresh);
      } finally {
        setResetting(null);
      }
    },
    [onCoworkersChange],
  );

  const handleRefreshCache = useCallback(
    async (id: string) => {
      setRefreshing(id);
      try {
        await window.tday.refreshCoworkerCache(id);
        const fresh = await window.tday.listCoworkers();
        onCoworkersChange(fresh);
        const updated = fresh.find((c) => c.id === id);
        if (updated) setSelected(updated);
      } finally {
        setRefreshing(null);
      }
    },
    [onCoworkersChange],
  );

  const handleRefreshRegistry = useCallback(async () => {
    setRefreshingRegistry(true);
    try {
      const fresh = await window.tday.refreshCoworkerRegistry();
      onCoworkersChange(fresh);
    } finally {
      setRefreshingRegistry(false);
    }
  }, [onCoworkersChange]);

  const isSaveDisabled =
    saving ||
    !draft.name?.trim() ||
    (!draft.id && draftKind !== 'builtin'
      // New form: validate based on active tab
      ? customSource === 'url' ? !draft.url?.trim()
        : customSource === 'file' ? !draft.promptFile?.trim()
        : !draft.systemPrompt?.trim()
      : draftKind === 'online'
      ? !draft.url?.trim()
      : draftKind === 'builtin'
      ? !draft.systemPrompt?.trim()
      : customSource === 'text'
      ? !draft.systemPrompt?.trim()
      : customSource === 'file'
      ? !draft.promptFile?.trim()
      : !draft.url?.trim());

  const viewCoworker = selected && !editing;
  const isViewOnline = viewCoworker && selected.id.startsWith('online:');
  const isViewBuiltin = viewCoworker && (selected.isBuiltIn ?? selected.id.startsWith('builtin:'));
  const isViewPresetOnline = viewCoworker && (selected.isPreset ?? false) && selected.id.startsWith('online:');

  // ── Sidebar item ────────────────────────────────────────────────────────────
  const SidebarItem = ({ cw }: { cw: CoWorker }) => (
    <button
      onClick={() => selectItem(cw)}
      className={`w-full rounded-md px-2 py-2 text-left transition-colors ${
        selected?.id === cw.id && !editing
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-400 hover:bg-zinc-900'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className="text-base leading-none">{cw.emoji}</span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-[11px] font-medium leading-tight">{cw.name}</p>
          {cw.hasUserOverride && (
            <span className="mt-0.5 inline-block rounded bg-amber-900/60 px-1 py-px text-[9px] font-medium text-amber-400">
              modified
            </span>
          )}
        </div>
      </div>
    </button>
  );

  const SectionLabel = ({ label }: { label: string }) => (
    <p className="mb-1 mt-3 px-2 text-[9px] font-semibold uppercase tracking-wider text-zinc-600 first:mt-1">
      {label}
    </p>
  );

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden text-xs">
      {/* ── Sidebar ── */}
      <div className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-zinc-800/60">
        <div className="scroll-themed flex-1 overflow-y-auto p-2">
          {/* Built-in */}
          <SectionLabel label="Built-in" />
          {builtins.map((cw) => <SidebarItem key={cw.id} cw={cw} />)}

          {/* Online — category filter (二级分类) */}
          <SectionLabel label="Online" />
          <div className="mb-1 flex flex-col gap-0.5">
            {onlineCategories.map((cat) => (
              <button
                key={cat}
                onClick={() => selectOnlineCategory(cat)}
                className={`flex items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors ${
                  onlineBrowsing && onlineCategory === cat && !editing
                    ? 'bg-zinc-800 text-zinc-100'
                    : 'text-zinc-400 hover:bg-zinc-900'
                }`}
              >
                <span className="text-[10px]">
                  {cat === 'All' ? '🌐'
                    : cat === 'Mental Models' ? '🧠'
                    : cat === 'Startup & Business' ? '🚀'
                    : cat === 'Coding & Engineering' ? '💻'
                    : cat === 'Writing & Content' ? '✍️'
                    : cat === 'Research & Analysis' ? '🔬'
                    : cat === 'Security & Privacy' ? '🛡️'
                    : cat === 'Productivity' ? '⚡'
                    : cat === 'Thinking Frameworks' ? '🧠'
                    : cat === 'Investment & Business' ? '💰'
                    : cat === 'AI & Engineering' ? '🤖'
                    : cat === 'Investment Analysis' ? '📈'
                    : '📁'}
                </span>
                <span className="truncate text-[11px]">{cat}</span>
                <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
                  {cat === 'All' ? presetOnlineList.length : presetOnlineList.filter((c) => c.category === cat).length}
                </span>
              </button>
            ))}
          </div>

          {/* User-added online coworkers */}
          {userOnlineList.length > 0 && (
            <>
              <p className="mb-1 mt-2 px-2 text-[9px] font-semibold uppercase tracking-wider text-zinc-700">My Online</p>
              {userOnlineList.map((cw) => <SidebarItem key={cw.id} cw={cw} />)}
            </>
          )}

          {/* Custom */}
          <SectionLabel label="Custom" />
          {customList.length === 0 && (
            <p className="px-2 py-1 text-[10px] text-zinc-700">No custom CoWorkers</p>
          )}
          {customList.map((cw) => <SidebarItem key={cw.id} cw={cw} />)}
        </div>
        <div className="shrink-0 border-t border-zinc-800/40 p-2">
          <button
            onClick={() => openNew()}
            className="w-full rounded-md px-2 py-1.5 text-left text-[10px] font-medium text-fuchsia-300 hover:bg-zinc-900"
          >
            + Add CoWorker
          </button>
        </div>
      </div>

      {/* ── Detail panel ── */}
      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">

        {/* ── Online browse mode: card grid ── */}
        {onlineBrowsing && !editing && (
          <div className="flex h-full flex-col overflow-hidden">
            <div className="flex shrink-0 items-center gap-2 border-b border-zinc-800 px-4 py-2.5">
              <span className="flex-1 text-[11px] font-semibold text-zinc-300">
                {onlineCategory === 'All' ? 'All Online CoWorkers' : onlineCategory}
                <span className="ml-2 text-[10px] font-normal text-zinc-600">
                  ({filteredOnlineCards.length})
                </span>
              </span>
              <button
                onClick={() => void handleRefreshRegistry()}
                disabled={refreshingRegistry}
                title="Re-fetch CoWorkers.md registry"
                className="flex items-center gap-1 rounded px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 disabled:opacity-40 transition-colors"
              >
                <svg
                  width="11" height="11" viewBox="0 0 11 11" fill="none"
                  className={refreshingRegistry ? 'animate-spin' : ''}
                >
                  <path d="M9.5 5.5A4 4 0 1 1 5.5 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round"/>
                  <path d="M5.5 1.5L7.5 3.5M5.5 1.5L7.5-.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                {refreshingRegistry ? 'Refreshing…' : 'Refresh'}
              </button>
              <a
                href="https://github.com/unbug/tday/blob/main/CoWorkers.md"
                target="_blank"
                rel="noreferrer"
                className="text-[10px] text-sky-500 hover:text-sky-400"
              >
                + Contribute
              </a>
            </div>
            <div className="scroll-themed flex-1 overflow-y-auto p-4">
              {/* Contribute hint */}
              <div className="mb-4 rounded-md border border-sky-900/40 bg-sky-950/20 px-3 py-2 text-[10px] text-sky-500/80">
                Community-curated CoWorkers from GitHub. Click a card to view & use it.{' '}
                <a
                  href="https://github.com/unbug/tday/blob/main/CoWorkers.md"
                  target="_blank"
                  rel="noreferrer"
                  className="underline hover:text-sky-400"
                >
                  Contribute your own →
                </a>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                {filteredOnlineCards.map((cw) => {
                  const isAdded = !!coworkers.find((c) => c.id === cw.id && !c.isPreset);
                  return (
                    <button
                      key={cw.id}
                      onClick={() => selectItem(cw)}
                      className="group flex flex-col rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-left transition-colors hover:border-zinc-700 hover:bg-zinc-900"
                    >
                      <div className="flex items-center gap-2">
                        <span className="text-xl leading-none">{cw.emoji}</span>
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-[11px] font-semibold text-zinc-100">{cw.name}</p>
                          {cw.category && (
                            <span className="text-[9px] text-zinc-600">{cw.category}</span>
                          )}
                        </div>
                        {isAdded && (
                          <span className="shrink-0 rounded bg-sky-900/50 px-1 py-px text-[9px] text-sky-400">added</span>
                        )}
                      </div>
                      {typeof cw.githubStars === 'number' && (
                        <p className="mt-1 flex items-center gap-0.5 text-[9px] text-zinc-500">
                          <span>★</span>
                          <span>{cw.githubStars >= 1000 ? `${(cw.githubStars / 1000).toFixed(1)}k` : cw.githubStars}</span>
                        </p>
                      )}
                      {cw.description && (
                        <p className="mt-2 line-clamp-2 text-[10px] leading-relaxed text-zinc-500">
                          {cw.description}
                        </p>
                      )}
                      {cw.url && (
                        <p className="mt-1.5 truncate font-mono text-[9px] text-zinc-700 group-hover:text-zinc-500" title={cw.url}>
                          {cw.url.replace('https://github.com/', 'github/')}
                        </p>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── View mode ── */}
        {viewCoworker && !onlineBrowsing && (
          <div className="flex h-full flex-col overflow-hidden">
            {/* Back button for online preset items */}
            {isViewPresetOnline && (
              <div className="shrink-0 border-b border-zinc-800/40 px-3 py-1.5">
                <button
                  onClick={() => selectOnlineCategory(selected.category ?? 'All')}
                  className="flex items-center gap-1 text-[10px] text-zinc-500 hover:text-zinc-300"
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
                    <path d="M6.5 2L3.5 5L6.5 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Back to Online
                </button>
              </div>
            )}

            <div className="flex items-start gap-3 border-b border-zinc-800 px-4 py-3">
              <span className="mt-0.5 shrink-0 text-2xl leading-none">{selected.emoji}</span>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <p className="text-sm font-semibold text-zinc-100">{selected.name}</p>
                  {isViewBuiltin && (
                    <span className="rounded bg-zinc-700 px-1.5 py-px text-[9px] font-medium text-zinc-400">preset</span>
                  )}
                  {isViewOnline && (
                    <span className="rounded bg-sky-900/50 px-1.5 py-px text-[9px] font-medium text-sky-400">online</span>
                  )}
                  {isViewPresetOnline && (
                    <span className="rounded bg-zinc-700 px-1.5 py-px text-[9px] font-medium text-zinc-400">preset</span>
                  )}
                  {selected.hasUserOverride && (
                    <span className="rounded bg-amber-900/60 px-1.5 py-px text-[9px] font-medium text-amber-400">modified</span>
                  )}
                  {typeof selected.githubStars === 'number' && (
                    <span className="flex items-center gap-0.5 rounded bg-zinc-800 px-1.5 py-px text-[9px] font-medium text-zinc-400">
                      <span>★</span>
                      <span>{selected.githubStars >= 1000 ? `${(selected.githubStars / 1000).toFixed(1)}k` : selected.githubStars}</span>
                    </span>
                  )}
                </div>
                {selected.description && (
                  <p className="mt-0.5 text-[11px] text-zinc-500">{selected.description}</p>
                )}
                {/* URL row for online */}
                {isViewOnline && selected.url && (
                  <p className="mt-1 truncate font-mono text-[9px] text-sky-600" title={selected.url}>
                    🔗 {selected.url}
                  </p>
                )}
                {isViewOnline && (
                  <p className="text-[9px] text-zinc-600">cached: {timeAgo(selected.cachedAt)}</p>
                )}
              </div>
              {/* Actions */}
              <div className="flex shrink-0 flex-wrap justify-end gap-1">
                <button
                  onClick={() => openEdit(selected)}
                  className="rounded px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 transition-colors"
                >
                  Edit
                </button>
                {/* Clone: only for builtin and custom */}
                {!isViewOnline && (
                  <button
                    onClick={() => void handleClone(selected)}
                    className="rounded px-2 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 transition-colors"
                  >
                    Clone
                  </button>
                )}
                {/* Refresh: only for online */}
                {isViewOnline && (
                  <button
                    onClick={() => void handleRefreshCache(selected.id)}
                    disabled={refreshing === selected.id}
                    className="rounded px-2 py-1 text-[10px] text-sky-400 hover:bg-sky-500/10 transition-colors disabled:opacity-40"
                  >
                    {refreshing === selected.id ? '…' : 'Refresh'}
                  </button>
                )}
                {/* Reset: builtin with override */}
                {selected.hasUserOverride && (
                  <button
                    onClick={() => void handleReset(selected.id)}
                    disabled={resetting === selected.id}
                    className="rounded px-2 py-1 text-[10px] text-amber-400 hover:bg-amber-500/10 transition-colors disabled:opacity-40"
                    title="Restore preset definition"
                  >
                    {resetting === selected.id ? '…' : 'Reset'}
                  </button>
                )}
                {/* Delete: non-builtin and non-preset-online only */}
                {!isViewBuiltin && !isViewPresetOnline && (
                  <button
                    onClick={() => void handleDelete(selected.id)}
                    disabled={deleting === selected.id}
                    className="rounded px-2 py-1 text-[10px] text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-40"
                  >
                    {deleting === selected.id ? '…' : 'Delete'}
                  </button>
                )}
              </div>
            </div>
            {/* Body */}
            <div className="flex-1 overflow-y-auto p-4">
              {/* Online: cached markdown */}
              {isViewOnline ? (
                selected.cachedContent ? (
                  <MiniMarkdown text={selected.cachedContent} className="text-[11px] leading-relaxed text-zinc-300" />
                ) : (
                  <p className="text-[11px] italic text-zinc-600">No cached content — click Refresh to fetch.</p>
                )
              ) : selected.url ? (
                /* Custom URL source */
                <>
                  <div className="mb-3 flex items-center gap-2">
                    <p
                      className="min-w-0 flex-1 truncate rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-[10px] text-zinc-400"
                      title={selected.url}
                    >
                      🔗 {selected.url}
                    </p>
                    <a
                      href={selected.url}
                      target="_blank"
                      rel="noreferrer"
                      className="shrink-0 rounded px-2 py-1 text-[10px] text-sky-400 hover:bg-sky-500/10 transition-colors"
                    >
                      Open ↗
                    </a>
                  </div>
                  {selected.cachedContent ? (
                    <MiniMarkdown text={selected.cachedContent} className="text-[11px] leading-relaxed text-zinc-300" />
                  ) : (
                    <p className="text-[10px] italic text-zinc-600">(fetched from URL at runtime)</p>
                  )}
                </>
              ) : selected.promptFile ? (
                /* Custom file source */
                <>
                  <div className="mb-3 flex items-center gap-2">
                    <p
                      className="min-w-0 flex-1 truncate rounded-md border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 font-mono text-[10px] text-zinc-400"
                      title={selected.promptFile}
                    >
                      📄 {selected.promptFile}
                    </p>
                    <button
                      onClick={() => void fetchPreview(selected.promptFile!)}
                      disabled={previewFetching}
                      className="shrink-0 rounded px-2 py-1 text-[10px] text-fuchsia-400 hover:bg-fuchsia-500/10 transition-colors disabled:opacity-40"
                    >
                      {previewFetching ? '…' : 'Preview'}
                    </button>
                  </div>
                  {previewError && (
                    <p className="mb-2 text-[10px] text-red-400">{previewError}</p>
                  )}
                  {previewContent ? (
                    <MiniMarkdown text={previewContent} className="text-[11px] leading-relaxed text-zinc-300" />
                  ) : !previewFetching && (
                    <p className="text-[10px] italic text-zinc-600">Click Preview to load file content.</p>
                  )}
                </>
              ) : (
                /* Inline text (builtin or custom-text) */
                <MiniMarkdown text={selected.systemPrompt || ''} className="text-[11px] leading-relaxed text-zinc-300" />
              )}
            </div>
          </div>
        )}

        {/* ── Edit / New mode ── */}
        {editing && (
          <div className="flex h-full flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-zinc-800 px-4 py-2.5">
              <span className="text-[11px] font-semibold text-zinc-300">
                {draft.id
                  ? `Edit: ${draft.name || '…'}`
                  : 'New CoWorker'}
              </span>
              <div className="flex gap-1.5">
                <button
                  onClick={cancelEdit}
                  className="rounded px-2.5 py-1 text-[10px] text-zinc-500 hover:bg-zinc-800 transition-colors"
                >
                  Cancel
                </button>
                <button
                  onClick={() => void handleSave()}
                  disabled={isSaveDisabled}
                  className="rounded bg-fuchsia-600 px-2.5 py-1 text-[10px] font-medium text-white hover:bg-fuchsia-500 disabled:opacity-40 transition-colors"
                >
                  {saving ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4 space-y-3">
              {/* Builtin override banner */}
              {draftKind === 'builtin' && (
                <div className="rounded-md border border-amber-800/50 bg-amber-950/30 px-3 py-2 text-[10px] text-amber-400">
                  Changes will be saved to <span className="font-mono">~/.tday/coworkers/</span> as a local override.
                  You can reset to the preset version at any time.
                </div>
              )}

              {/* Emoji + Name */}
              <div className="flex items-end gap-2">
                <div className="w-14">
                  <label className="mb-1 block text-[10px] text-zinc-500">Emoji</label>
                  <input
                    className="input w-full text-center"
                    value={draft.emoji ?? (draftKind === 'online' ? '🌐' : '🤖')}
                    onChange={(e) => setDraft((p) => ({ ...p, emoji: e.target.value }))}
                    maxLength={4}
                  />
                </div>
                <div className="flex-1">
                  <label className="mb-1 block text-[10px] text-zinc-500">Name *</label>
                  <input
                    className="input w-full"
                    placeholder={draftKind === 'online' ? 'e.g. Karpathy Guidelines' : 'e.g. QA Engineer'}
                    value={draft.name ?? ''}
                    onChange={(e) => setDraft((p) => ({ ...p, name: e.target.value }))}
                  />
                </div>
              </div>

              <div>
                <label className="mb-1 block text-[10px] text-zinc-500">Description</label>
                <input
                  className="input w-full"
                  placeholder="One-line summary shown in the picker"
                  value={draft.description ?? ''}
                  onChange={(e) => setDraft((p) => ({ ...p, description: e.target.value }))}
                />
              </div>

              {/* ── NEW CoWorker: radio-style source selector ── */}
              {!draft.id && draftKind !== 'builtin' && (
                <>
                  {/* Radio options */}
                  <div className="space-y-2">
                    {([
                      { src: 'url'  as CustomSource, label: '🔗 URL',         desc: 'Fetch from a GitHub / raw URL' },
                      { src: 'file' as CustomSource, label: '📄 File',        desc: 'Pick a local .md / .txt file' },
                      { src: 'text' as CustomSource, label: '✏️ Text prompt', desc: 'Write a system prompt inline' },
                    ]).map(({ src, label, desc }) => (
                      <label
                        key={src}
                        className={`flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 transition-colors ${
                          customSource === src
                            ? 'border-zinc-600 bg-zinc-800/60'
                            : 'border-zinc-800 hover:border-zinc-700 hover:bg-zinc-800/30'
                        }`}
                      >
                        <input
                          type="radio"
                          name="coworker-source"
                          className="mt-0.5 accent-fuchsia-500"
                          checked={customSource === src}
                          onChange={() => { setCustomSource(src); setPreviewContent(null); setPreviewError(null); }}
                        />
                        <div>
                          <div className="text-[11px] text-zinc-200">{label}</div>
                          <div className="text-[10px] text-zinc-500">{desc}</div>
                        </div>
                      </label>
                    ))}
                  </div>

                  {/* Active input */}
                  {customSource === 'url' && (
                    <div className="flex gap-1.5">
                      <input
                        className="input min-w-0 flex-1 font-mono text-[10px]"
                        placeholder="https://github.com/user/repo/blob/main/SKILL.md"
                        value={draft.url ?? ''}
                        onChange={(e) => {
                          setDraft((p) => ({ ...p, url: e.target.value || undefined }));
                          setPreviewContent(null);
                        }}
                      />
                      <button
                        onClick={() => void fetchPreview(draft.url ?? '')}
                        disabled={previewFetching || !draft.url?.trim()}
                        className="shrink-0 rounded border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 transition-colors disabled:opacity-40"
                      >
                        {previewFetching ? '…' : 'Preview'}
                      </button>
                    </div>
                  )}

                  {customSource === 'file' && (
                    <div className="space-y-1.5">
                      <div className="flex gap-1.5">
                        <input
                          className="input min-w-0 flex-1 font-mono text-[10px]"
                          placeholder="/path/to/PROMPT.md"
                          value={draft.promptFile ?? ''}
                          onChange={(e) => {
                            setDraft((p) => ({ ...p, promptFile: e.target.value || undefined }));
                            setPreviewContent(null);
                          }}
                        />
                        <button
                          onClick={async () => {
                            const path = await window.tday.pickFile({
                              filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }],
                            });
                            if (path) {
                              setDraft((p) => ({ ...p, promptFile: path }));
                              setPreviewContent(null);
                            }
                          }}
                          className="shrink-0 rounded border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 transition-colors"
                        >
                          Browse
                        </button>
                        <button
                          onClick={() => void fetchPreview(draft.promptFile ?? '')}
                          disabled={previewFetching || !draft.promptFile?.trim()}
                          className="shrink-0 rounded border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 transition-colors disabled:opacity-40"
                        >
                          {previewFetching ? '…' : 'Preview'}
                        </button>
                      </div>
                    </div>
                  )}

                  {customSource === 'text' && (
                    <textarea
                      className="input min-h-[180px] w-full resize-y font-mono text-[11px]"
                      placeholder={`# Role: My Specialist\n\nYou are a ...\n\n## Workflow\n1. ...`}
                      value={draft.systemPrompt ?? ''}
                      onChange={(e) => setDraft((p) => ({ ...p, systemPrompt: e.target.value }))}
                    />
                  )}

                  {/* Shared preview — no max-height, show full content */}
                  {previewError && <p className="text-[10px] text-red-400">{previewError}</p>}
                  {previewContent && (
                    <div className="rounded-md border border-zinc-700 bg-zinc-900 p-3">
                      <MiniMarkdown text={previewContent} className="text-[11px] leading-relaxed text-zinc-300" />
                    </div>
                  )}
                </>
              )}

              {/* ── EDIT Online: URL field ── */}
              {draft.id && draftKind === 'online' && (
                <>
                  <div className="rounded-md border border-sky-800/50 bg-sky-950/30 px-3 py-2 text-[10px] text-sky-400">
                    Content is auto-cached from the URL. You cannot edit it directly.
                  </div>
                  <div>
                    <label className="mb-1 block text-[10px] text-zinc-500">GitHub URL *</label>
                    <input
                      className="input w-full font-mono text-[10px]"
                      placeholder="https://github.com/user/repo/blob/main/CLAUDE.md"
                      value={draft.url ?? ''}
                      onChange={(e) => {
                        setDraft((p) => ({ ...p, url: e.target.value }));
                        setPreviewContent(null);
                      }}
                    />
                  </div>
                  {draft.url?.trim() && (
                    <div>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] text-zinc-500">Preview</span>
                        <button
                          onClick={() => void fetchPreview(draft.url ?? '')}
                          disabled={previewFetching}
                          className="text-[10px] text-sky-500 hover:text-sky-400 disabled:opacity-40"
                        >
                          {previewFetching ? 'Fetching…' : 'Fetch'}
                        </button>
                      </div>
                      {previewError && <p className="text-[10px] text-red-400">{previewError}</p>}
                      {previewContent && (
                        <div className="rounded-md border border-zinc-700 bg-zinc-900 p-3">
                          <MiniMarkdown text={previewContent} className="text-[11px] leading-relaxed text-zinc-300" />
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* ── EDIT Custom: source selector ── */}
              {draft.id && draftKind === 'custom' && (
                <>
                  <div>
                    <label className="mb-1.5 block text-[10px] text-zinc-500">Content Source</label>
                    <div className="flex gap-1">
                      {(['text', 'file', 'url'] as CustomSource[]).map((src) => (
                        <button
                          key={src}
                          onClick={() => { setCustomSource(src); setPreviewContent(null); setPreviewError(null); }}
                          className={`rounded px-2.5 py-1 text-[10px] transition-colors ${
                            customSource === src ? 'bg-zinc-700 text-zinc-100' : 'text-zinc-500 hover:bg-zinc-800'
                          }`}
                        >
                          {src === 'text' ? '✏️ Text' : src === 'file' ? '📄 File' : '🔗 URL'}
                        </button>
                      ))}
                    </div>
                  </div>
                  {customSource === 'text' && (
                    <div>
                      <label className="mb-1 block text-[10px] text-zinc-500">
                        System Prompt * <span className="text-zinc-600">(Markdown)</span>
                      </label>
                      <textarea
                        className="input min-h-[220px] w-full resize-y font-mono text-[11px]"
                        placeholder={`# Role: My Specialist\n\nYou are a ...\n\n## Workflow\n1. ...`}
                        value={draft.systemPrompt ?? ''}
                        onChange={(e) => setDraft((p) => ({ ...p, systemPrompt: e.target.value }))}
                      />
                    </div>
                  )}
                  {customSource === 'file' && (
                    <div>
                      <label className="mb-1 block text-[10px] text-zinc-500">Local File *</label>
                      <div className="flex gap-1.5">
                        <input
                          className="input min-w-0 flex-1 font-mono text-[10px]"
                          placeholder="Absolute path to a .md file…"
                          value={draft.promptFile ?? ''}
                          onChange={(e) => setDraft((p) => ({ ...p, promptFile: e.target.value || undefined }))}
                        />
                        <button
                          onClick={async () => {
                            const path = await window.tday.pickFile({
                              filters: [{ name: 'Markdown', extensions: ['md', 'txt'] }],
                            });
                            if (path) setDraft((p) => ({ ...p, promptFile: path }));
                          }}
                          className="shrink-0 rounded border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 transition-colors"
                        >
                          Browse
                        </button>
                      </div>
                    </div>
                  )}
                  {customSource === 'url' && (
                    <div>
                      <label className="mb-1 block text-[10px] text-zinc-500">URL *</label>
                      <div className="flex gap-1.5">
                        <input
                          className="input min-w-0 flex-1 font-mono text-[10px]"
                          placeholder="https://github.com/user/repo/blob/main/CLAUDE.md"
                          value={draft.url ?? ''}
                          onChange={(e) => {
                            setDraft((p) => ({ ...p, url: e.target.value || undefined }));
                            setPreviewContent(null);
                          }}
                        />
                        <button
                          onClick={() => void fetchPreview(draft.url ?? '')}
                          disabled={previewFetching || !draft.url?.trim()}
                          className="shrink-0 rounded border border-zinc-700 px-2.5 py-1 text-[10px] text-zinc-400 hover:bg-zinc-800 transition-colors disabled:opacity-40"
                        >
                          {previewFetching ? '…' : 'Preview'}
                        </button>
                      </div>
                      {previewError && <p className="mt-1 text-[10px] text-red-400">{previewError}</p>}
                      {previewContent && (
                        <div className="mt-2 rounded-md border border-zinc-700 bg-zinc-900 p-3">
                          <MiniMarkdown text={previewContent} className="text-[11px] leading-relaxed text-zinc-300" />
                        </div>
                      )}
                    </div>
                  )}
                </>
              )}

              {/* ── Builtin: systemPrompt editor ── */}
              {draftKind === 'builtin' && (
                <div>
                  <label className="mb-1 block text-[10px] text-zinc-500">
                    System Prompt * <span className="text-zinc-600">(Markdown)</span>
                  </label>
                  <textarea
                    className="input min-h-[220px] w-full resize-y font-mono text-[11px]"
                    value={draft.systemPrompt ?? ''}
                    onChange={(e) => setDraft((p) => ({ ...p, systemPrompt: e.target.value }))}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Empty state ── */}
        {!viewCoworker && !editing && !onlineBrowsing && (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center text-zinc-600">
            <span className="text-4xl">🤖</span>
            <p className="text-[11px]">Select a CoWorker to view, or create a new one.</p>
          </div>
        )}
      </div>
    </div>
  );
}

