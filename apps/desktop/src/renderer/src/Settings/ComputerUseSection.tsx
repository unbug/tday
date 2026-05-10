import { useCallback, useEffect, useState } from 'react';

/** Keep in sync with computer-use.ts */
const SETTING_KEY = 'tday:computerUseEnabled';
/** Keep in sync with computer-use.ts */
const COMPUTER_USE_AGENTS = ['claude-code', 'gemini', 'opencode', 'codex', 'pi'] as const;

type NavItem = 'overview' | 'capabilities' | 'permissions';

const NAV_ITEMS: { id: NavItem; label: string }[] = [
  { id: 'overview',     label: 'Overview' },
  { id: 'capabilities', label: 'Capabilities' },
  { id: 'permissions',  label: 'Permissions' },
];

type PermStatus = 'authorized' | 'denied' | 'not-determined' | 'restricted' | 'unknown';

interface PermState {
  accessibility: PermStatus;
  screenRecording: PermStatus;
}

function statusColor(s: PermStatus) {
  if (s === 'authorized') return 'text-emerald-400';
  if (s === 'denied' || s === 'restricted') return 'text-red-400';
  return 'text-amber-400';
}

function statusLabel(s: PermStatus) {
  if (s === 'authorized') return 'Granted';
  if (s === 'denied') return 'Denied';
  if (s === 'restricted') return 'Restricted';
  return 'Not granted';
}

export function ComputerUseSection() {
  const [enabled, setEnabled] = useState(false);
  const [loading, setLoading] = useState(true);
  const [activeNav, setActiveNav] = useState<NavItem>('overview');
  const isMac = window.tday.platform === 'darwin';

  const [perms, setPerms] = useState<PermState>({
    accessibility: 'unknown' as PermStatus,
    screenRecording: 'unknown' as PermStatus,
  });
  const [requesting, setRequesting] = useState<'accessibility' | 'screen' | null>(null);

  const refreshPerms = useCallback(() => {
    if (!isMac) return;
    void window.tday.checkPermissions().then((p) => {
      setPerms({
        accessibility: p.accessibility ? 'authorized' : 'denied',
        // Electron returns 'granted' for screen; normalise to 'authorized' for uniform display
        screenRecording: (p.screenRecording === 'granted' ? 'authorized' : p.screenRecording) as PermStatus,
      });
    });
  }, [isMac]);

  useEffect(() => {
    void window.tday.getAllSettings().then((s) => {
      setEnabled(Boolean(s[SETTING_KEY]));
      setLoading(false);
    });
    refreshPerms();
  }, [refreshPerms]);

  // Re-check permissions when user switches back to this tab (they may have granted in Settings)
  useEffect(() => {
    if (activeNav !== 'permissions') return;
    refreshPerms();
    const id = setInterval(refreshPerms, 2000);
    return () => clearInterval(id);
  }, [activeNav, refreshPerms]);

  async function handleRequest(kind: 'accessibility' | 'screen') {
    setRequesting(kind);
    try {
      await window.tday.requestPermission(kind);
    } finally {
      setRequesting(null);
      refreshPerms();
    }
  }

  function handleToggle(next: boolean) {
    setEnabled(next);
    void window.tday.setSetting(SETTING_KEY, next);
  }

  return (
    <div className="flex min-h-0 flex-1 overflow-hidden">
      {/* Left: nav */}
      <div className="flex w-56 shrink-0 flex-col overflow-hidden border-r border-zinc-800/60">
        {/* Enable toggle pinned at top */}
        <div className="shrink-0 border-b border-zinc-800/60 px-3 py-3">
          <div className="flex items-center justify-between gap-2">
            <div>
              <p className="text-xs font-medium text-zinc-200">Computer Use</p>
              <p className="mt-0.5 text-[10px] text-zinc-500">
                {enabled ? 'Enabled for agents' : 'Disabled — agents unaffected'}
              </p>
            </div>
            <button
              disabled={loading}
              onClick={() => handleToggle(!enabled)}
              className={[
                'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent',
                'transition-colors duration-200 ease-in-out focus:outline-none',
                enabled ? 'bg-blue-600' : 'bg-zinc-600',
                loading ? 'cursor-not-allowed opacity-50' : '',
              ].join(' ')}
              role="switch"
              aria-checked={enabled}
            >
              <span
                className={[
                  'pointer-events-none inline-block h-4 w-4 rounded-full bg-white shadow',
                  'transform transition duration-200 ease-in-out',
                  enabled ? 'translate-x-4' : 'translate-x-0',
                ].join(' ')}
              />
            </button>
          </div>
        </div>

        {/* Nav items */}
        <div className="scroll-themed flex-1 overflow-y-auto p-2">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              onClick={() => setActiveNav(item.id)}
              className={`flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-xs transition-colors ${
                activeNav === item.id
                  ? 'bg-zinc-800 text-zinc-100'
                  : 'text-zinc-400 hover:bg-zinc-900 hover:text-zinc-300'
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>

        {/* Experimental badge pinned at bottom */}
        <div className="shrink-0 border-t border-zinc-800/60 px-3 py-2">
          <span className="inline-flex items-center gap-1 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-amber-400">
            <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" className="shrink-0">
              <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
              <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
            Experimental
          </span>
        </div>
      </div>

      {/* Right: content */}
      <div className="scroll-themed flex-1 overflow-y-auto p-5 text-xs">
        {!enabled && (
          <div className="mb-4 rounded-md border border-zinc-700/50 bg-zinc-900/60 px-3 py-2 text-[11px] text-zinc-500">
            Computer Use is <strong className="text-zinc-400">disabled</strong>. Agents will not receive any additional tools until you enable it above.
          </div>
        )}

        {activeNav === 'overview' && (
          <div className="space-y-4">
            <div className="border-b border-zinc-800/40 pb-3">
              <h2 className="text-sm font-semibold text-zinc-100">Overview</h2>
              <p className="mt-1 leading-relaxed text-zinc-400">
                Computer Use grants agents the ability to see your screen and control your mouse &amp;
                keyboard via <span className="font-mono text-zinc-300">tday-nativecore</span> (injected
                as an MCP server at spawn time, removed on exit).
              </p>
              <p className="mt-2 leading-relaxed text-zinc-400">
                When disabled, no additional tools are injected and agents behave exactly as they do
                without this feature. The setting is <strong className="text-zinc-300">off by default</strong>.
              </p>
            </div>

            <div>
              <p className="mb-2 text-[10px] uppercase tracking-wider text-zinc-500">Supported agents</p>
              <div className="flex flex-wrap gap-2">
                {COMPUTER_USE_AGENTS.map((id) => (
                  <span
                    key={id}
                    className="inline-flex items-center rounded bg-zinc-800 px-2 py-0.5 text-[11px] font-medium text-zinc-300"
                  >
                    {id}
                  </span>
                ))}
              </div>
              <p className="mt-2 text-zinc-500">
                MCP injection is implemented for these agents. Each requires its own config-file adapter. Other agents are unaffected.
              </p>
            </div>
          </div>
        )}

        {activeNav === 'capabilities' && (
          <div className="space-y-5">
            <div className="border-b border-zinc-800/40 pb-3">
              <h2 className="text-sm font-semibold text-zinc-100">Capabilities</h2>
              <p className="mt-1 text-zinc-400">
                Tools provided by <span className="font-mono text-zinc-300">tday-nativecore</span> when
                Computer Use is enabled. Run <span className="font-mono text-zinc-300">probe_app</span> first
                to choose the right interaction approach.
              </p>
            </div>

            {([
              {
                group: 'Screen & Vision', color: 'bg-sky-500',
                tools: [
                  { name: 'take_screenshot', desc: 'Capture full screen or a specific window (by CGWindowID)' },
                  { name: 'find_text',        desc: 'Locate text on screen via AX tree or OCR — returns {x,y} of each match' },
                  { name: 'find_image',       desc: 'Template-match a sub-image using NCC (supports rotation, scale, mask)' },
                  { name: 'load_image',       desc: 'Load a file into the image cache for use as a find_image template' },
                  { name: 'element_at_point', desc: 'Return the AX element at given screen coordinates' },
                ],
              },
              {
                group: 'Mouse & Keyboard', color: 'bg-violet-500',
                tools: [
                  { name: 'click',             desc: 'Click at (x,y) — left/right/middle button, configurable click count' },
                  { name: 'double_click',      desc: 'Double-click at (x,y)' },
                  { name: 'right_click',       desc: 'Right-click at (x,y) to open context menus' },
                  { name: 'drag',              desc: 'Drag from one point to another (DnD, sliders, list reorder)' },
                  { name: 'move_mouse',        desc: 'Move cursor to (x,y); set drag=true to drag from current position' },
                  { name: 'scroll',            desc: 'Scroll at (x,y) — direction + wheel_times (preferred) or raw delta' },
                  { name: 'type_text',         desc: 'Type text; optionally click to focus, clear field, press Enter after' },
                  { name: 'press_key',         desc: 'Press a single key with optional modifier list' },
                  { name: 'shortcut',          desc: 'Keyboard shortcut — e.g. "command+c", "ctrl+shift+s", "return"' },
                  { name: 'get_cursor_position', desc: 'Return the current cursor position (x, y)' },
                ],
              },
              {
                group: 'App & Window Management', color: 'bg-emerald-500',
                tools: [
                  { name: 'list_apps',    desc: 'List all running applications' },
                  { name: 'list_windows', desc: 'List all on-screen windows with IDs and bounds' },
                  { name: 'get_displays', desc: 'List all connected displays and their resolutions' },
                  { name: 'launch_app',   desc: 'Open an application by name; optionally pass CLI args' },
                  { name: 'quit_app',     desc: 'Quit an application — force=true sends SIGKILL' },
                  { name: 'focus_window', desc: 'Bring a window to the foreground by window ID' },
                  { name: 'resize_window', desc: 'Move and/or resize the main window of a running application' },
                  { name: 'probe_app',    desc: 'Detect app kind: Native / Electron / Chrome — returns CDP debug port if available' },
                ],
              },
              {
                group: 'Accessibility (AX) — macOS native apps', color: 'bg-amber-500',
                tools: [
                  { name: 'take_ax_snapshot',  desc: 'Snapshot the full AX tree — returns {uid, role, name, value, children}' },
                  { name: 'ax_click',          desc: 'Click an AX element by uid from a previous snapshot' },
                  { name: 'ax_set_value',      desc: 'Set the value of a text field or slider by uid' },
                  { name: 'ax_select',         desc: 'Select / open a menu item, tab, or list row by uid' },
                  { name: 'ax_perform_action', desc: 'Run any AX action on an element (AXPress, AXIncrement, …)' },
                ],
              },
              {
                group: 'CDP — Chrome / Electron apps', color: 'bg-orange-500',
                tools: [
                  { name: 'cdp_connect',       desc: 'Connect to a Chrome DevTools endpoint (port from probe_app)' },
                  { name: 'cdp_find_elements', desc: 'Query elements by text — returns DOM nodes with uid values' },
                  { name: 'cdp_click',         desc: 'Click a DOM element by uid' },
                  { name: 'cdp_fill',          desc: 'Fill an input field by uid' },
                  { name: 'cdp_evaluate_script', desc: 'Execute arbitrary JavaScript in the page context' },
                ],
              },
              {
                group: 'System Utilities', color: 'bg-zinc-400',
                tools: [
                  { name: 'execute_command', desc: 'Run a shell command or AppleScript; returns stdout/stderr/exit_code' },
                  { name: 'clipboard',       desc: 'Get or set the macOS clipboard text content' },
                  { name: 'sys_process',     desc: 'List processes (filter by name) or kill by PID/name' },
                  { name: 'filesystem',      desc: 'Read, write, list, delete, copy, move, info, search files' },
                  { name: 'scrape',          desc: 'Fetch a URL via HTTP GET and return the response body as text' },
                  { name: 'sys_wait',        desc: 'Pause N seconds (max 300) — use after launching apps or triggering animations' },
                ],
              },
              {
                group: 'Android (via ADB)', color: 'bg-green-600',
                tools: [
                  { name: 'android_list_devices', desc: 'List connected Android devices via ADB' },
                  { name: 'android_connect',      desc: 'Connect to a device by serial, host, or port' },
                  { name: 'android_disconnect',   desc: 'Disconnect the active Android device' },
                  { name: 'android_screenshot',   desc: 'Capture a screenshot of the Android screen' },
                  { name: 'android_click',        desc: 'Tap at (x,y) on the Android screen' },
                  { name: 'android_swipe',        desc: 'Swipe between two points (supports duration_ms)' },
                  { name: 'android_type_text',    desc: 'Type text on the Android device' },
                  { name: 'android_press_key',    desc: 'Press an Android keycode' },
                  { name: 'android_find_text',    desc: 'Find text in the Android UI hierarchy (exact or fuzzy)' },
                  { name: 'android_list_apps',    desc: 'List installed applications on the device' },
                  { name: 'android_launch_app',   desc: 'Launch an app by package name and optional activity' },
                ],
              },
            ] as { group: string; color: string; tools: { name: string; desc: string }[] }[]).map(({ group, color, tools }) => (
              <div key={group}>
                <div className="mb-1.5 flex items-center gap-1.5">
                  <span className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color}`} />
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">{group}</p>
                </div>
                <div className="space-y-px">
                  {tools.map(({ name, desc }) => (
                    <div key={name} className="flex items-start gap-2 rounded border border-zinc-800/50 bg-zinc-900/40 px-2.5 py-1.5">
                      <span className="mt-0.5 shrink-0 font-mono text-[11px] text-zinc-300">{name}</span>
                      <span className="text-zinc-500"> — {desc}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}

        {activeNav === 'permissions' && (
          <div className="space-y-4">
            <div className="border-b border-zinc-800/40 pb-3">
              <h2 className="text-sm font-semibold text-zinc-100">Permissions</h2>
            </div>

            {/* macOS */}
            {isMac && (
              <div>
                <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">macOS</p>
                <div className="space-y-2">
                  {/* Screen Recording */}
                  <div className="rounded-md border border-zinc-700/50 bg-zinc-900/50 px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-zinc-200">Screen Recording</p>
                        <p className="mt-0.5 text-[10px] text-zinc-500">Unlocks <span className="font-mono">take_screenshot</span> — captures screen content</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className={`text-[10px] font-medium ${statusColor(perms.screenRecording)}`}>
                          {statusLabel(perms.screenRecording)}
                        </span>
                        <button
                          onClick={() => void handleRequest('screen')}
                          disabled={requesting === 'screen'}
                          className="rounded bg-zinc-700 px-2.5 py-1 text-[10px] font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
                        >
                          {requesting === 'screen' ? 'Requesting…' : perms.screenRecording === 'denied' ? 'Open Settings' : 'Grant'}
                        </button>
                      </div>
                    </div>
                    <p className="text-[10px] text-zinc-600 leading-relaxed">
                      Manual path: <span className="text-zinc-400">System Settings → Privacy &amp; Security → Screen Recording → enable Tday</span>
                    </p>
                  </div>
                  {/* Accessibility */}
                  <div className="rounded-md border border-zinc-700/50 bg-zinc-900/50 px-4 py-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <p className="text-[11px] font-semibold text-zinc-200">Accessibility</p>
                        <p className="mt-0.5 text-[10px] text-zinc-500">Unlocks AX tools — read and control native UI elements without screen capture</p>
                      </div>
                      <div className="flex shrink-0 items-center gap-2">
                        <span className={`text-[10px] font-medium ${statusColor(perms.accessibility)}`}>
                          {statusLabel(perms.accessibility)}
                        </span>
                        <button
                          onClick={() => void handleRequest('accessibility')}
                          disabled={requesting === 'accessibility'}
                          className="rounded bg-zinc-700 px-2.5 py-1 text-[10px] font-medium text-zinc-200 hover:bg-zinc-600 disabled:opacity-50"
                        >
                          {requesting === 'accessibility' ? 'Requesting…' : 'Grant'}
                        </button>
                      </div>
                    </div>
                    <p className="text-[10px] text-zinc-600 leading-relaxed">
                      Manual path: <span className="text-zinc-400">System Settings → Privacy &amp; Security → Accessibility → enable Tday</span>
                    </p>
                  </div>
                  <p className="text-[10px] text-zinc-600 pt-1">
                    Permission status refreshes every 2 s while this panel is open. Buttons can be clicked again at any time to re-trigger the system prompt.
                  </p>
                </div>
              </div>
            )}

            {/* Windows */}
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Windows</p>
              <div className="rounded-md border border-zinc-700/40 bg-zinc-900/40 px-4 py-3 space-y-2">
                <p className="text-[11px] font-semibold text-zinc-300">Screen Capture &amp; Input</p>
                <p className="text-zinc-400 leading-relaxed">
                  No extra permissions needed for most operations. If screen capture is blocked,
                  ensure the app is not sandboxed and Windows Defender / antivirus is not
                  intercepting <span className="font-mono text-zinc-300">tday-nativecore</span>.
                </p>
                <p className="text-zinc-400 leading-relaxed">
                  For Android device control, install{' '}
                  <span className="font-medium text-zinc-300">ADB (Android Platform Tools)</span>{' '}
                  and enable USB debugging on your device.
                </p>
              </div>
            </div>

            {/* Linux */}
            <div>
              <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-zinc-500">Linux</p>
              <div className="space-y-2">
                <div className="rounded-md border border-zinc-700/40 bg-zinc-900/40 px-4 py-3 space-y-2">
                  <p className="text-[11px] font-semibold text-zinc-300">X11 / Wayland</p>
                  <p className="text-zinc-400 leading-relaxed">
                    Screen capture and input injection require either an X11 session or a
                    Wayland compositor with xdg-desktop-portal. On some distros you may need
                    to install <span className="font-mono text-zinc-300">xdotool</span> or{' '}
                    <span className="font-mono text-zinc-300">ydotool</span> for input events.
                  </p>
                </div>
                <div className="rounded-md border border-zinc-700/40 bg-zinc-900/40 px-4 py-3 space-y-2">
                  <p className="text-[11px] font-semibold text-zinc-300">Android via ADB</p>
                  <p className="text-zinc-400 leading-relaxed">
                    Run{' '}
                    <span className="font-mono text-zinc-300">sudo usermod -aG plugdev $USER</span>{' '}
                    and add a udev rule for your device, or use ADB over TCP/IP.
                  </p>
                </div>
              </div>
            </div>

            <p className="text-zinc-500">
              These permissions are only needed when Computer Use is enabled. Disabling the feature
              does not require revoking permissions.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
