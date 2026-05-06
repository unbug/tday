# tday-devtools — Architecture & Detailed Design

## 1. Overview

`tday-devtools` is a standalone **MCP (Model Context Protocol) server** binary bundled with the Tday desktop application. It communicates with AI agents via stdio JSON-RPC transport and exposes native desktop automation capabilities: screenshots, OCR, mouse/keyboard control, Accessibility tree manipulation, Chrome DevTools Protocol (CDP) browser control, and Android device control.

When the user enables **Computer Use** in Tday settings, the main process injects `tday-devtools` as an MCP server when an agent starts. The binary is destroyed when the agent exits and has no effect on anything else.

---

## 2. High-Level Architecture

```
+----------------------------------------------------------------+
|                        AI Agent Process                        |
|  (claude-code / gemini / opencode)                             |
|                                                                |
|   MCP Client --stdio JSON-RPC--> tday-devtools (this process) |
+----------------------------------------------------------------+
                                        |
                          +-------------v--------------+
                          |        main.rs             |
                          |  tokio async runtime       |
                          |  tracing -> stderr         |
                          +-------------+--------------+
                                        |
                          +-------------v--------------+
                          |      DevToolsServer        |  server.rs
                          |  implements ServerHandler  |
                          |  (rmcp crate)              |
                          |                            |
                          |  list_tools()              |
                          |  call_tool() -> dispatch() |
                          +-----------+----------------+
                                      |
             +------------------------+------------------------+
             |                        |                        |
   +---------v-------+    +----------v-------+    +----------v-------+
   |   handlers/     |    |   session/       |    |   platform/      |
   |  business logic |    |  shared state    |    |  OS API layer    |
   +-----------------+    +------------------+    +------------------+
             |                                              |
   +---------v-------+                          +----------v-------+
   |  find_image.rs  |                          |  platform/macos/ |
   |  NCC template   |                          |  +-- app.rs       |
   |  matching       |                          |  +-- ax.rs        |
   +-----------------+                          |  +-- display.rs   |
                                                |  +-- input.rs     |
   +---------------+                            |  +-- ocr.rs       |
   |   cdp/        |                            |  +-- screenshot.rs |
   |  CDP browser  |                            |  +-- window.rs    |
   |  control      |                            +------------------+
   +---------------+

   +---------------+
   |  android/     |
   |  ADB control  |
   +---------------+
```

---

## 3. Module Design

### 3.1 `main.rs` — Entry Point

- Initialises `tracing` subscriber writing to **stderr** (never stdout, which carries JSON-RPC)
- Constructs `DevToolsServer`, binds `rmcp::transport::stdio()`
- Listens for `SIGINT` for graceful shutdown

### 3.2 `server.rs` — MCP Server Core

**Responsibility:** Implement the `rmcp::ServerHandler` trait, hold all shared state, and route MCP tool calls to the appropriate handler.

**Shared state (`DevToolsServer`):**

| Field | Type | Purpose |
|-------|------|---------|
| `ss_cache` | `Arc<RwLock<ScreenshotCache>>` | LRU cache of recent screenshots for reuse by find_image |
| `img_cache` | `Arc<RwLock<ImageCache>>` | Loaded template image cache |
| `ax` | `Arc<AxSession>` | AX snapshot session; maintains element refs across calls |
| `android` | `Arc<RwLock<Option<AndroidDevice>>>` | Current ADB device connection (optional) |
| `app_client` | `Arc<RwLock<Option<AppProtocolClient>>>` | Electron/native app WebSocket client |
| `hover_tracker` | `Arc<RwLock<Option<HoverTracker>>>` | Background hover tracking task handle |
| `screen_rec` | `Arc<RwLock<Option<ScreenRecorder>>>` | Background screen recording task handle |
| `cdp_client` | `Arc<RwLock<Option<CdpClient>>>` | Chrome DevTools Protocol connection (feature=cdp) |

**Tool routing (`dispatch`):** Matches on the tool name string and dispatches to the corresponding handler function. Each handler returns `Result<Value>`; errors are uniformly wrapped as `{"error": "..."}`.

---

### 3.3 `handlers/` — Business Logic Layer

Each file corresponds to a category of tools. The uniform function signature is `async fn handle_xxx(params: Value, ...) -> Result<Value>`.

| File | Tools |
|------|-------|
| `screenshot.rs` | `take_screenshot`, `load_image`, `find_image` |
| `input.rs` | `click`, `double_click`, `right_click`, `drag`, `scroll`, `move_mouse`, `type_text`, `press_key`, `shortcut`, `get_cursor_position` |
| `navigation.rs` | `list_windows`, `list_apps`, `get_displays`, `focus_window`, `launch_app`, `quit_app`, `resize_window`, `find_text`, `element_at_point` |
| `ax.rs` | `take_ax_snapshot`, `ax_click`, `ax_set_value`, `ax_select`, `ax_perform_action` |
| `probe_app.rs` | `probe_app` (aggregated AX tree + window info snapshot) |
| `system.rs` | `wait`, `scrape`, `execute_command`, `clipboard`, `process`, `filesystem` |
| `tracking.rs` | `start_hover_tracking`, `stop_hover_tracking`, `start_recording`, `stop_recording` |
| `cdp.rs` | `cdp_connect`, `cdp_disconnect`, `cdp_screenshot`, `cdp_navigate`, `cdp_click`, `cdp_type`, `cdp_snapshot`, `cdp_element_at_point`, `cdp_run_script`, `cdp_list_pages` |
| `app_protocol.rs` | `app_connect`, `app_disconnect`, `app_get_info`, `app_get_tree`, `app_query`, `app_get_element`, `app_click`, `app_type`, `app_press_key`, `app_focus`, `app_screenshot`, `app_list_windows` |
| `android.rs` | `android_list_devices`, `android_connect`, `android_disconnect`, `android_screenshot`, `android_click`, `android_swipe`, `android_type_text`, `android_press_key`, `android_find_text`, `android_list_apps`, `android_launch_app`, `android_get_display_info`, `android_get_current_activity` |

---

### 3.4 `platform/` — OS API Layer

Abstracts native OS APIs with `cfg(target_os)` conditional compilation for cross-platform support.

#### `platform/types.rs` — Shared Data Types

| Type | Description |
|------|-------------|
| `Rect` | `{x, y, width, height}` coordinate rectangle |
| `WindowInfo` | id / name / owner / bounds / layer / is_on_screen |
| `AppInfo` | name / bundle_id / pid / is_active / is_hidden |
| `DisplayInfo` | id / bounds / backing_scale_factor / pixel_width / pixel_height |
| `Screenshot` | png_data / scale_factor / origin_x / origin_y / pixel_width / pixel_height |
| `AXNode` | role / title / value / bounds / uid / children (AX tree node) |
| `TextMatch` | text / bounds (OCR / AX text search result) |
| `AXRef` | Type alias for macOS `AXUIElementRef` |

#### `platform/macos/` — macOS Implementation

| File | Contents |
|------|---------|
| `app.rs` | `NSWorkspace` app listing, activation, launch, quit; Electron/Chrome Bundle ID detection |
| `ax.rs` | `AXUIElement` API: tree snapshots, text search, element hit-testing, AX action dispatch (press/set_value/select); AXRaise window elevation |
| `display.rs` | `CGDisplay`: multi-monitor info, backing scale factor |
| `input.rs` | `CGEvent`: mouse click/drag/scroll/move; keyboard key/shortcut; `enigo` type_text; cursor position query |
| `ocr.rs` | macOS Vision framework (`VNRecognizeTextRequest`): image OCR returning text + bounding boxes |
| `screenshot.rs` | `screencapture` CLI: fullscreen / region / window capture to PNG; `CGWindowListCreateImage` window capture |
| `window.rs` | `CGWindowListCopyWindowInfo`: window list, lookup by ID or name, `CGWindowID` direct targeting |

---

### 3.5 `session/` — Shared State Layer

Session state shared across tool calls via `Arc`.

| File | Responsibility |
|------|---------------|
| `ax_session.rs` | **AxSession**: stores the latest AX snapshot's `{n -> AXRef}` map. UID format `a<N>g<gen>` — generation increments on each `take_ax_snapshot`, automatically invalidating old UIDs to prevent use-after-free on stale `AXUIElementRef` (raw C pointers) |
| `screenshot_cache.rs` | **ScreenshotCache**: LRU cache of up to 10 screenshots, each annotated with `ScreenshotMeta` (origin/scale). Reused by `find_image` to avoid redundant captures |
| `image_cache.rs` | **ImageCache**: template images loaded by `load_image` (keyed by URL/path), reused across multiple `find_image` calls |

---

### 3.6 `find_image.rs` — Template Matching

**Normalised Cross-Correlation (NCC)**-based image search supporting:

- Multi-scale search (`scale_range`: min / max / step)
- 0 / 90 / 180 / 270 degree rotation
- Optional SIMD acceleration (feature `find_image_simd`, uses `wide` crate)
- Optional parallel search (feature `find_image_parallel`, uses `rayon`)
- **Non-Maximum Suppression (NMS)** to remove overlapping results
- Output: `Vec<MatchResult>`, each containing `score / bbox / rotation / scale`

---

### 3.7 `cdp/` — Chrome DevTools Protocol

Connects to a running Chrome/Electron process (`--remote-debugging-port`) via the `chromiumoxide` crate.

- `mod.rs`: `CdpClient` struct holding `Browser` + `Page` handles
- `dom_discovery.rs`: structured DOM tree collection script (injected JS to gather interactable elements)
- `tools/`: per-tool implementations (element_at_point, input, pages, script)

---

### 3.8 `android/` — Android ADB Control

Connects to Android devices via the `adb-client` crate.

- `device.rs`: `AndroidDevice` (shell / shell_bytes / framebuffer_png)
- `navigation.rs`: app listing, current Activity, text search (OCR stub)
- `screenshot.rs`: framebuffer capture to PNG
- Others: tap / swipe / type / keyevent

---

### 3.9 `app_protocol/` — Electron/Native App WebSocket Protocol

Custom WebSocket protocol connecting to Tday's own Electron renderer process for precise UI tree queries and manipulation — bypassing AX and operating at the DOM/JS layer directly.

---

### 3.10 `tracking/` — Background Task Handles

- `hover_tracker.rs`: polls mouse position in the background, records hovered element info; used by `start/stop_hover_tracking` tools
- `screen_recorder.rs`: loops screenshots in the background, caches frame sequences; used by `start/stop_recording` tools

---

### 3.11 `error.rs` — Unified Error Type

`DevToolsError` enum covers all error categories: Screenshot / Ocr / Input / WindowNotFound / AppNotFound / Accessibility / Image / Io / Other. All errors are converted to `{"error": "..."}` JSON before returning to the agent.

---

## 4. Full Tool List (70+)

### Screenshot & Image

| Tool | Description |
|------|-------------|
| `take_screenshot` | Full-screen / window / region capture; returns base64 PNG + coordinate metadata |
| `load_image` | Load image from URL or file path into cache |
| `find_image` | Find a template image in a screenshot using NCC; returns list of coordinates |

### Mouse & Keyboard Input

| Tool | Description |
|------|-------------|
| `click` | Left-click; supports x/y focus-and-click, click_count, modifier keys |
| `double_click` | Double-click |
| `right_click` | Right-click |
| `drag` | Drag from (x1,y1) to (x2,y2) |
| `scroll` | Scroll with direction (up/down/left/right) + wheel_times |
| `move_mouse` | Move mouse; drag=true holds the button down |
| `type_text` | Type text; supports focus-click, clear, caret_position, press_enter |
| `press_key` | Press a single key (key name or keyCode) |
| `shortcut` | Send a key combination (e.g. `cmd+c`) |
| `get_cursor_position` | Get current mouse coordinates |

### Window & App Navigation

| Tool | Description |
|------|-------------|
| `list_windows` | List all windows (filterable by app) |
| `list_apps` | List all running applications |
| `get_displays` | Get all monitor information |
| `focus_window` | Focus and raise a specific window |
| `launch_app` | Launch an application |
| `quit_app` | Quit an application (normal or force) |
| `resize_window` | Resize and reposition a window |
| `find_text` | Find text on screen via OCR; returns coordinates |
| `element_at_point` | Get AX element info at a screen coordinate |

### Accessibility Tree

| Tool | Description |
|------|-------------|
| `take_ax_snapshot` | Capture an application's AX tree; returns a tree structure with per-element UIDs |
| `ax_click` | Perform AXPress on an element by UID |
| `ax_set_value` | Set an element's value by UID |
| `ax_select` | Select an element by UID |
| `ax_perform_action` | Perform any arbitrary AX action on an element by UID |

### System Tools

| Tool | Description |
|------|-------------|
| `wait` | Wait for a specified number of milliseconds |
| `scrape` | HTTP GET a webpage and return extracted plain text |
| `execute_command` | Run a shell command; returns stdout/stderr/exit_code with optional timeout |
| `clipboard` | Read or write clipboard contents |
| `process` | List processes (filterable by name) or look up app PID |
| `filesystem` | Read / write / append / delete / list-dir / search / copy / move files |

### App Probe

| Tool | Description |
|------|-------------|
| `probe_app` | Aggregate window info + AX tree snapshot in a single call |

### CDP Browser Control (feature: cdp)

`cdp_connect` / `cdp_disconnect` / `cdp_screenshot` / `cdp_navigate` / `cdp_click` / `cdp_type` / `cdp_snapshot` / `cdp_element_at_point` / `cdp_run_script` / `cdp_list_pages`

### App Protocol (Electron/Native)

`app_connect` / `app_disconnect` / `app_get_info` / `app_get_tree` / `app_query` / `app_get_element` / `app_click` / `app_type` / `app_press_key` / `app_focus` / `app_screenshot` / `app_list_windows`

### Tracking

`start_hover_tracking` / `stop_hover_tracking` / `start_recording` / `stop_recording`

### Android ADB

`android_list_devices` / `android_connect` / `android_disconnect` / `android_screenshot` / `android_click` / `android_swipe` / `android_type_text` / `android_press_key` / `android_find_text` / `android_list_apps` / `android_launch_app` / `android_get_display_info` / `android_get_current_activity`

---

## 5. Key Design Decisions

### 5.1 stdio MCP Transport

Agents spawn `tday-devtools` as a child process and communicate via stdio. No ports, no authentication. The process lifecycle is bound to the agent — destroy the agent, destroy the binary. Clean isolation.

### 5.2 Single Binary Distribution

Rust compiles to a single statically-linked binary with no runtime dependencies. Bundled via electron-builder `extraResources`. On macOS, `lipo` merges arm64 + x86_64 builds into a Universal Binary.

### 5.3 AX Snapshot + UID Generation (Prevent Use-After-Free)

Each `take_ax_snapshot` call allocates a new generation counter. Old UIDs are immediately invalidated. The UID format `a<N>g<gen>` encodes both the element index and the generation; dispatch validates both, ensuring no operation is ever applied to a stale `AXUIElementRef` (raw C pointer).

### 5.4 Screenshot Cache Reuse

`ScreenshotCache` (LRU, 10 entries) prevents redundant captures when `find_image` is called multiple times within one agent step. A single screenshot can be searched for many templates without re-capturing.

### 5.5 Default Off / Opt-In

The Tday main process injects `tday-devtools` only when the user explicitly enables Computer Use. Default behavior: no agent is affected. Setting key: `tday:computerUseEnabled`.

### 5.6 Cargo Features

| Feature | Description | Default |
|---------|-------------|---------|
| `find_image_simd` | NCC with `wide` SIMD acceleration | on |
| `find_image_parallel` | NCC with `rayon` multithreading | on |
| `cdp` | Compile CDP code (chromiumoxide) | on |

---

## 6. Data Flow Example: take_screenshot -> find_image -> click

```
Agent                    tday-devtools
  |                           |
  |-- take_screenshot ------->|
  |                           | platform::capture_screen()
  |                           | -> png_data + meta (scale/origin)
  |                           | -> store in ss_cache["ss-123"]
  |<-- {id:"ss-123", ...} ----|
  |                           |
  |-- find_image {screenshot_id:"ss-123", template_id:"btn"} -->|
  |                           | fetch screenshot from ss_cache
  |                           | fetch template from img_cache
  |                           | find_image::find_image() NCC
  |                           | -> [{score:0.97, bbox:{x:100,y:200,...}}]
  |                           | convert px -> screen coords (scale/origin)
  |<-- [{x:150, y:250}] ------|
  |                           |
  |-- click {x:150, y:250} -->|
  |                           | platform::click(150.0, 250.0)
  |                           | -> CGEvent mouse click
  |<-- {"ok": true} ----------|
```

---

## 7. Tests

| Level | Count | Notes |
|-------|-------|-------|
| Unit tests | **81** | Covers handlers/system (filesystem/clipboard/process/execute/wait/scrape), platform/macos (input/display/app/ocr), session (ax_session UID parsing), tracking (hover/recorder serialization), app_protocol (error handling) |
| Integration tests | Manual | Screenshot / OCR / AX operations require macOS Screen Recording + Accessibility permissions; verified manually on a development machine |

Run unit tests:

```bash
cargo test --manifest-path crates/tday-devtools/Cargo.toml
```
