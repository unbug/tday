# Tday — The Ultimate Harness Agent Terminal Launcher

> One terminal launcher for every coding-agent harness — Claude Code, Codex, Copilot CLI, OpenCode, Pi, and more. Browser-style tabs, unified provider config, auto-detected local inference, long-term memory, and cross-agent token analytics.

[![latest](https://img.shields.io/badge/release-latest-blue)](https://github.com/unbug/tday/releases)

<p align="center">
  <a href="https://x.com/i/status/2049935301808935356">
    <img
      width="1200"
      height="800"
      alt="Tday Demo Video on X"
      src="https://github.com/user-attachments/assets/5d7ac6d9-cf0a-4eb3-b865-71ffbd11806b"
    />
  </a>
</p>

<p align="center">
  <img
    width="49%"
    alt="Tday Screenshot 1"
    src="https://github.com/user-attachments/assets/77499913-ef2b-40a0-a0d3-88b779e337a0"
  />
  <img
    width="49%"
    alt="Tday Screenshot 2"
    src="https://github.com/user-attachments/assets/1964db7f-2db3-4eed-92a7-65eb172d33ed"
  />
</p>

---
## Installation

Download the latest `.dmg` (macOS) or `.exe` (Windows) from [Releases](https://github.com/unbug/tday/releases).

### macOS — "unverified developer" warning

The distributed build is **not code-signed** with an Apple Developer certificate. macOS will block the app on first launch. To bypass:

```bash
xattr -rd com.apple.quarantine /Applications/Tday.app
```

Or: right-click the `.app` → **Open** → click **Open** in the dialog.

Or:

<img width="968" height="716" alt="Image" src="https://github.com/user-attachments/assets/116d2b64-23e6-4a35-8409-1310fe8ecfcd" />

### Windows — "Windows protected your PC" warning

The build is **not code-signed** with a Microsoft Authenticode certificate. Windows SmartScreen may show a warning. To bypass:

1. Click **More info** in the SmartScreen dialog.
2. Click **Run anyway**.

> **Prerequisites:** Tday requires **Node.js (LTS, >=20)** to install and run AI coding agents. Download it from [nodejs.org](https://nodejs.org/en/download). After installation, make sure `npm` is on your PATH by running `npm --version` in a new terminal — if it works, Tday will also find it.

> **PATH setup:** If you installed agents via `npm install -g <package>`, their `.cmd` wrapper scripts live in `%APPDATA%\npm`. The Tday installer does not modify your system PATH — the app detects this directory automatically at startup. If Tday can't find an agent, run:
> ```cmd
> npm install -g <agent-package>
> ```
> then restart Tday.

---

## 1. Vision

Today, every coding-agent harness ships with its own CLI, its own provider config, its own memory format, and its own token accounting. Power users juggle Claude Code in one tab, Codex in another, Copilot CLI in a third, OpenCode in a fourth — each a separate terminal, each re-keyed, each forgetful.

**Tday** is the missing meta-layer:

- **Open agents in tabs** the way you open URLs in a browser. `Cmd+T` for a new agent, drag-to-reorder, persistent sessions.
- **One provider config** (DeepSeek, OpenRouter, Anthropic, OpenAI, …) injected into whichever agent you launch.
- **Auto-discover local inference** servers (Ollama, LM Studio, llama.cpp, vLLM) on your LAN/loopback and surface them as first-class providers.
- **Unified long-term memory** shared across agents (with per-agent scoping when you want it).
- **Cross-agent token analytics** — finally know what each harness actually costs.
- **Buttery UX** with `border-beam` accents, native PTY performance, and a Rust core for the hot paths.

---

## 2. Architecture

```
┌──────────────────────── Tday Desktop App ────────────────────────┐
│                                                                     │
│  Renderer (React + Vite + TS)                                       │
│  ├─ Tab Manager (browser-style)                                     │
│  ├─ Terminal View (xterm.js + WebGL renderer)                       │
│  ├─ Agent Picker, Settings, Memory Browser, Usage Dashboard         │
│  └─ UI kit: Tailwind + shadcn/ui + border-beam (magicui)            │
│                          ▲                                          │
│                          │ IPC (typed, contextBridge)               │
│                          ▼                                          │
│  Main Process (Electron + Node)                                     │
│  ├─ Session Service       (one PTY per tab via node-pty)            │
│  ├─ Agent Adapter Registry (pi, claude-code, codex, copilot, opencode, …)    │
│  ├─ Provider Service       (env-var injection + secret store)       │
│  ├─ IPC Bridge             (typed channels)                         │
│  ├─ Gateway (local HTTP proxy: OpenAI Responses API → Anthropic)    │
│  │    ├─ bridge/  (input · tools · response · stream conversion)    │
│  │    ├─ anthropic/  (HTTP client + SSE parser)                     │
│  │    └─ deepseek/   (thinking encoder · per-session state cache)   │
│  └─ Spawns: tday-core (Rust)                                        │
│                          ▲                                          │
│                          │ JSON-RPC over stdio / Unix socket        │
│                          ▼                                          │
│  tday-core (Rust binary, single static executable)               │
│  ├─ Local-inference scanner (ollama/lmstudio/llama.cpp/vllm)        │
│  ├─ Token counter (tiktoken-rs / tokenizers)                        │
│  ├─ Memory store (SQLite + sqlite-vec for embeddings)               │
│  ├─ Usage logger (per-agent, per-provider, per-tab)                 │
│  └─ Config & secrets (keyring crate, OS keychain)                   │
│                                                                     │
└─────────────────────────────────────────────────────────────────────┘
```

### Why this split

| Concern | Where | Why |
|---|---|---|
| Window, tabs, UI | Electron + React | Mature, fast iteration, rich ecosystem. |
| PTY spawning | Electron main (node-pty) | Battle-tested, full TTY semantics, integrates cleanly with xterm.js. |
| Detection / tokenization / memory | Rust (`tday-core`) | CPU-bound, must not block UI. Static binary, easy to ship & cross-compile. |
| Provider secrets | OS keychain via Rust | Avoid plaintext in app data; cross-platform. |

### Gateway — OpenAI Responses API → Anthropic proxy

Some harnesses (e.g. Codex) only speak the **OpenAI Responses API**. Tday ships a lightweight in-process HTTP gateway that transparently translates those calls to the **Anthropic Messages API**, enabling DeepSeek and any other Anthropic-compatible provider to be used with every harness without patching the harness.

```
Harness (Codex)              Main Process
       │  POST /v1/responses      │
       │ ─────────────────────▶  │
       │                   bridge/input   (OpenAI Responses → Anthropic Messages)
       │                   bridge/tools   (tool / tool-choice conversion)
       │                   deepseek/      (thinking-block encode/decode, V4 mutations)
       │                   anthropic/     (HTTP POST + SSE stream from provider)
       │                   bridge/stream  (Anthropic SSE → OpenAI SSE events)
       │  SSE stream              │
       │ ◀─────────────────────  │
```

**Module map** (`apps/desktop/src/main/gateway/`):

| Module | Responsibility |
|---|---|
| `adapter.ts` | Express server, request dispatch, error handling |
| `types.ts` | Shared gateway interfaces (Request, Response, …) |
| `anthropic/types.ts` | Anthropic Messages API type definitions |
| `anthropic/client.ts` | HTTP client, SSE tokeniser |
| `openai/types.ts` | OpenAI Responses API type definitions |
| `bridge/input.ts` | Convert OpenAI input items → Anthropic messages array |
| `bridge/tools.ts` | Convert OpenAI tools → Anthropic ATool[], apply DeepSeek mutations |
| `bridge/response.ts` | Convert Anthropic non-streaming response → OpenAI output |
| `bridge/stream.ts` | Convert Anthropic SSE events → OpenAI Responses API SSE |
| `deepseek/thinking.ts` | Encode / decode extended thinking blocks (prefix-based) |
| `deepseek/state.ts` | Per-session LRU cache for (thinking, signature) pairs |



Every harness is a thin adapter:

```ts
interface AgentAdapter {
  id: string;                          // "pi" | "claude-code" | "codex" | "opencode"
  displayName: string;
  detect(): Promise<DetectResult>;     // is the binary on PATH? version?
  buildLaunch(ctx: LaunchContext): {   // how to start it in a PTY
    cmd: string;
    args: string[];
    env: Record<string, string>;       // provider keys, base URLs, etc.
    cwd: string;
  };
  parseUsage?(stream: string): UsageDelta | null; // optional: scrape token usage
}
```

### Tab = Session

A **Tab** owns one **Session** = one PTY process bound to one agent adapter, one provider profile, and one working directory. Tabs persist across app restarts (process state does not; transcript does).

---

## 3. Long-term Roadmap

| Version | Theme | Highlights |
|---|---|---|
| ~~**v0.1.0**~~ ✅ | _Walk_ — Pi end-to-end | Single-tab MVP. Spawn the `pi` agent in a PTY tab. Static provider config from a JSON file. Border-beam shell. |
| ~~**v0.2.0**~~ ✅ | Multi-agent, multi-tab | Adapters for Claude Code, Codex, Copilot CLI, OpenCode. Tab manager (open/close/reorder/duplicate). Per-tab cwd picker. |
| ~~**v0.3.0**~~ ✅ | Providers UI + Gateway | Settings panel for 28+ cloud/local providers. DeepSeek Anthropic gateway proxy (OpenAI Responses API → Anthropic). Per-agent model override. |
| ~~**v0.3.x**~~ ✅ | Multi-agent UI overhaul + Tab History | 9 agent adapters (Crush, Hermes, Qwen-Code added). Per-agent accent colors. Logo dropdown (History, Keep Awake, Usage, Settings). Closed-tab history with one-click restore. Agent-native session resume (claude-code `--resume`, codex `resume`, opencode `--session`). Conversation history replayed on restore. Windows PATH augmentation (nvm-windows, volta, fnm). |
| ~~**v0.4.x**~~ ✅ | Local-inference + UX Polish | Local service discovery (Ollama, LM Studio, vLLM, llama.cpp, SGLang). Usage analytics dashboard (SQLite store, 30+ model pricing, summary cards, daily chart, by-model/agent tables). Settings redesign: History tab, resizable dialog, lazy-mount. Tab title smart clip + hover tooltip, last-active restore on restart. In-app update checker with green-dot badge. claude-code width + double-SIGWINCH fix. Windows menu fix. Electron drag-region fix. |
| ~~**v0.5.x**~~ ✅ | Cron & Automation | **Settings → Cron** tab: job list with enable/clone/delete, ScheduleWidget (Interval / At time / Custom cron with datetime picker), human-readable schedule preview. Cron scheduler in main process (node-cron, persistent JSON store, per-job stats). `initialPrompt` delivered reliably at spawn time: CLI positional arg for codex / claude-code / opencode / gemini / qwen-code; bracketed-paste PTY write (XTerm `ESC[200~`) for pi / copilot / hermes / crush — works even when screen is locked. OpenCode `run` subcommand fix. Job dashboard with next-run countdown, run count, last-status. |
| **v0.6.0** 🔄 | Token usage analytics (extended) | Per-tab usage mini-badge. Adapter `parseUsage()` hooks. CSV/JSON export. Budget alerts. |
| **v0.7.0** | MCP Management | MCP server registry in Settings (add/edit/remove, stdio & SSE transports). Auto-discover running local MCP processes. Per-agent MCP binding. Bundled quick-add servers: filesystem, memory, fetch, git. |
| **v0.7.1** | Channels Management | Named I/O channels in Settings: pipe agent stdout to files, webhooks, or other agents. Fan-out (broadcast one agent's output to multiple sinks). Fan-in (merge streams from multiple agents into one tab). Channel editor with live preview. |
| **v0.7.2** | Custom Agents | `AgentAdapter` public package. Register third-party agents via manifest URL or local path. Agents tab shows community adapters with one-click install. Custom system-prompt per agent. |
| **v0.8.0** | Browser & Computer Use | `browser-use` agent adapter (Python). Playwright MCP server quick-add. Anthropic computer-use mode toggle (bash / screenshot / text-editor tools). Screenshot side-panel in tab. |
| **v0.9.0** | Web Search & Web Tools | Search provider settings (Brave, Tavily, Jina, Perplexity). One-click MCP server install for each. Per-agent search-enable toggle. Web page reader / URL fetcher as shared tool. |
| **v0.10.0** | Skills & Custom Instructions | Per-agent, per-project skill files (`AGENTS.md`, `SKILL.md`, `.instructions.md`). Global skills library in Settings. Skill injection at spawn time. Skill marketplace (import from URL / GitHub). |
| **v0.11.0** | Unified long-term memory | SQLite + `sqlite-vec` embedding store. Background embed worker (Rust). MCP server `tday-memory` (`recall` / `remember` / `forget`). Per-project + global scopes. Memory browser + prune UI. |
| **v0.12.0** | Performance & polish | xterm WebGL renderer. Lazy-render inactive tabs. Session snapshot/restore. Memory budget warnings. Profiling page (CPU/RSS/handles). |
| **v0.13.0** | Plugins & extensibility | Adapter SDK (`AgentAdapter` public package). Third-party adapters via manifest URL. Custom themes. Plugin marketplace. |
| **v0.14.0** | Sync & teams | Optional E2EE sync of memory + usage across devices. Team dashboards. Shared provider pools. |
| **v1.0.0** | GA | Auto-update (Squirrel), signed & notarised builds for macOS/Windows/Linux, full docs site, telemetry opt-in. |
| **v1.0.0** | GA | Auto-update (Squirrel), signed & notarised builds for macOS/Windows/Linux, full docs site, telemetry opt-in. |

---

## 4. Detailed Task Breakdown

### v0.1.0 — Pi end-to-end ✅

The acceptance criterion: **`npm run dev` opens a window with one tab running the `pi` agent in a real PTY; typing works, output streams, resizing works, closing the tab kills the process cleanly.**

- [x] Repo scaffold
  - [x] Decide stack & layout
  - [x] Write this README
- [x] **App skeleton** (`apps/desktop`)
  - [x] Electron main + preload + renderer in TypeScript
  - [x] Vite for renderer dev/build
  - [x] Tailwind + shadcn/ui base
  - [x] `border-beam` component (magicui-port) on app frame
- [x] **PTY + terminal**
  - [x] `node-pty` integration in main
  - [x] `xterm.js` in renderer with fit + web-links addons
  - [x] Bidirectional IPC: `pty:spawn`, `pty:write`, `pty:resize`, `pty:data`, `pty:exit`
- [x] **Tab shell** (multi-tab from the start)
  - [x] `Tab` and `Session` data model
  - [x] `Cmd+W` / close button kills the PTY
- [x] **Pi adapter** (`packages/adapters/pi`)
  - [x] `detect()` — `which pi` + `pi --version`
  - [x] `buildLaunch()` — reads provider profile, sets env, args
  - [x] Configurable binary path
- [x] **Provider profile (static JSON)**
  - [x] `~/.tday/providers.json` seeded on first launch
  - [x] Loaded at launch, injected via env
- [ ] **Rust core stub** (`crates/tday-core`)
  - [ ] `cargo new --bin`, prints version on `--version`
  - [ ] `tday-core detect` — JSON-RPC stub for v0.4.0
  - [ ] Wired into the Electron build so the binary ships next to the app
- [x] **DX**
  - [x] `pnpm dev` launches everything
  - [x] `pnpm build` produces signed-null `.dmg` + `.zip` for arm64 and x64
  - [ ] CI: lint + typecheck + `cargo check`

### v0.2.0 — Multi-agent, multi-tab ✅
- [x] Adapters: `pi`, `claude-code`, `codex`, `copilot`, `opencode` (install / update / uninstall via `npm i -g`)
- [x] Tab bar with drag-reorder + multi-row wrap
- [x] Split new-tab button: default agent on click, dropdown chevron picker for any installed harness
- [x] Configurable default agent in Settings → Agents
- [x] Per-tab cwd staging + commit (Enter / Apply ↵ / Browse), restart-on-commit, last-cwd persistence
- [x] **Persist open tabs across restart** (id, title, agent, cwd)
- [ ] Transcript snapshots (carry scrollback across restart)
- [ ] `Cmd+T` / `Cmd+Shift+T` keyboard shortcuts

### v0.3.0 — Providers UI + Gateway ✅
- [x] CRUD UI for provider profiles (sidebar list + "+ Add provider" picker, default-expanded)
- [x] Built-in templates for **28 vendors** (OpenClaw mirror): DeepSeek, OpenAI, Anthropic, Google Gemini, xAI, Groq, Mistral, Moonshot, Cerebras, Together, Fireworks, Z.AI, Qwen, Volcengine, MiniMax, StepFun, OpenRouter, NVIDIA NIM, Hugging Face, Perplexity, Amazon Bedrock, SGLang, vLLM, Ollama, LM Studio, Vercel AI Gateway, LiteLLM, Custom
- [x] Dual base-URL selector (OpenAI-compatible vs Anthropic-compatible) for **every** provider
- [x] Latest-models dropdown per provider (freeform input still allowed)
- [x] Per-agent provider binding + per-agent model override (CLI flag projection — Codex / Claude / OpenCode honour Tday's model setting)
- [x] "Use one provider/model for all agents" shared-config toggle
- [x] **DeepSeek Anthropic gateway proxy** — in-process HTTP server translating OpenAI Responses API → Anthropic Messages API; supports streaming, extended thinking, tool use, multi-turn (113 unit tests, 12 modules)
- [ ] Secrets via Rust `keyring` crate (currently plaintext `~/.tday/providers.json`)
- [ ] Per-tab provider override + "last-used" memory

### v0.4.0 — Local-inference autodetect + UX Polish ✅
- [x] TypeScript probe system (`discovery/probe.ts`, `specs.ts`, `index.ts`)
  - [x] TCP pre-filter then HTTP fingerprint for each service
  - [x] Ollama: `GET /api/tags` → `models[].name`
  - [x] LM Studio: `GET /v1/models` → `data[].id` (port 1234)
  - [x] vLLM: `GET /v1/models` (port 8000)
  - [x] llama.cpp / LocalAI / Jan: `GET /v1/models` (port 8080 / 8080 / 1337)
  - [x] SGLang: `GET /v1/models` (port 30000)
  - [x] LAN host probe: configurable extra hosts + optional /24 subnet sweep
- [x] `probeBaseUrl` for manual base-URL scan (tries `/models`, `/v1/models`, `/api/tags`)
- [x] IPC channel `discovery:probe-url` wired in main process
- [x] Settings UI: Scan button + latency badge + discovered-model chips + `discoveredModels` persistence
- [x] Usage analytics backend + **full dashboard UI**
  - [x] `usage/store.ts` — SQLite-backed append + query
  - [x] `usage/pricing.ts` — per-model cost table for 30+ providers
  - [x] IPC channels `usage:append` / `usage:query`
  - [x] Left sidebar (period filter: today/7d/30d/90d/custom, agent filter, refresh)
  - [x] Right panel: 3-column summary cards, daily bar chart, by-model table, by-agent table
- [x] **Settings redesign**
  - [x] History tab: agent sidebar, full-text search, time-based grouping, restore / hide entries
  - [x] Resizable dialog (drag handle)
  - [x] Lazy-mount (first open only) + `startTransition` for low-priority render
  - [x] Provider list fills remaining height; Add provider pinned at bottom, default expanded
- [x] **Tab UX**
  - [x] Tab title CSS-clip (`max-w`) with full title on hover tooltip
  - [x] Last-active tab persisted and restored on restart; active tab sorted first in DOM
- [x] **Terminal fixes**
  - [x] claude-code terminal width: RAF before spawn ensures font metrics; `COLUMNS`/`LINES` env vars as fallback
  - [x] Double-SIGWINCH bug fixed: removed duplicate resize from active-tab effect; `ResizeObserver` guard for hidden containers
- [x] **In-app update checker** — GitHub releases API after 10 s then every 30 min; green dot badge on gear button; GitHub + releases links in menu
- [x] **Platform / UX fixes**
  - [x] Windows: keep full menu, hide Logo only on win32
  - [x] All dropdowns marked `no-drag` to prevent Electron drag-region swallowing hover events
  - [x] Menu close delay 500 ms + padding bridge to keep submenus reachable
  - [x] Keep Awake uses `prevent-app-suspension` only (no screen-dim side-effect)
  - [x] History entries show full `year · month · day · HH:MM`
  - [x] `openExternal` IPC (https-only) for in-app browser links
- [ ] Rust scanner (`tday-core`) — TCP probe + HTTP fingerprint in native binary
- [ ] mDNS/Bonjour discovery for LAN servers
- [ ] Toast notification “Found Ollama with N models — add as provider?”
- [ ] Background watch loop with exponential back-off

### ~~v0.5.x — Cron & Automation~~ ✅
- [x] **Settings → Cron** tab — job list sidebar with enable toggle, edit, clone, delete
- [x] **ScheduleWidget** — three modes: Interval (every N min/hour/day), At time (H:M + Daily/Weekdays/Weekly/Monthly), Custom (datetime-local picker auto-fills expr + raw cron input)
- [x] Human-readable schedule preview (`Every weekday at 09:00  0 9 * * 1-5`)
- [x] **`cron.ts`** main-process scheduler — `node-cron`, persistent JSON store, per-job run stats (lastRunAt, nextRunAt, runCount, lastStatus)
- [x] **Job dashboard** — summary cards per job, next-run countdown, last-status badge, manual ▶ Run, Refresh
- [x] `initialPrompt` on `SpawnRequest` — prompt flows renderer → main without any renderer-side setTimeout
  - [x] CLI positional arg for `codex` / `claude-code` / `opencode run` / `gemini` / `qwen-code`
  - [x] Bracketed-paste PTY write (`ESC[200~…ESC[201~`) for `pi` / `copilot` / `crush` / `hermes` — works even when screen is locked
- [x] OpenCode `run` subcommand fix (positional was misinterpreted as project path)
- [x] Clone cron job (Copy of X, enabled:false, opens in editor)
- [x] Cron UI theme: `datetime-local` input uses `input-date` class (dark `color-scheme` + fuchsia calendar icon)

### v0.6.0 — Token usage analytics (extended)
- [x] Dashboard UI: summary cards, daily chart, by-model and by-agent breakdown
- [ ] Per-tab usage mini-badge (tokens / estimated cost)
- [ ] Adapter `parseUsage()` hooks scraping token counts from agent output
- [ ] Live cost estimation using pricing table
- [ ] CSV / JSON export
- [ ] Budget alerts (configurable per-agent / global cap)

### v0.7.0 — MCP Management
MCP (Model Context Protocol) lets agents use tools, access resources, and receive prompts from external servers. Tday becomes the central registry for all MCP connections — configure once, available everywhere.

- [ ] **Settings → MCP Servers** tab
  - [ ] Add / edit / remove MCP server entries (name, transport, command / URL, args, env)
  - [ ] Transport types: `stdio` (local process), `SSE` (remote HTTP), `streamable-http`
  - [ ] Per-server connection test + status badge
- [ ] **Auto-discovery** of running local MCP processes (scan well-known ports, inspect `mcp.json`)
- [ ] **Per-agent MCP binding** — choose which MCP servers each agent starts with
- [ ] **Bundled quick-add server cards** in Settings:
  - [ ] `@modelcontextprotocol/server-filesystem` — local file access
  - [ ] `@modelcontextprotocol/server-memory` — persistent key-value memory
  - [ ] `@modelcontextprotocol/server-fetch` — HTTP fetch / web page reader
  - [ ] `@modelcontextprotocol/server-git` — Git log / diff / blame
- [ ] Inject `--mcp-config <json>` into Claude Code / `opencode` / `gemini` at spawn time
- [ ] MCP server log viewer inside the app

### v0.7.1 — Channels Management
Named I/O channels let you wire agent outputs to external sinks or other agents — turning Tday into a lightweight multi-agent orchestrator.

- [ ] **Settings → Channels** tab
  - [ ] Create / edit / delete named channel definitions
  - [ ] Channel types: `file` (append to log), `webhook` (HTTP POST), `agent` (pipe to another tab)
  - [ ] Per-channel filter: regex / glob on stdout lines
  - [ ] Channel enable/disable toggle
- [ ] **Fan-out** — one agent’s output broadcast to multiple sinks simultaneously
- [ ] **Fan-in** — merge stdout from multiple agents/tabs into a single virtual tab
- [ ] **Live channel inspector** — real-time stream preview in a side panel
- [ ] Per-tab channel binding (drag-and-drop tab onto channel)
- [ ] Persist channel config to `~/.tday/channels.json`

### v0.7.2 — Custom Agents
Make `AgentAdapter` a public package so the community can ship their own agent integrations.

- [ ] Publish `@tday/adapter-sdk` (TypeScript types + test harness)
- [ ] Agent manifest format (`tday-adapter.json`): id, displayName, detect, launch, parseUsage
- [ ] **Settings → Agents** → “Community adapters” section
  - [ ] Install from npm package name
  - [ ] Install from local path / manifest URL
  - [ ] Update / remove installed community adapters
- [ ] Custom system-prompt per agent (injected before every session)
- [ ] Adapter sandbox: run with `--no-asar` + restricted IPC subset

### v0.8.0 — Browser & Computer Use
Bring browser-automation and computer-use capabilities into Tday as first-class citizens — configure them once, launch them like any other agent tab.

- [ ] **`browser-use` adapter** (`packages/adapters/browser-use`)
  - [ ] `detect()` — checks `uv`/`pip` + `browser-use` install
  - [ ] `buildLaunch()` — spawns `python -m browser_use` with task and provider env
  - [ ] Install/update via Settings → Agents (runs `pip install browser-use`)
  - [ ] Browser profile picker (default / incognito / custom profile path)
  - [ ] Headless vs headed toggle
- [ ] **Playwright MCP quick-add** — one-click add `@playwright/mcp` to MCP registry
- [ ] **Anthropic computer-use mode** toggle for Claude Code
  - [ ] Enables `bash`, `computer`, `text_editor` built-in tools
  - [ ] Settings toggle per agent-profile
  - [ ] Safety warning banner in UI
- [ ] **Screenshot side-panel** — display screenshots emitted by computer-use tools inline in the tab

### v0.9.0 — Web Search & Web Tools
Give every agent instant access to the live web — configure search providers in Settings and inject them as MCP tools per agent.

- [ ] **Settings → Web Search** sub-panel
  - [ ] Provider cards: Brave Search, Tavily, Jina, Perplexity, SearXNG (self-hosted)
  - [ ] API key input per provider (stored in OS keychain)
  - [ ] Per-agent enable/disable toggle
- [ ] **One-click MCP install** for each provider’s official MCP server
- [ ] **Web page reader / URL fetcher** shared tool (via Jina Reader or `@modelcontextprotocol/server-fetch`)
- [ ] Show active search provider badge on tab header

### v0.10.0 — Skills & Custom Instructions
Define reusable instruction files that are automatically injected into agent sessions.

- [ ] **Skill file formats supported**: `AGENTS.md`, `SKILL.md`, `.instructions.md`, `CLAUDE.md`, `copilot-instructions.md`
- [ ] **Project-level auto-discovery**: scan project root + `.github/` on each PTY spawn
- [ ] **Global skills library** in Settings → Skills
  - [ ] Create / edit / delete named skills (Markdown editor)
  - [ ] Tag skills (language, framework, style, domain)
  - [ ] Enable/disable per agent-kind
- [ ] **Skill injection** at spawn time (`--system-prompt` / `--instructions` / temp context file)
- [ ] **Skill marketplace** — import from GitHub URL or gist

### v0.11.0 — Unified long-term memory
- [ ] `sqlite-vec` embedding store (Rust)
- [ ] Background embed-on-write worker
- [ ] MCP server `tday-memory` exposing `recall`, `remember`, `forget`
- [ ] Per-project + global memory scopes
- [ ] Memory browser UI (search, edit, prune, export)

### v0.12.0 — Performance & polish
- [ ] xterm WebGL renderer; benchmark vs canvas
- [ ] Lazy-render inactive tabs
- [ ] Session snapshot/restore (carry scrollback across restart)
- [ ] Memory budget per tab; warn on leak
- [ ] Profiling page (CPU/RSS/handles)

### v0.13.0+ — see Roadmap table

---

## 5. Repository Layout

```
tday/
├── apps/
│   └── desktop/                  # Electron app (main + preload + renderer)
│       ├── src/main/             # main process
│       ├── src/preload/          # contextBridge
│       ├── src/renderer/         # React app
│       ├── electron.vite.config.ts
│       └── package.json
├── packages/
│   ├── shared/                   # shared types (IPC contracts, AgentAdapter, …)
│   ├── adapters/
│   │   ├── pi/                   # v0.1.0
│   │   ├── claude-code/          # v0.2.0
│   │   ├── codex/                # v0.2.0
│   │   └── opencode/             # v0.2.0
│   └── ui/                       # shared components (border-beam, …)
├── crates/
│   └── tday-core/             # Rust binary (detect, tokens, memory)
├── pnpm-workspace.yaml
├── package.json
└── README.md
```

---

## 6. Quickstart

```bash
# prerequisites
node -v        # ≥ 20
pnpm -v        # ≥ 9
rustc --version  # ≥ 1.78

# install + run
pnpm install
pnpm build:core      # builds tday-core (Rust)
pnpm dev             # launches the desktop app

# point Tday at your `pi` binary if it isn't on PATH
echo '{ "agents": { "pi": { "bin": "/absolute/path/to/pi" } } }' \
  > ~/.tday/agents.json
```

The first window opens with a single tab running `pi` inside a real PTY.

---

## 7. Build and Release

### Local build

```bash
# typecheck the workspace
pnpm -r typecheck

# build the desktop app
pnpm --filter @tday/desktop build

# create macOS packages locally (.dmg + .zip for x64 and arm64)
pnpm --filter @tday/desktop package:mac

# create Windows and Linux packages locally on their native hosts
pnpm --filter @tday/desktop package:win
pnpm --filter @tday/desktop package:linux
```

Local packaging writes artifacts to `apps/desktop/release/<version>/`.
Those generated files are ignored by git and are not meant to be committed.

### GitHub Actions

The repository ships with `.github/workflows/release.yml`.

- Push to `main`: builds macOS (`x64`, `arm64`), Windows (`x64`), and Linux (`x64`) packages on GitHub Actions and uploads them as workflow artifacts.
- Push a tag like `v0.1.12`: builds the same cross-platform artifacts and publishes them to a GitHub Release automatically.
- Run the workflow manually: builds artifacts on demand; if `publish` is enabled, it creates a draft GitHub Release.

The CI packaging step uses `electron-builder --publish never`, so the build pipeline uploads release assets to GitHub Releases only and does not push packaged binaries back to the repository.

### Recommended release flow

```bash
# 1. commit your code changes
git push origin main

# 2. create a version tag to trigger a GitHub Release
git tag v0.1.12
git push origin v0.1.12
```

---

## 8. Design principles

1. **Native where it matters.** PTY, tokenization, memory, scanners — all in Rust or `node-pty`. Electron is the chrome, never the bottleneck.
2. **Adapter-first.** Adding a new harness must be ≤ 100 LOC.
3. **Provider-agnostic.** No harness should be locked to a vendor; we own env injection.
4. **Local-first.** Everything works offline with Ollama/LM Studio/llama.cpp/vLLM.
5. **Don’t hide the terminal.** It’s a terminal. Keystrokes, escape codes, colors, mouse — all forwarded faithfully.

---
## 9. Supported Harness Agents

| Agent | Install | Notes |
|---|---|---|
| **Pi** (`pi`) | `npm i -g @mariozechner/pi-coding-agent` | |
| **Claude Code** (`claude-code`) | `npm i -g @anthropic-ai/claude-code` | Session resume via `--resume <uuid>`; conversation history from `~/.claude/projects/` replayed on restore |
| **Codex** (`codex`) | `npm i -g @openai/codex` | Session resume via `codex resume <uuid>`; conversation history from `~/.codex/sessions/` replayed on restore |
| **Copilot CLI** (`copilot`) | `npm i -g @github/copilot-cli` | |
| **OpenCode** (`opencode`) | `npm i -g opencode-ai` | Session resume via `--session <id>`; conversation history from SQLite `~/.local/share/opencode/` replayed on restore |
| **Gemini** (`gemini`) | `npm i -g @google/gemini-cli` | |
| **Qwen Code** (`qwen-code`) | `npm i -g qwen-code` | |
| **Crush** (`crush`) | `npm i -g crush-cli` | |
| **Hermes** (`hermes`) | install manually, ensure `hermes` is on PATH | |

---
## 10. Supported Model Providers

| Provider | API Style | Notes |
|---|---|---|
| **DeepSeek** | OpenAI · Anthropic | DeepSeek V4 Pro / V4 Flash (Apr 2026), DeepSeek V3.2 via in-process Anthropic gateway |
| **OpenAI** | OpenAI | GPT-5.5, GPT-5.5 Pro, GPT-5.4, GPT-5.4-mini, GPT-5.4-nano |
| **Anthropic** | Anthropic | Claude Opus 4.7, Claude Sonnet 4.6, Claude Sonnet 4.5, Claude Haiku 4.5 |
| **Google Gemini** | OpenAI | Gemini 2.5 Pro / Flash (stable); Gemini 3.1 Pro / 3 Flash (preview) |
| **xAI (Grok)** | OpenAI | Grok-4.3, Grok-4.20 (reasoning / non-reasoning) |
| **Groq** | OpenAI | Llama 4 Scout / Maverick, Llama 3.3-70B via Groq LPU |
| **Mistral** | OpenAI | Mistral Large 3, Codestral 2501, Mistral Small 3.1 |
| **Moonshot (Kimi)** | OpenAI · Anthropic | Kimi k2, Kimi-VL-A3B |
| **Cerebras** | OpenAI | Llama on Cerebras WSE |
| **Together AI** | OpenAI | 200+ open models |
| **Fireworks AI** | OpenAI | Fast open-model inference |
| **Z.AI** | OpenAI · Anthropic | GLM-4 series |
| **Qwen (Alibaba)** | OpenAI | Qwen3.6-Max-Preview, Qwen3.6-Plus, Qwen3-Coder-480B-A35B |
| **Volcengine (Doubao)** | OpenAI | Doubao-1.5-Pro, Doubao-Pro-32K |
| **MiniMax** | OpenAI | MiniMax-Text-01, MiniMax-M1 |
| **StepFun** | OpenAI | Step-3, Step-2-16K |
| **OpenRouter** | OpenAI | Unified gateway to 300+ models |
| **NVIDIA NIM** | OpenAI | Llama 4, Qwen3.6, Mistral on NVIDIA NIM |
| **Hugging Face** | OpenAI | Serverless inference API |
| **Perplexity** | OpenAI | Sonar Pro, Sonar Reasoning Pro |
| **Amazon Bedrock** | Anthropic | Claude, Llama, Mistral via Bedrock |
| **SGLang** | OpenAI | Self-hosted high-throughput server |
| **vLLM** | OpenAI | Self-hosted PagedAttention server |
| **Ollama** | OpenAI | Local models (auto-detected on LAN) |
| **LM Studio** | OpenAI | Local GUI inference server (auto-detected) |
| **Vercel AI Gateway** | OpenAI | Vercel-hosted unified gateway |
| **LiteLLM** | OpenAI | Self-hosted proxy for 100+ models |
| **Custom** | OpenAI · Anthropic | Any OpenAI-compatible or Anthropic-compatible endpoint |

> **Local-inference auto-discovery** — Tday scans `localhost` and your LAN for running Ollama, LM Studio, vLLM, llama.cpp, SGLang, and LocalAI instances and surfaces them as providers automatically (Settings → Scan).

---

## 11. Renderer Modularity Rules

The renderer follows **architectural constraints** enforced by ESLint (`eslint.config.mjs`) — the same philosophy as VS Code: prevent wrong structure from being possible, rather than capping line counts.

### Layer rules (enforced)

| Rule | What it prevents |
|---|---|
| Orchestrators (`Settings.tsx`, `App.tsx`) contain **no inline JSX UI logic** | State + prop wiring only; UI goes in Section/Widget files |
| `*-helpers.ts` / `hooks/` contain **no JSX** | Pure logic stays pure |
| `Settings/` sub-files import only from `@tday/shared`, `./types`, `./shared`, `./cron-helpers`, `./history-helpers`, or React — **never from `../../App`** | No upward coupling |
| New visually distinct panels get their own `*Section.tsx` — **never added inline** to an existing file | Forces isolation at creation time |
| Shared utilities used by 3+ components live in `shared.tsx` or a dedicated `*-helpers.ts` — **not copy-pasted** | Single source of truth |

> ESLint rules: `no-restricted-imports` (no upward coupling), `@typescript-eslint/no-explicit-any` (warn), `prefer-const`. The CI `typecheck` + `test` scripts must stay green before merging.

### Split triggers

Apply these rules when adding or editing code:

| Condition | Action |
|---|---|
| File approaches the line limit | Split: extract pure logic into `*-helpers.ts`, extract hook state into `hooks/use*.ts`, extract UI into a new `*Section.tsx` or `*Widget.tsx` |
| 3+ components share the same utility | Move it to `shared.tsx` or a dedicated `*-helpers.ts` |
| A hook exceeds ~100 lines | Extract sub-hooks |
| Business logic lands in an orchestrator (`Settings.tsx`, `App.tsx`) | Move it down to the owning Section or hook |
| A new visually distinct panel is added | It always gets its own `*Section.tsx` |

### Settings module map

```
src/renderer/src/
  Settings.tsx              ← orchestrator (~200 lines, state + props only)
  Settings/
    types.ts                ← Section / SchedMode / etc. — no JSX
    shared.tsx              ← MiniMarkdown, SectionTab, Field, StatCard, DailyBarChart
    cron-helpers.ts         ← parseCronSchedule, buildCronExpr, describeCronExpr
    history-helpers.ts      ← histTimeGroup, histRelative, etc.
    ProvidersSection.tsx    ← provider profiles, URL probe, model discovery
    AgentsSection.tsx       ← agent list, per-agent config, shared settings
    CronSection.tsx         ← cron job list + editor
    UsageSection.tsx        ← token analytics dashboard
    HistorySection.tsx      ← closed-tab history
    ScheduleWidget.tsx      ← interval / at-time / custom cron picker
    __tests__/
      cron-helpers.test.ts
      history-helpers.test.ts
```

---

## 12. License

MIT License
