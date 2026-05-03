import { startTransition, useEffect, useState } from 'react';
import type { AgentId, AgentInfo } from '@tday/shared';
import { Terminal } from './Terminal';
import { Settings } from './Settings';
import { TabBar } from './components/TabBar';
import { LogoMenu } from './components/LogoMenu';
import { InstallOverlay } from './components/InstallOverlay';
import { CwdBar } from './components/CwdBar';
import { useUpdateCheck } from './hooks/useUpdateCheck';
import { useAgentInstall } from './hooks/useAgentInstall';
import { useKeepAwake } from './hooks/useKeepAwake';
import { useTabs } from './hooks/useTabs';
import { loadPersistedTabsFromRaw, LAST_CWD_KEY, TABS_STATE_KEY, ACTIVE_TAB_KEY, KEEP_AWAKE_KEY, LOGO_HINTED_KEY } from './types/tab';
import type { TdayApi } from '../../preload';

declare global {
  interface Window {
    tday: TdayApi;
  }
  // Injected by electron-vite at build time from apps/desktop/package.json.
  const __APP_VERSION__: string;
}

type SettingsSection = 'providers' | 'agents' | 'usage' | 'history' | 'cron';

export default function App() {
  const [home, setHome] = useState<string>('~');
  const [agentList, setAgentList] = useState<AgentInfo[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('usage');
  const [settingsMounted, setSettingsMounted] = useState(false);
  const [logoHintActive, setLogoHintActive] = useState(false);
  useEffect(() => { if (settingsOpen) setSettingsMounted(true); }, [settingsOpen]);

  const { hasUpdate } = useUpdateCheck();
  const { keepAwakeId, toggleKeepAwake, initKeepAwake } = useKeepAwake();
  const { installing, installPct, installStatus, installLog, refreshAgents, maybeAutoInstall } = useAgentInstall();

  const defaultAgentId: AgentId =
    (agentList.find((a) => a.isDefault)?.id as AgentId | undefined) ?? 'pi';

  const {
    tabs, activeId, setActiveId,
    tabHistory, agentHistory, agentHistoryLoading,
    dragId,
    closeTab, addTab, restoreFromAgentHistory, updateTabSessionId, removeFromAgentHistory,
    setTabDraft, commitTabCwd, browseTabCwd,
    onDragStart, onDragOver, onDrop, onDragEnd,
    setLastCwd, initTabs, loadDeferredData,
  } = useTabs(home, defaultAgentId);

  const openSettings = (section?: SettingsSection) => {
    startTransition(() => { if (section) setSettingsSection(section); setSettingsOpen(true); });
  };

  // ── Startup: load home, agents, settings in parallel ───────────────────────
  useEffect(() => {
    void (async () => {
      const [h, list, settings] = await Promise.all([
        window.tday.homeDir(),
        window.tday.listAgents() as Promise<AgentInfo[]>,
        window.tday.getAllSettings(),
      ]);
      setHome(h);
      setAgentList(list);

      const initialCwd =
        typeof settings[LAST_CWD_KEY] === 'string' ? (settings[LAST_CWD_KEY] as string) : h;
      setLastCwd(initialCwd);

      const def = (list.find((a) => a.isDefault)?.id as AgentId | undefined) ?? 'pi';
      const persisted = loadPersistedTabsFromRaw(settings[TABS_STATE_KEY]);
      const savedActiveId =
        typeof settings[ACTIVE_TAB_KEY] === 'string' ? (settings[ACTIVE_TAB_KEY] as string) : null;
      initTabs(persisted, savedActiveId, initialCwd, def);

      const logoHinted = !!settings[LOGO_HINTED_KEY];
      const keepAwake = settings[KEEP_AWAKE_KEY] === true;

      loadDeferredData(
        logoHinted,
        keepAwake,
        () => {
          setTimeout(() => {
            setLogoHintActive(true);
            setTimeout(() => setLogoHintActive(false), 3500);
          }, 800);
        },
        () => initKeepAwake(true),
      );

      maybeAutoInstall(h, list, setAgentList);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const activeTab = tabs.find((t) => t.id === activeId);

  return (
    <div className="relative flex h-full w-full flex-col bg-[#0a0a0f]">
      {/* Title / tab bar + logo menu */}
      {/* Logo/settings always top-right; border spans the full width of the container */}
      <div className="flex border-b border-zinc-800/60">
        <div className="flex-1">
          <TabBar
            tabs={tabs}
            activeId={activeId}
            dragId={dragId}
            platform={window.tday.platform}
            agentList={agentList}
            defaultAgentId={defaultAgentId}
            onSetActiveId={setActiveId}
            onCloseTab={closeTab}
            onAddTab={(agentId) => addTab(agentId)}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
            onOpenSettings={openSettings}
          />
        </div>
        <div className="self-start shrink-0 bg-[#0a0a0f] py-1.5 pr-4">
          <LogoMenu
            hasUpdate={hasUpdate}
            keepAwakeId={keepAwakeId}
            tabHistory={tabHistory}
            agentHistory={agentHistory}
            agentHistoryLoading={agentHistoryLoading}
            platform={window.tday.platform}
            forceOpen={logoHintActive}
            onToggleKeepAwake={toggleKeepAwake}
            onRestoreFromAgentHistory={restoreFromAgentHistory}
            onOpenSettings={openSettings}
          />
        </div>
      </div>

      {/* Install overlay */}
      {installing && (
        <InstallOverlay
          installPct={installPct}
          installStatus={installStatus}
          installLog={installLog}
        />
      )}

      <div className="relative flex flex-1 flex-col gap-2 p-3">
        {/* Per-tab CWD bar */}
        <CwdBar
          activeTab={activeTab}
          home={home}
          onSetTabDraft={setTabDraft}
          onCommitTabCwd={commitTabCwd}
          onBrowseTabCwd={browseTabCwd}
        />

        <div className="border-beam relative flex-1 overflow-hidden rounded-xl bg-black">
          <div className="absolute inset-[3px] overflow-hidden rounded-[10px] bg-black">
            {/* Render active tab first so its PTY spawn gets first IPC priority */}
            {[...tabs].sort((a) => (a.id === activeId ? -1 : 0)).map((t) => (
              <div
                key={t.id}
                className="h-full w-full"
                style={{ display: t.id === activeId ? 'block' : 'none' }}
              >
                <Terminal
                  key={`${t.id}:${t.epoch}`}
                  tabId={t.id}
                  agentId={t.agentId}
                  cwd={t.cwd}
                  active={t.id === activeId}
                  agentSessionId={t.agentSessionId}
                  initialPrompt={t.initialPrompt}
                  isCronJob={t.isCronJob}
                  onAgentSessionId={(id) => updateTabSessionId(t.id, id)}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {settingsMounted && (
        <Settings
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          initialSection={settingsSection}
          onSectionChange={setSettingsSection}
          home={home}
          onSaved={() => void refreshAgents(setAgentList)}
          agentHistory={agentHistory}
          agentHistoryLoading={agentHistoryLoading}
          onRestoreHistory={(entry) => {
            restoreFromAgentHistory(entry);
            setSettingsOpen(false);
          }}
          onHideHistory={(id) => {
            void window.tday.hideAgentHistory(id).then(() => removeFromAgentHistory(id));
          }}
        />
      )}
    </div>
  );
}
