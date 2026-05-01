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
| **v0.4.0** 🔄 | Local-inference autodetect | TypeScript probe system (Ollama `/api/tags`, LM Studio `/v1/models`, vLLM, llama.cpp). Scan button + discovered-model chips in Settings. Usage analytics backend (SQLite-based pricing + store). mDNS & Rust scanner remaining. |
| **v0.5.0** | Token usage analytics | Dashboard UI — stacked-area charts, per-agent/provider/model breakdown. Cost estimation with live pricing table. Export CSV/JSON. Adapter `parseUsage()` hooks. |
| **v0.6.0** | MCP Management | MCP server registry in Settings (add/edit/remove, stdio & SSE transports). Auto-discover running local MCP processes. Per-agent MCP binding. Bundled quick-add servers: filesystem, memory, fetch, git. |
| **v0.7.0** | Browser & Computer Use | `browser-use` agent adapter (Python). Playwright MCP server quick-add. Anthropic computer-use mode toggle (bash / screenshot / text-editor tools). Screenshot side-panel in tab. |
| **v0.8.0** | Web Search & Web Tools | Search provider settings (Brave, Tavily, Jina, Perplexity). One-click MCP server install for each. Per-agent search-enable toggle. Web page reader / URL fetcher as shared tool. |
| **v0.9.0** | Skills & Custom Instructions | Per-agent, per-project skill files (`AGENTS.md`, `SKILL.md`, `.instructions.md`). Global skills library in Settings. Skill injection at spawn time. Skill marketplace (import from URL / GitHub). |
| **v0.10.0** | Cron & Automation | Scheduled agent runs (cron-expression editor in Settings). Trigger types: time, file-watch, webhook, git-event. Per-job log persistence + desktop notification on finish/fail. |
| **v0.11.0** | Unified long-term memory | SQLite + `sqlite-vec` embedding store. Background embed worker (Rust). MCP server `tday-memory` (`recall` / `remember` / `forget`). Per-project + global scopes. Memory browser + prune UI. |
| **v0.12.0** | Performance & polish | xterm WebGL renderer. Lazy-render inactive tabs. Session snapshot/restore. Memory budget warnings. Profiling page (CPU/RSS/handles). |
| **v0.13.0** | Plugins & extensibility | Adapter SDK (`AgentAdapter` public package). Third-party adapters via manifest URL. Custom themes. Plugin marketplace. |
| **v0.14.0** | Sync & teams | Optional E2EE sync of memory + usage across devices. Team dashboards. Shared provider pools. |
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

### v0.4.0 — Local-inference autodetect 🔄
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
- [x] Usage analytics backend
  - [x] `usage/store.ts` — SQLite-backed append + query
  - [x] `usage/pricing.ts` — per-model cost table for 30+ providers
  - [x] IPC channels `usage:append` / `usage:query`
  - [x] Usage tab skeleton in Settings
- [ ] Rust scanner (`tday-core`) — TCP probe + HTTP fingerprint in native binary
- [ ] mDNS/Bonjour discovery for LAN servers
- [ ] Toast notification “Found Ollama with N models — add as provider?”
- [ ] Background watch loop with exponential back-off

### v0.5.0 — Token usage analytics
- [ ] Dashboard UI: stacked-area chart (per-agent/provider/model over time)
- [ ] Per-tab usage mini-badge (tokens / estimated cost)
- [ ] Adapter `parseUsage()` hooks scraping token counts from agent output
- [ ] Live cost estimation using pricing table
- [ ] CSV / JSON export
- [ ] Budget alerts (configurable per-agent / global cap)

### v0.6.0 — MCP Management
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

### v0.7.0 — Browser & Computer Use
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

### v0.8.0 — Web Search & Web Tools
Give every agent instant access to the live web — configure search providers in Settings and inject them as MCP tools per agent.

- [ ] **Settings → Web Search** sub-panel
  - [ ] Provider cards: Brave Search, Tavily, Jina, Perplexity, SearXNG (self-hosted)
  - [ ] API key input per provider (stored in OS keychain)
  - [ ] Per-agent enable/disable toggle
- [ ] **One-click MCP install** for each provider’s official MCP server
- [ ] **Web page reader / URL fetcher** shared tool (via Jina Reader or `@modelcontextprotocol/server-fetch`)
- [ ] Show active search provider badge on tab header

### v0.9.0 — Skills & Custom Instructions
Define reusable instruction files that are automatically injected into agent sessions.

- [ ] **Skill file formats supported**: `AGENTS.md`, `SKILL.md`, `.instructions.md`, `CLAUDE.md`, `copilot-instructions.md`
- [ ] **Project-level auto-discovery**: scan project root + `.github/` on each PTY spawn
- [ ] **Global skills library** in Settings → Skills
  - [ ] Create / edit / delete named skills (Markdown editor)
  - [ ] Tag skills (language, framework, style, domain)
  - [ ] Enable/disable per agent-kind
- [ ] **Skill injection** at spawn time (`--system-prompt` / `--instructions` / temp context file)
- [ ] **Skill marketplace** — import from GitHub URL or gist

### v0.10.0 — Cron & Automation
Run agents on a schedule or in response to events — unattended coding tasks, nightly reviews, automated reports.

- [ ] **Settings → Automation** tab
  - [ ] Job list: name, agent, provider, cwd, prompt/task, schedule
  - [ ] Cron expression editor with human-readable preview
  - [ ] One-shot / interval / cron schedule types
- [ ] **Trigger types**: time (cron), file-watcher (`chokidar`), webhook (local HTTP), git hook
- [ ] **Job execution**: spawn PTY session (optionally headless / minimised tab)
- [ ] **Output persistence**: save full transcript per run to `~/.tday/runs/`
- [ ] **Notifications**: desktop notification on success/fail
- [ ] **Job history** panel: last N runs, exit code, duration, token cost

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

## 9. License

MIT License
