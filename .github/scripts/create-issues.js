#!/usr/bin/env node
// Script to create GitHub issues for all P1/P2 bugs found in tday analysis
// Run in GitHub Actions where GITHUB_TOKEN is available

const https = require('https');

const bugs = [
  {
    title: "[P1] u32 underflow in find_image search_region boundaries",
    labels: ["bug"],
    body: "**Priority: P1**\n**File:** `crates/tday-nativecore/src/find_image.rs` lines 83-84\n\nWhen `search_region.x > ss_w` or `search_region.y > ss_h`, the u32 subtraction `ss_w - r.x` underflows. In debug mode this panics; in release mode it wraps around producing a nonsense crop rectangle and corrupting NCC template-matching results.\n\n**Fix:** Add bounds check before subtraction: `if r.x >= ss_w || r.y >= ss_h { return Err(NcError::tool(\"search_region out of bounds\")); }`"
  },
  {
    title: "[P1][Security] HTTP MCP server has no authentication — local process can execute arbitrary shell commands",
    labels: ["bug", "security"],
    body: "**Priority: P1 (Security)**\n**File:** `apps/desktop/src/main/nativecore-service.ts` lines 148-185\n\nThe nativecore HTTP server binds to 127.0.0.1 with no authentication. Any local process can invoke `execute_command` (arbitrary sh -c), `filesystem` (read/write/delete any path), clipboard, screenshot, mouse/keyboard. Server stays alive 60s after last session.\n\n**Fix:** Generate random bearer token at startup, pass via `--auth-token` flag, require `Authorization: Bearer <token>` on every request."
  },
  {
    title: "[P1] TOCTOU race in singleton lock — no file locking primitive",
    labels: ["bug"],
    body: "**Priority: P1**\n**File:** `crates/tday-nativecore/src/singleton.rs` lines ~30-70\n\nThe read-old-pid / kill-old / write-new-pid sequence in `acquire()` is non-atomic. Two concurrent nativecore processes both read the same stale PID, both kill it, then overwrite each other's PID. No `flock(2)` is used, allowing two instances to run simultaneously.\n\n**Fix:** Use `flock(LOCK_EX)` or `O_CREAT|O_EXCL` to make the entire check-kill-write atomic."
  },
  {
    title: "[P1] pkill -s flag is session-ID filter not signal selector — SIGKILL silently ignored",
    labels: ["bug"],
    body: "**Priority: P1**\n**File:** `crates/tday-nativecore/src/handlers/system.rs` lines ~404-406\n\n`pkill -s <signal_number> <name>` uses `-s` as a session-ID filter on Linux/macOS, NOT a signal selector. The `force: true` (SIGKILL) option is silently ignored; only SIGTERM is ever sent. Processes that ignore SIGTERM cannot be force-killed.\n\n**Fix:** Use `pkill -<N> <name>` format (e.g. `pkill -9 name` for SIGKILL)."
  },
  {
    title: "[P2] Parent-watch thread spawn failure silently ignored — nativecore becomes orphan process",
    labels: ["bug"],
    body: "**Priority: P2**\n**File:** `crates/tday-nativecore/src/parent_watch.rs` line 97\n\n`let _ = thread::spawn(...)` discards the Result. If spawn fails (resource exhaustion), parent-death monitoring never starts and nativecore runs as an orphan daemon holding the port indefinitely.\n\n**Fix:** Handle error explicitly: fail fast with a clear error message if spawn fails."
  },
  {
    title: "[P2] filesystem copy mode ignores cp exit status — failed copies silently return ok:true",
    labels: ["bug"],
    body: "**Priority: P2**\n**File:** `crates/tday-nativecore/src/handlers/system.rs` lines ~530-534\n\n`cp -R` exit status is called but the Result is never inspected. Failed copies (permission denied, disk full, missing source) silently return `{ok: true}`, causing invisible data loss.\n\n**Fix:** Check `status.success()` and return an error if the copy failed."
  },
  {
    title: "[P2][Security] filesystem search allows full path traversal — no input validation",
    labels: ["bug", "security"],
    body: "**Priority: P2 (Security)**\n**File:** `crates/tday-nativecore/src/handlers/system.rs` lines ~560-570\n\n`find <user_path> -name <user_pattern>` uses raw unvalidated input. Setting `path=\"/\"` enumerates the entire filesystem; path traversal (e.g. `../../etc`) is possible.\n\n**Fix:** Canonicalize and restrict path to a safe root; validate pattern against safe chars; consider `std::fs::read_dir` instead of spawning `find`."
  },
  {
    title: "[P2] handle_process list uses Unix-only ps flags — crashes on Windows",
    labels: ["bug"],
    body: "**Priority: P2**\n**File:** `crates/tday-nativecore/src/handlers/system.rs` lines ~350-370\n\n`ps -axo pid,pcpu,pmem,comm` is Unix/macOS-only. The crate targets Windows (`platform/windows/`) but has no `#[cfg(windows)]` conditional for process listing, causing complete failure on Windows.\n\n**Fix:** Use `#[cfg(windows)]` to select `tasklist /FO CSV /NH`, or use the `sysinfo` crate for cross-platform process enumeration."
  },
  {
    title: "[P2] CronScheduler setTimeout overflow fires monthly/yearly jobs immediately in a tight loop",
    labels: ["bug"],
    body: "**Priority: P2**\n**File:** `apps/desktop/src/main/cron.ts` lines ~95-115\n\nJS `setTimeout` fires immediately when delay > 2^31-1 ms (~24.8 days). Monthly (~30d) and yearly (~365d) cron jobs exceed this limit, causing them to fire immediately and re-schedule in a tight loop.\n\n**Fix:** Cap delay at `Math.min(delay, 2**31-1)`; when the cap fires, re-check `Date.now() >= nextTs` before executing the job."
  },
  {
    title: "[P2] Unvalidated message role passed to Anthropic API causes 400 errors",
    labels: ["bug"],
    body: "**Priority: P2**\n**File:** `apps/desktop/src/main/gateway/bridge/input.ts` lines 362-365\n\nThe `role` field is used verbatim as Anthropic message role. Anthropic only accepts 'user'/'assistant'. Invalid roles ('tool', 'function', 'system') cause 400 errors. System messages are also wrongly placed in the messages array instead of the `system` parameter.\n\n**Fix:** Map `const r = (role === 'assistant') ? 'assistant' : 'user'`; extract system items separately to the `system` parameter."
  },
  {
    title: "[P2] NCC template matching produces NaN score on zero-norm template — silent false negatives",
    labels: ["bug"],
    body: "**Priority: P2**\n**File:** `crates/tday-nativecore/src/find_image.rs` lines ~130-155\n\nGuard `if denom < 1e-9` misses exact-zero subnormals. `corr / 0.0` produces NaN; `NaN >= threshold` is false, silently dropping valid matches for solid-color or very small templates.\n\n**Fix:** `if denom == 0.0 || !denom.is_finite() { return 0.0; }` and `.clamp(-1.0, 1.0)` on the result."
  },
  {
    title: "[P2] Non-null assertion proc.stdout! crashes nativecore service silently at startup",
    labels: ["bug"],
    body: "**Priority: P2**\n**File:** `apps/desktop/src/main/nativecore-service.ts` line 176\n\n`proc.stdout!.on('data', ...)` throws TypeError if stdout is null, crashing the nativecore service silently at startup with no useful error message.\n\n**Fix:** `if (!proc.stdout) throw new Error('nativecore stdout is null')`"
  },
  {
    title: "[P2] Gateway adapter conversations/thinkingStates maps grow unbounded — memory leak in long sessions",
    labels: ["bug"],
    body: "**Priority: P2**\n**File:** `apps/desktop/src/main/gateway/adapter.ts` lines 64-65, 213, 314\n\n`conversations` and `thinkingStates` Maps have no eviction (no TTL, LRU, or size limit). They accumulate full message histories for every LLM call, causing progressive memory growth and eventual OOM in long-running Electron sessions.\n\n**Fix:** Add LRU eviction (e.g. max 50 entries) or TTL (e.g. 1 hour) to both maps."
  },
  {
    title: "[P2][Security] Android shell_args joins arguments without escaping — shell injection on Android device",
    labels: ["bug", "security"],
    body: "**Priority: P2 (Security)**\n**File:** `crates/tday-nativecore/src/android/device.rs` lines 62-64\n\n`shell_args` joins args with a space and runs them verbatim on the Android device shell without escaping. Arguments with metacharacters inject arbitrary commands. Combined with the unauthenticated HTTP MCP server, any local process can run arbitrary commands on the connected Android device.\n\n**Fix:** Validate key args against a KEYCODE_* allowlist, or shell-quote all args before joining."
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
