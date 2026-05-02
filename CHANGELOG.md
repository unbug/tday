# Changelog

All notable changes are documented here. Versions follow [semver](https://semver.org/).

---

## [0.4.17] — 2026-05-03

### Added
- **In-app update checker** — polls GitHub releases API 10 s after launch, then every 30 min; shows a green dot badge on the gear/settings button when a newer version is available
- **GitHub links in menu** — logo dropdown now has a "GitHub" entry (→ `github.com/unbug/tday`) and a version row (→ releases page) with a green dot indicator when an update is available
- `openExternal` IPC channel (main process validates `https://` prefix before calling `shell.openExternal`)

### Fixed
- History dropdown entries now show full date + time (`May 3, 2026, 02:15`) instead of relative "X ago" strings — applies to both the logo-menu history submenu and the Settings → History tab
- **Electron drag-region hover bug** — all absolute-positioned dropdown and submenu containers now carry `no-drag` so macOS/Windows titlebar drag logic no longer swallows mouse-enter events when the tab bar grows tall (many tabs wrap to multiple rows)
- History submenu: increased right-side padding bridge (`pr-1` → `pr-3`) and close delay (180 ms → 350 ms) so the cursor can reach the submenu without it disappearing
- History row in logo dropdown changed from `<div>` to `<button>` with always-present `hover:` classes, fixing the missing hover highlight
- Add provider section in Settings is now expanded by default (`<details open>`)

---

## [0.4.16] — 2026-05-02

### Added
- **Usage analytics dashboard** — full UI in Settings → Usage:
  - Left sidebar: period filter (Today / 7d / 30d / 90d / Custom date range), agent filter, refresh button
  - Right panel: 3-column summary cards (total tokens, total cost, session count), daily bar chart, by-model breakdown table, by-agent breakdown table
- **Settings → History tab** — dedicated history browser with agent sidebar, full-text search, time-based grouping (Today / This Week / This Month / Older), per-entry restore and hide actions

### Changed
- Settings dialog is now resizable via a drag handle
- Settings lazy-mounts on first open (avoids IPC calls at app startup); `startTransition` wraps `setSettingsOpen(true)` for low-priority rendering
- Non-critical startup work (tab history, agent history, keep-awake restore, logo hint) deferred with `requestIdleCallback`
- Provider list in Settings fills remaining height; "Add provider" section pinned at bottom

---

## [0.4.15] — 2026-05-01

### Added
- **Last-active tab restore** — the active tab ID is persisted to `~/.tday/settings.json` (`tday:activeTab`) and restored on restart; the active tab is sorted first in the DOM for priority PTY init

### Changed
- Tab title display: switched from middle-truncation with `…` to CSS `overflow-hidden` clip at `max-w-[160px]`; full title shown in `title` attribute on hover
- Removed `truncateMid` helper (no longer needed)

### Fixed
- Menu close delay increased to 500 ms; dropdown padding bridges widened to `pt-1` so the cursor gap between button and menu is easier to cross

---

## [0.4.14] — 2026-04-30

### Fixed
- **Double-SIGWINCH / claude-code session re-initialization bug** — when a tab became active, both the `active-tab useEffect` and the `ResizeObserver` sent a `pty:resize` IPC simultaneously. The second SIGWINCH arrived after the PTY spawned, causing Ink (claude-code's React renderer) to re-render its session header and appear to start a new session. Fix: removed `fit.fit()` + `window.tday.resize()` from the active-tab effect; the `ResizeObserver` exclusively handles all resize events including `display:none → block` transitions
- `ResizeObserver` callback now guards `containerRef.current.offsetWidth === 0` to skip resize sends when the container is hidden, preventing stale-dimension SIGWINCHes

---

## [0.4.13] — 2026-04-29

### Fixed
- **claude-code terminal width** — `FitAddon.fit()` was called before xterm.js had computed font metrics (canvas renderer needs one animation frame). Fix: `init()` now awaits one RAF before calling `fit.fit()` and capturing `cols`/`rows` for spawn. `COLUMNS` and `LINES` env vars set on the PTY environment as a fallback so claude-code/Ink reads the correct width even if the PTY window size IPC is delayed
- Post-spawn conditional resize only sends `pty:resize` IPC when `cols`/`rows` actually changed, avoiding an unnecessary SIGWINCH

---

## [0.4.12] — 2026-04-28

### Changed
- **Keep Awake** now uses `powerSaveBlocker.start('prevent-app-suspension')` only — no longer calls `pmset displaysleepnow`; prevents system suspension without forcing the display off or dimming the screen

### Fixed
- **Windows menu** — on win32, only the Logo image is hidden; the gear icon and the full dropdown menu remain visible and functional

---

## [0.4.11] — 2026-04-27

### Added
- Usage analytics backend: `usage/store.ts` (SQLite-backed append + query), `usage/pricing.ts` (per-model cost table for 30+ providers/models), IPC channels `usage:append` / `usage:query`

---

## [0.4.10] — 2026-04-26

### Added
- Local service discovery UI in Settings → Providers: Scan button, per-service latency badge, discovered-model chips, `discoveredModels` persistence in settings

### Fixed
- `probeBaseUrl` now tries `/models`, `/v1/models`, `/api/tags` in sequence for manual base-URL verification

---

## [0.4.9] — 2026-04-25

### Added
- Local service discovery probe system (`discovery/probe.ts`, `specs.ts`): TCP pre-filter + HTTP fingerprint for Ollama, LM Studio, vLLM, llama.cpp/LocalAI/Jan, SGLang; optional /24 LAN subnet sweep; configurable extra host list

---

## [0.4.1–0.4.8] — 2026-04-20 to 2026-04-24

### Added
- 9 agent adapters: pi, claude-code, codex, copilot, opencode, gemini, qwen-code, crush, hermes — each with install / update / uninstall via `npm i -g`
- Per-agent accent colors in tab bar
- **Logo / gear dropdown menu**: History submenu (last 12 sessions), Keep Awake toggle, Usage shortcut, Settings shortcut
- **Closed-tab history** with one-click restore; history persisted to `~/.tday/tab-history.db`
- **Agent-native session resume**: claude-code `--resume <id>`, codex `resume <id>`, opencode `--session <id>`; prior conversation replayed on restore
- **Agent history session manager** (`agent-history/`): background scanner reads native session files per agent, surfaces them in Settings → History
- Windows PATH augmentation for nvm-windows, volta, fnm so agent binaries installed via Node version managers are found
- Settings → Providers: full CRUD for provider profiles, 28-vendor preset library, dual base-URL selector (OpenAI-compatible / Anthropic-compatible), per-agent provider binding, per-agent model override
- **DeepSeek Anthropic gateway proxy** — in-process HTTP server translating OpenAI Responses API → Anthropic Messages API; streaming, extended thinking, tool use, multi-turn (113 unit tests, 12 modules)

---

## [0.3.13] — 2026-04-15

### Fixed
- pi scanner `cwd` reading corrected in `agent-history/scanners.ts`

---

## [0.3.12] — 2026-04-10

Baseline release. See README for full v0.1–v0.3 feature history.
