// Script: create-perf-issues.js
// Called by .github/workflows/create-perf-issues.yml via actions/github-script.
// Creates 22 performance-optimization issues; skips any that already exist.

module.exports = async ({ github, context }) => {
  const LABEL = 'performance';

  // Ensure the label exists (create it if missing).
  try {
    await github.rest.issues.getLabel({
      owner: context.repo.owner,
      repo: context.repo.repo,
      name: LABEL,
    });
  } catch (e) {
    if (e.status === 404) {
      await github.rest.issues.createLabel({
        owner: context.repo.owner,
        repo: context.repo.repo,
        name: LABEL,
        color: 'e4e669',
      });
    }
  }

  async function createIssue(title, body) {
    const result = await github.rest.search.issuesAndPullRequests({
      q: `repo:${context.repo.owner}/${context.repo.repo} is:issue in:title "${title}"`,
    });
    if (result.data.items.some((i) => i.title === title)) {
      console.log(`SKIP (already exists): ${title}`);
      return;
    }
    await github.rest.issues.create({
      owner: context.repo.owner,
      repo: context.repo.repo,
      title,
      body,
      labels: [LABEL],
    });
    console.log(`CREATED: ${title}`);
  }

  const issues = [
    {
      title: 'perf(screenshot): Full-screen capture performs redundant JPEG→PNG round-trip, wasting 4 image operations',
      body: `## Problem

\`crates/tday-nativecore/src/handlers/screenshot.rs\` L27–59

The full-screen capture path performs 4 image operations:

1. \`platform::capture_screen()\` returns PNG
2. First \`spawn_blocking\`: PNG decode → JPEG encode (for the HTTP response)
3. Second \`spawn_blocking\`: JPEG decode → PNG re-encode (to store in \`ScreenshotCache\`)

Each full-screen capture triggers an extra \`spawn_blocking\` task and a redundant JPEG decode + PNG re-encode.

\`\`\`rust
// L47-59  ← unnecessary spawn_blocking
let png_data = tokio::task::spawn_blocking({
    let jb = jpeg_bytes.clone();
    move || {
        let img = image::load_from_memory(&jb)?; // JPEG decode
        img.write_to(..., ImageFormat::Png)      // PNG re-encode
    }
}).await??;
\`\`\`

## Suggested fix

\`capture_screen()\` already returns PNG — store it directly in \`ScreenshotCache\` without going through JPEG. Perform only one PNG→JPEG encode inside the single \`spawn_blocking\` for the response, reducing 4 image operations to 1 and eliminating the second \`spawn_blocking\`.`,
    },
    {
      title: 'perf(image-cache): ImageCache::get() uses VecDeque linear scan, O(n) lookup',
      body: `## Problem

\`crates/tday-nativecore/src/session/image_cache.rs\` L37–44

\`\`\`rust
pub fn get(&mut self, id: &str) -> Option<CachedImage> {
    if let Some(pos) = self.entries.iter().position(|e| e.id == id) { // O(n)
        let entry = self.entries.remove(pos)?;   // O(n) shift
        ...
    }
}
\`\`\`

Every \`find_image\` call triggers an O(n) scan + O(n) \`remove\` (VecDeque element shift).

## Suggested fix

Add a \`HashMap<String, usize>\` index (id → position), or switch to the \`lru\` crate's standard LRU implementation, to bring both lookup and eviction down to O(1).`,
    },
    {
      title: 'perf(screenshot-cache): ScreenshotCache::peek() uses VecDeque linear scan, O(n) lookup',
      body: `## Problem

\`crates/tday-nativecore/src/session/screenshot_cache.rs\` L48

\`\`\`rust
pub fn peek(&self, id: &str) -> Option<&CachedScreenshot> {
    self.entries.iter().find(|e| e.id == id) // O(n) on every call
}
\`\`\`

Every \`find_image\` and \`resolve_screenshot_png\` call performs an O(n) scan of the entire screenshot cache.

## Suggested fix

Add a \`HashMap<String, usize>\` index, or use the \`lru\` crate, to bring lookup down to O(1).`,
    },
    {
      title: 'perf(find-image): Clones full screenshot (~15 MB Retina image) when no search region is specified',
      body: `## Problem

\`crates/tday-nativecore/src/find_image.rs\` L88–92

\`\`\`rust
let search_view = if sr_x == 0 && sr_y == 0 && sr_w == ss_w && sr_h == ss_h {
    screenshot.clone()  // ← clones the entire image! ~15 MB on Retina
} else {
    image::imageops::crop_imm(...)
};
\`\`\`

A Retina full-screen capture (5000×3000 grayscale) is ~15 MB. Every region-less \`find_image\` call copies it in full.

## Suggested fix

Use \`Cow<GrayImage>\`: hold a reference when no region is specified, and only take ownership when a crop is needed, eliminating the unnecessary copy.`,
    },
    {
      title: 'perf(find-image): Template scaling uses Lanczos3 filter, 3–5× slower than Bilinear with no benefit for template matching',
      body: `## Problem

\`crates/tday-nativecore/src/find_image.rs\` L137–138

\`\`\`rust
let scaled_t = image::imageops::resize(ref_t, new_w, new_h,
    image::imageops::FilterType::Lanczos3); // highest quality, slowest
\`\`\`

Multi-scale search (default 5 scales × 1 rotation) performs 5 Lanczos3 resizes per \`find_image\` call. For NCC template matching, Lanczos3's sub-pixel accuracy improvement has negligible impact on the final score.

## Suggested fix

Switch to \`FilterType::Triangle\` (bilinear) or \`FilterType::CatmullRom\`. Quality difference is <0.1% in template-matching scenarios, while speed improves 3–5×.`,
    },
    {
      title: 'perf(find-image): precompute_template allocates an unnecessary Vec<f64> intermediate buffer',
      body: `## Problem

\`crates/tday-nativecore/src/find_image.rs\` L195–203

\`\`\`rust
fn precompute_template(t: &GrayImage, mask: ...) -> TemplateVals {
    let pixels: Vec<f64> = (...).map(...).collect(); // ← collects all pixels into a Vec
    let mean = pixels.iter().sum::<f64>() / pixels.len() as f64;
    let norm = pixels.iter().map(|&v| (v - mean).powi(2)).sum::<f64>().sqrt();
    ...
}
\`\`\`

This allocation is triggered for every scale/rotation combination. A 100×100 template = 10,000 f64 values = 80 KB heap allocation, iterated twice.

## Suggested fix

Use Welford's online algorithm (single pass) or two iterator passes (without collecting) to compute mean and variance directly on the pixel stream, eliminating the intermediate Vec entirely.`,
    },
    {
      title: 'perf(find-image): ncc_at recomputes window mean from scratch at every candidate position — missing Summed Area Table optimization',
      body: `## Problem

\`crates/tday-nativecore/src/find_image.rs\` L206–235

\`ncc_at\` fully traverses a template-sized window for every candidate position (ox, oy) to compute the sliding mean:

\`\`\`rust
for y in 0..th { for x in 0..tw {
    sum_s += src.get_pixel(ox + x, oy + y).0[0] as f64;
    count += 1;
}}
\`\`\`

Overall complexity: O(W × H × tw × th). For a 5000×3000 screenshot with a 100×100 template: ~150 billion operations at stride=1.

## Suggested fix

Build a Summed-Area Table (integral image) to reduce sliding-window mean from O(tw×th) to O(1), bringing overall scan complexity from O(W·H·tw·th) down to O(W·H). This is the standard acceleration technique for template matching and can yield order-of-magnitude speedups.`,
    },
    {
      title: 'perf(hover-tracker): element_at_point_for_hover serializes ElementInfo to JSON then parses it back to HoverElement',
      body: `## Problem

\`crates/tday-nativecore/src/tracking/hover_tracker.rs\` L263–267

\`\`\`rust
fn element_at_point_for_hover(x, y, app_name) -> Result<HoverElement, String> {
    let info = crate::platform::element_at_point(x, y, app_name)?; // already a struct
    let value = serde_json::to_value(&info).map_err(...)?;          // serialize to JSON Value
    Ok(parse_hover_element(&value))                                  // parse back to HoverElement
}
\`\`\`

Hover tracking polls by default every 200ms, performing a pointless \`ElementInfo → serde_json::Value → HoverElement\` round-trip on each tick.

## Suggested fix

Implement \`From<ElementInfo> for HoverElement\` (or \`impl HoverElement { fn from_info(info: &ElementInfo) -> Self }\`) to assign fields directly, eliminating the serde round-trip.`,
    },
    {
      title: 'perf(ax-snapshot): relabel_uids performs a second recursive traversal of the fully-serialized JSON tree',
      body: `## Problem

\`crates/tday-nativecore/src/handlers/ax.rs\` L39–42

\`\`\`rust
let root_json = relabel_uids(
    serde_json::to_value(&root)?,  // serialize the entire tree first
    gen                             // then recursively rewrite all uid fields
);
\`\`\`

A 10,000-node AX tree undergoes two full traversals: one serde serialization pass and one \`relabel_uids\` JSON recursion. The comment explains why: "snapshot builder uses g0 as a placeholder; generation is only known afterwards."

## Suggested fix

Pass the \`generation\` parameter into \`snapshot_element\` at build time so it can generate the correct UID (\`a{n}g{gen}\`) directly, eliminating \`relabel_uids\` and the second JSON tree traversal entirely.`,
    },
    {
      title: 'perf(ax-find): AXRole is read twice for each AX element in ax_find',
      body: `## Problem

\`crates/tday-nativecore/src/platform/macos/ax.rs\` L306 and L337

Inside the \`ax_find\` walk_tree callback, AXRole is fetched twice:

\`\`\`rust
// L306 - for role filtering
let role = get_string(el, "AXRole").unwrap_or_else(|| "unknown".into());

// ... filter logic ...

// L337 - fetched again to build AXNode
let role  = get_string(el, "AXRole").unwrap_or_else(|| "unknown".into());
\`\`\`

Each \`AXUIElementCopyAttributeValue\` call has IPC overhead (cross-process mach port communication).

## Suggested fix

Fetch AXRole once and reuse the same variable in both places.`,
    },
    {
      title: 'perf(screen-recorder): Clones app_name_cache HashMap and calls list_windows() on every frame',
      body: `## Problem

\`crates/tday-nativecore/src/tracking/screen_recorder.rs\` L117, L148

The recording loop (up to 5 fps) does on every frame:
1. \`app_name_cache.clone()\` — clones the entire PID→AppName HashMap
2. \`crate::platform::list_windows()\` — enumerates all windows (CoreGraphics/WinAPI call)

\`\`\`rust
let app_cache_snapshot = app_name_cache.clone(); // cloned every frame
let result = tokio::task::spawn_blocking(move || {
    let windows = crate::platform::list_windows()?; // enumerated every frame
    ...
}).await;
\`\`\`

## Suggested fix

1. Replace the clone with \`Arc<Mutex<HashMap>>\` so spawn_blocking reads via lock instead of copying.
2. Cache the previous frame's foreground window ID and only re-query \`list_windows()\` when the foreground changes.`,
    },
    {
      title: 'perf(ax-tree): AX attribute name CFStrings are re-allocated on every tree traversal',
      body: `## Problem

\`crates/tday-nativecore/src/platform/macos/ax.rs\` L507, L514–515

Helper functions like \`ax_children\`, \`get_string\`, \`get_bool\`, and \`get_ax_value\` allocate a new \`CFString\` on every call:

\`\`\`rust
unsafe fn get_string(el: AXUIElementRef, attr_name: &str) -> Option<String> {
    let attr = CFString::new(attr_name); // ← allocates on every call
    ...
}
\`\`\`

A 10,000-node AX tree snapshot calls \`get_string\`/\`get_bool\` 5–8 times per node, totalling ~50,000–80,000 CFString heap allocations per snapshot.

## Suggested fix

Declare commonly used attribute names (\`AXRole\`, \`AXTitle\`, \`AXValue\`, \`AXDescription\`, \`AXEnabled\`, \`AXFocused\`, \`AXChildren\`, \`AXPosition\`, \`AXSize\`) as global \`lazy_static\` or \`once_cell::sync::Lazy<CFString>\` constants and reuse them for the lifetime of the process.`,
    },
    {
      title: 'perf(history-scanner): readFileSync reads the entire session file when only the first 150 lines are needed',
      body: `## Problem

\`apps/desktop/src/main/agent-history/scanners.ts\` and files under \`apps/desktop/src/main/usage/session-readers/\`

All scanners read the complete JSONL file before truncating:

\`\`\`typescript
const content = readFileSync(filePath, 'utf8'); // potentially several MB
// ...
for (const line of content.split('\\n')) {
    if (lineIdx++ > MAX_TITLE_SCAN_LINES) break; // only use the first 150 lines
}
\`\`\`

Claude-code / Codex session files can reach several MB due to tool call results and code content. Installations with hundreds of sessions read GB of data into memory on every history refresh, only to discard most of it.

## Suggested fix

Use \`readline.createInterface({ input: fs.createReadStream(filePath) })\` to read line-by-line and call \`rl.close()\` after 150 lines. This can reduce I/O by more than 90%.`,
    },
    {
      title: 'perf(session-cache): collectFiles() called again after dirty check, duplicating stat syscalls',
      body: `## Problem

\`apps/desktop/src/main/usage/session-cache.ts\` L211–218 and L317–319

\`isAgentDirty\` already calls \`watcher.collectFiles()\` to obtain the file list, but after re-scanning in the dirty branch it calls it again to update the watermark:

\`\`\`typescript
// L211-218 - first call
function isAgentDirty(watcher, index) {
  const files = watcher.collectFiles(); // stat all files
  ...
}

// L317-319 - second call (same files)
const files = watcher.collectFiles(); // ← duplicate stat
const { fileCount, maxMtime } = statFiles(files);
\`\`\`

For agents with hundreds of session files (e.g. codex), every refresh stat-walks the same file set twice.

## Suggested fix

Change \`isAgentDirty\` to return \`{ dirty: boolean; files: FileWithMtime[] }\` and reuse the already-stat'd file list directly in the dirty branch.`,
    },
    {
      title: 'perf(usage-store): computeUsageSummary re-reads pricing.json from disk on every call',
      body: `## Problem

\`apps/desktop/src/main/usage/store.ts\` L38–40, L67–68

\`\`\`typescript
function mergedPricing(): Record<string, ModelPricing> {
  return { ...BUILTIN_PRICING, ...loadUserPricing() }; // reads disk every time
}

export function computeUsageSummary(records: UsageRecord[]): UsageSummary {
  const pricing = mergedPricing(); // ← triggers readFileSync
  ...
}
\`\`\`

\`queryUsage\` (the IPC handler) calls \`computeUsageSummary\` on every query, causing a \`readFileSync\` of \`~/.tday/pricing.json\` on every request.

## Suggested fix

Cache the merged pricing in a module-level variable and invalidate it via \`fs.watch\` on the pricing file, or on each \`setSetting\` call, to avoid reading from disk on every query.`,
    },
    {
      title: 'perf(usage-store): Math.max(...tsValues) spread overflows V8 argument stack on large record sets',
      body: `## Problem

\`apps/desktop/src/main/usage/store.ts\` L153–154

\`\`\`typescript
const tsValues = records.map((r) => r.ts); // intermediate array
const spanMs = tsValues.length > 1
  ? Math.max(...tsValues) - Math.min(...tsValues) // ← spread
  : 0;
\`\`\`

\`Math.max(...array)\` passes array elements as function arguments via spread. V8's function call argument limit is ~65,536. When \`records\` exceeds that count, a \`RangeError: Maximum call stack size exceeded\` is thrown.

## Suggested fix

Replace the spread with a \`reduce\` or \`for\` loop:

\`\`\`typescript
let minTs = Infinity, maxTs = -Infinity;
for (const r of records) {
  if (r.ts < minTs) minTs = r.ts;
  if (r.ts > maxTs) maxTs = r.ts;
}
\`\`\`

This also eliminates the intermediate \`tsValues\` array allocation, saving one O(n) pass.`,
    },
    {
      title: 'perf(usage-store): loadUsageRecords reads the entire usage.jsonl into memory before filtering',
      body: `## Problem

\`apps/desktop/src/main/usage/store.ts\` L176–193

\`\`\`typescript
const lines = readFileSync(USAGE_FILE, 'utf8').split('\\n').filter(Boolean);
// then a for-loop applies fromTs/toTs/agentId filters
\`\`\`

\`usage.jsonl\` grows over time (the comment notes ~1–2 MB per 10,000 requests), but every query reads the entire file into memory, parses all lines, then discards most of them. For time-range queries such as "today's usage," the vast majority of records are thrown away.

## Suggested fix

Maintain an in-memory index sorted by timestamp (line offset → ts) and use binary search to locate the \`fromTs\` starting point, reading and parsing only the relevant segment. Alternatively, switch to streaming reads for large files.`,
    },
    {
      title: 'perf(input): stripReasoningContent calls JSON.stringify on the entire input array just to check field existence',
      body: `## Problem

\`apps/desktop/src/main/gateway/bridge/input.ts\` L236–246

\`\`\`typescript
export function stripReasoningContent(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  const str = JSON.stringify(input);                       // ← serializes entire conversation history
  if (!str.includes('reasoning_content')) return input;   // only checks for field existence
  return input.map((item) => { ... });
}
\`\`\`

The conversation history can contain dozens of message turns and large blocks of code or tool output, yet this code serializes the whole array just to perform a substring check for a field name.

## Suggested fix

\`\`\`typescript
if (!Array.isArray(input) || !input.some(
  (item) => item && typeof item === 'object' && 'reasoning_content' in item
)) return input;
\`\`\`

Eliminates \`JSON.stringify\` entirely; direct property access short-circuits as soon as a match is found.`,
    },
    {
      title: 'perf(thinking-state): ThinkingState.prune() uses O(n) Array.shift(), making each eviction linear-cost',
      body: `## Problem

\`apps/desktop/src/main/gateway/deepseek/state.ts\` L114–123

\`\`\`typescript
private prune(): void {
  while (this.recordOrder.length > this.limit) {
    const id = this.recordOrder.shift()!; // O(n) left-shift
    this.records.delete(id);
  }
  while (this.textOrder.length > this.limit) {
    const key = this.textOrder.shift()!;  // O(n)
    this.textRecords.delete(key);
  }
}
\`\`\`

\`Array.shift()\` is an O(n) operation that shifts every remaining element on each eviction. With a default limit of 1024, this fires frequently during heavy tool-call workloads.

## Suggested fix

Replace \`shift()\` with a circular index (ring buffer) or an \`index: number\` pointer to bring prune down to O(1). Alternatively, use a proper deque such as the \`denque\` package.`,
    },
    {
      title: 'perf(adapter): CodexDeepSeekAnthropicAdapter.conversations Map grows unbounded — missing LRU eviction',
      body: `## Problem

\`apps/desktop/src/main/gateway/adapter.ts\` L64–65

\`\`\`typescript
export class CodexDeepSeekAnthropicAdapter implements GatewayAdapter {
  private readonly conversations = new Map<string, AMessage[]>(); // never cleaned up
  private readonly thinkingStates = new Map<string, ThinkingState>();
}
\`\`\`

Every new request's \`responseId\` is stored in \`conversations\` but never evicted. Long-running Codex sessions (hundreds of turns) retain the full message history for every \`previous_response_id\`, causing continuous Node.js process memory growth. \`thinkingStates\` has the same issue.

## Suggested fix

Add LRU eviction to both Maps (e.g. limit=500 entries). This can be implemented manually using Map's insertion-order property, or by introducing the \`lru-cache\` package.`,
    },
    {
      title: 'perf(agent-history): Math.max(...files.map(...)) spread in isDirty can stack-overflow with many sessions',
      body: `## Problem

\`apps/desktop/src/main/agent-history/index.ts\` L120

\`\`\`typescript
const maxMtime = files.length > 0
  ? Math.max(...files.map((f) => f.mtime)) // ← spread of potentially large array
  : 0;
\`\`\`

Same class of bug as in \`usage/store.ts\`: \`Math.max(...array)\` passes elements as function arguments via spread. When the files array exceeds ~65,536 entries (large Codex installs), a \`RangeError\` is thrown.

## Suggested fix

\`\`\`typescript
const maxMtime = files.reduce((m, f) => f.mtime > m ? f.mtime : m, 0);
\`\`\`

This also eliminates the intermediate \`map\` array. The same pattern exists in \`session-cache.ts\` L318 and should be fixed there too.`,
    },
    {
      title: 'perf(history-store): saveStore uses JSON.stringify with 2-space indent, bloating file size by 30–50%',
      body: `## Problem

\`apps/desktop/src/main/agent-history/store.ts\` L78

\`\`\`typescript
export function saveStore(store: HistoryStore): void {
  writeFileSync(INDEX_TMP, JSON.stringify(store, null, 2), 'utf8'); // pretty-print
  ...
}
\`\`\`

After every history refresh, the entire history index is serialized with 2-space indentation and written to disk. For hundreds of history entries, pretty-printing inflates file size by 30–50%, increases write time (more bytes), and holds a larger string in memory.

## Suggested fix

Use \`JSON.stringify(store)\` (no indentation). The history index is machine-read; human readability is not a requirement. Any \`null, 2\` occurrences in \`settings-store.ts\` writes should be fixed the same way.`,
    },
  ];

  for (const issue of issues) {
    await createIssue(issue.title, issue.body);
  }
  console.log('Done.');
};
