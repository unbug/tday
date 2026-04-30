# Tday — The Ultimate Harness Agent Terminal Launcher

> One terminal launcher for every coding-agent harness — Claude Code, Codex, OpenCode, Pi, and more. Browser-style tabs, unified provider config, auto-detected local inference, long-term memory, and cross-agent token analytics.

[![status](https://img.shields.io/badge/status-alpha-orange)]() [![v0.1.12](https://img.shields.io/badge/release-v0.1.12-blue)]()

<p align="center">
  <a href="https://x.com/i/status/2049935301808935356">
    <img
      width="1200"
      height="800"
      alt="Tday Demo Video on X"
      src="https://github.com/user-attachments/assets/54e40ca6-f27b-46cb-b2c0-c2b71540486e"
    />
  </a>
</p>


---

## 1. Vision

Today, every coding-agent harness ships with its own CLI, its own provider config, its own memory format, and its own token accounting. Power users juggle Claude Code in one tab, Codex in another, OpenCode in a third — each a separate terminal, each re-keyed, each forgetful.

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
│  ├─ Agent Adapter Registry (pi, claude-code, codex, opencode, …)    │
│  ├─ Provider Service       (env-var injection + secret store)       │
│  ├─ IPC Bridge             (typed channels)                         │
│  └─ Spawns: tday-core (Rust)                                     │
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

### Agent adapter contract

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
| **v0.1.0** | _Walk_ — Pi end-to-end | Single-tab MVP. Spawn the `pi` agent in a PTY tab. Static provider config from a JSON file. Border-beam shell. |
| **v0.2.0** | Multi-agent, multi-tab | Adapters for Claude Code, Codex, OpenCode. Tab manager (open/close/reorder/duplicate). Per-tab cwd picker. |
| **v0.3.0** | Providers UI | Settings panel for cloud providers (DeepSeek, OpenRouter, Anthropic, OpenAI, Groq, Together, …). Secrets in OS keychain. Per-tab provider override. |
| **v0.4.0** | Local-inference autodetect | Rust scanner polls `localhost:11434` (Ollama), `:1234` (LM Studio), `:8080` (llama.cpp), `:8000` (vLLM). Auto-add discovered endpoints with their model lists. mDNS for LAN. |
| **v0.5.0** | Token usage analytics | Per-tab, per-agent, per-provider, per-model accounting. Cost estimation. Charts. Export CSV/JSON. |
| **v0.6.0** | Unified long-term memory | SQLite + `sqlite-vec`. Cross-agent recall via MCP-server bridge that every adapter can mount. Per-project scoping. |
| **v0.7.0** | Performance & polish | WebGL terminal renderer, lazy tab hydration, snapshot-based session restore, profiler, memory budgets. |
| **v0.8.0** | Plugins & extensibility | Adapter SDK, third-party adapters loadable from a manifest, custom themes. |
| **v0.9.0** | Sync & teams | Optional E2EE sync of memory + usage across devices. Team dashboards. |
| **v1.0.0** | GA | Auto-update, signed builds for macOS/Windows/Linux, full docs, telemetry opt-in. |

---

## 4. Detailed Task Breakdown

### v0.1.0 — Pi end-to-end (shipped)

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

### v0.2.0 — Multi-agent, multi-tab (shipped, ahead of schedule)
- [x] Adapters: `pi`, `claude-code`, `codex`, `opencode` (install / update / uninstall via `npm i -g`)
- [x] Tab bar with drag-reorder + multi-row wrap
- [x] Split new-tab button: default agent on click, dropdown picker for any installed harness
- [x] Configurable default agent in Settings → Agents
- [x] Per-tab cwd staging + commit (Enter / Apply ↵ / Browse), restart-on-commit, last-cwd persistence
- [x] **Persist open tabs across restart** (id, title, agent, cwd)
- [ ] Transcript snapshots (carry scrollback across restart)
- [ ] `Cmd+T` / `Cmd+Shift+T` keyboard shortcuts

### v0.3.0 — Providers UI (largely shipped)
- [x] CRUD UI for provider profiles (sidebar list + "+ Add provider" picker)
- [x] Built-in templates for 22 vendors (OpenClaw mirror): DeepSeek, OpenAI, Anthropic, Google Gemini, xAI, Groq, Mistral, Moonshot, Cerebras, Together, Fireworks, Z.AI, Qwen, Volcengine, MiniMax, StepFun, OpenRouter, Ollama, LM Studio, Vercel AI Gateway, LiteLLM, Custom
- [x] Dual base-URL selector (OpenAI-compatible vs Anthropic-compatible) for **every** provider
- [x] Latest-models dropdown per provider (freeform input still allowed)
- [x] Per-agent provider binding + per-agent model override (CLI flag projection — Codex / Claude / OpenCode honour Tday's model setting instead of falling back to their own config files)
- [x] "Use one provider/model for all agents" shared-config toggle
- [ ] Secrets via Rust `keyring` crate (currently plaintext `~/.tday/providers.json`)
- [ ] Per-tab provider override + "last-used" memory

### v0.4.0 — Local-inference autodetect
- [ ] Rust scanner: TCP probe + HTTP fingerprint
  - Ollama: `GET /api/tags`
  - LM Studio: `GET /v1/models` (port 1234)
  - llama.cpp: `GET /v1/models` (port 8080)
  - vLLM: `GET /v1/models` (port 8000)
- [ ] mDNS discovery for LAN servers
- [ ] Toast “Found Ollama with 7 models — add as provider?”
- [ ] Watch loop with backoff

### v0.5.0 — Token usage analytics
- [ ] SQLite schema: `usage(ts, tab_id, agent, provider, model, prompt_tok, completion_tok, cost_usd)`
- [ ] Adapter `parseUsage()` hooks
- [ ] Dashboard: stacked-area + table + filters
- [ ] CSV/JSON export

### v0.6.0 — Unified long-term memory
- [ ] `sqlite-vec` embedding store
- [ ] Embed-on-write background worker (Rust)
- [ ] MCP server `tday-memory` exposing `recall`, `remember`, `forget` to any agent
- [ ] Per-project + global scopes
- [ ] UI to browse, edit, prune memories

### v0.7.0 — Performance & polish
- [ ] xterm WebGL renderer; benchmark vs canvas
- [ ] Lazy-render inactive tabs
- [ ] Session snapshot/restore
- [ ] Memory budget per tab; warn on leak
- [ ] Profiling page (CPU/RSS/handles)

### v0.8.0+ — see Roadmap table

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
