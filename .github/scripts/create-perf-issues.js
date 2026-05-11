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
      title: 'perf(screenshot): 全屏截图存在 JPEG→PNG 双重编解码，浪费 4 次图像操作',
      body: `## 问题

\`crates/tday-nativecore/src/handlers/screenshot.rs\` L27–59

全屏截图路径做了 4 次图像操作：

1. \`platform::capture_screen()\` 返回 PNG
2. 第一个 \`spawn_blocking\`：PNG 解码 → 编码 JPEG（给响应用）
3. 第二个 \`spawn_blocking\`：JPEG 解码 → 再编码 PNG（存入 \`ScreenshotCache\`）

每次全屏截图额外触发了一次 \`spawn_blocking\` 任务调度和一次 JPEG 解码+PNG 重编码。

\`\`\`rust
// L47-59  ← 多余的 spawn_blocking
let png_data = tokio::task::spawn_blocking({
    let jb = jpeg_bytes.clone();
    move || {
        let img = image::load_from_memory(&jb)?; // JPEG 解码
        img.write_to(..., ImageFormat::Png)      // PNG 再编码
    }
}).await??;
\`\`\`

## 优化方向

\`capture_screen()\` 本身已返回 PNG，直接存入 \`ScreenshotCache\`，无需经过 JPEG。只在同一个 \`spawn_blocking\` 内做一次 PNG→JPEG 编码供响应使用，即可将 4 次图像操作降为 1 次，并消除第二个 \`spawn_blocking\`。`,
    },
    {
      title: 'perf(image-cache): ImageCache::get() 使用 VecDeque 线性扫描，查找为 O(n)',
      body: `## 问题

\`crates/tday-nativecore/src/session/image_cache.rs\` L37–44

\`\`\`rust
pub fn get(&mut self, id: &str) -> Option<CachedImage> {
    if let Some(pos) = self.entries.iter().position(|e| e.id == id) { // O(n)
        let entry = self.entries.remove(pos)?;   // O(n) 位移
        ...
    }
}
\`\`\`

每次 \`find_image\` 调用都触发一次 O(n) 扫描 + O(n) \`remove\`（VecDeque 内部元素位移）。

## 优化方向

增加 \`HashMap<String, usize>\` 作为 id→位置 索引，或改用 \`lru\` crate 的标准 LRU 实现，将查找/驱逐均降为 O(1)。`,
    },
    {
      title: 'perf(screenshot-cache): ScreenshotCache::peek() 使用 VecDeque 线性扫描，查找为 O(n)',
      body: `## 问题

\`crates/tday-nativecore/src/session/screenshot_cache.rs\` L48

\`\`\`rust
pub fn peek(&self, id: &str) -> Option<&CachedScreenshot> {
    self.entries.iter().find(|e| e.id == id) // O(n) 每次调用
}
\`\`\`

每次 \`find_image\`、\`resolve_screenshot_png\` 都要 O(n) 遍历整个截图缓存。

## 优化方向

增加 \`HashMap<String, usize>\` 索引，或使用 \`lru\` crate，将查找降为 O(1)。`,
    },
    {
      title: 'perf(find-image): 无搜索区域时克隆完整截图（~15 MB Retina 图像）',
      body: `## 问题

\`crates/tday-nativecore/src/find_image.rs\` L88–92

\`\`\`rust
let search_view = if sr_x == 0 && sr_y == 0 && sr_w == ss_w && sr_h == ss_h {
    screenshot.clone()  // ← 克隆整张图！Retina 全屏约 15 MB
} else {
    image::imageops::crop_imm(...)
};
\`\`\`

Retina 全屏截图（5000×3000 灰度）约 15 MB，每次无区域的 \`find_image\` 调用都完整复制一份。

## 优化方向

改用 \`Cow<GrayImage>\`：无区域时持有引用，有裁剪区域时才持有拥有值，避免无谓拷贝。`,
    },
    {
      title: 'perf(find-image): 模板缩放使用 Lanczos3 滤波，比 Bilinear 慢 3–5 倍且无必要',
      body: `## 问题

\`crates/tday-nativecore/src/find_image.rs\` L137–138

\`\`\`rust
let scaled_t = image::imageops::resize(ref_t, new_w, new_h,
    image::imageops::FilterType::Lanczos3); // 最高质量，最慢
\`\`\`

多尺度搜索（默认 5 个 scale × 1 个 rotation）每次 \`find_image\` 调用做 5 次 Lanczos3 缩放。对于 NCC 模板匹配，Lanczos3 的亚像素精度提升对最终得分的影响可忽略不计。

## 优化方向

改为 \`FilterType::Triangle\`（双线性）或 \`FilterType::CatmullRom\`。在模板匹配场景下质量差异<0.1%，速度可提升 3–5 倍。`,
    },
    {
      title: 'perf(find-image): precompute_template 分配不必要的 Vec<f64> 中间缓冲区',
      body: `## 问题

\`crates/tday-nativecore/src/find_image.rs\` L195–203

\`\`\`rust
fn precompute_template(t: &GrayImage, mask: ...) -> TemplateVals {
    let pixels: Vec<f64> = (...).map(...).collect(); // ← 全部像素收集进 Vec
    let mean = pixels.iter().sum::<f64>() / pixels.len() as f64;
    let norm = pixels.iter().map(|&v| (v - mean).powi(2)).sum::<f64>().sqrt();
    ...
}
\`\`\`

每个 scale/rotation 组合都触发此分配。100×100 模板 = 10,000 个 f64 = 80 KB 堆分配，且扫描两遍。

## 优化方向

用 Welford 在线算法（单遍）或两遍迭代器（不收集）直接在像素流上计算均值和方差，完全消除中间 Vec 分配。`,
    },
    {
      title: 'perf(find-image): ncc_at 每个候选位置都从头计算窗口均值，缺少积分图（Summed Area Table）优化',
      body: `## 问题

\`crates/tday-nativecore/src/find_image.rs\` L206–235

\`ncc_at\` 对截图中每个候选位置 (ox, oy) 都完整遍历模板大小的窗口来计算滑动均值：

\`\`\`rust
for y in 0..th { for x in 0..tw {
    sum_s += src.get_pixel(ox + x, oy + y).0[0] as f64;
    count += 1;
}}
\`\`\`

整体复杂度为 O(W × H × tw × th)。对 5000×3000 截图、100×100 模板：约 1500 亿次操作（stride=1）。

## 优化方向

构建 Summed-Area Table（积分图），将滑动窗口均值从 O(tw×th) 降为 O(1)，整体扫描复杂度从 O(W·H·tw·th) 降为 O(W·H)。这是模板匹配的标准加速方案，可带来数量级性能提升。`,
    },
    {
      title: 'perf(hover-tracker): element_at_point_for_hover 将 ElementInfo 序列化为 JSON 再解析回 HoverElement',
      body: `## 问题

\`crates/tday-nativecore/src/tracking/hover_tracker.rs\` L263–267

\`\`\`rust
fn element_at_point_for_hover(x, y, app_name) -> Result<HoverElement, String> {
    let info = crate::platform::element_at_point(x, y, app_name)?; // 已有结构体
    let value = serde_json::to_value(&info).map_err(...)?;          // 序列化成 JSON Value
    Ok(parse_hover_element(&value))                                  // 再从 JSON Value 解析回来
}
\`\`\`

悬停跟踪默认每 200ms 轮询一次，每次都做一次无意义的 \`ElementInfo → serde_json::Value → HoverElement\` 往返。

## 优化方向

实现 \`From<ElementInfo> for HoverElement\`（或 \`impl HoverElement { fn from_info(info: &ElementInfo) -> Self }\`），直接字段赋值，消除 serde 往返。`,
    },
    {
      title: 'perf(ax-snapshot): relabel_uids 对已序列化的完整 JSON 树做第二次递归遍历',
      body: `## 问题

\`crates/tday-nativecore/src/handlers/ax.rs\` L39–42

\`\`\`rust
let root_json = relabel_uids(
    serde_json::to_value(&root)?,  // 先序列化整棵树
    gen                             // 再递归遍历重写所有 uid 字段
);
\`\`\`

10,000 节点的 AX 树会经历两次完整遍历：一次 serde 序列化，一次 \`relabel_uids\` JSON 递归。注释也说明了原因：「snapshot builder 使用 g0 占位，事后才知道 generation」。

## 优化方向

在 \`snapshot_element\` 构建阶段传入 \`generation\` 参数，直接生成正确的 UID（\`a{n}g{gen}\`），彻底消除 \`relabel_uids\` 函数和第二次 JSON 树遍历。`,
    },
    {
      title: 'perf(ax-find): ax_find 中每个 AX 元素的 AXRole 被读取两次',
      body: `## 问题

\`crates/tday-nativecore/src/platform/macos/ax.rs\` L306 和 L337

在 \`ax_find\` 的 walk_tree 回调中，AXRole 被获取了两次：

\`\`\`rust
// L306 - 用于 role 过滤
let role = get_string(el, "AXRole").unwrap_or_else(|| "unknown".into());

// ... 过滤逻辑 ...

// L337 - 再次获取 role 来构建 AXNode
let role  = get_string(el, "AXRole").unwrap_or_else(|| "unknown".into());
\`\`\`

每次 \`AXUIElementCopyAttributeValue\` 调用都有 IPC 开销（跨进程 mach port 通信）。

## 优化方向

只获取一次 AXRole，在两处复用同一变量。`,
    },
    {
      title: 'perf(screen-recorder): 每帧都克隆 app_name_cache HashMap 并调用 list_windows()',
      body: `## 问题

\`crates/tday-nativecore/src/tracking/screen_recorder.rs\` L117, L148

录屏循环（最高 5fps）每一帧都：
1. \`app_name_cache.clone()\` — 克隆整个 PID→AppName HashMap
2. \`crate::platform::list_windows()\` — 枚举所有窗口（CoreGraphics/WinAPI 调用）

\`\`\`rust
let app_cache_snapshot = app_name_cache.clone(); // 每帧克隆
let result = tokio::task::spawn_blocking(move || {
    let windows = crate::platform::list_windows()?; // 每帧枚举所有窗口
    ...
}).await;
\`\`\`

## 优化方向

1. 用 \`Arc<Mutex<HashMap>>\` 替代克隆，spawn_blocking 内通过锁读取。
2. 缓存上一帧的前台窗口 ID，只在 \`list_windows()\` 检测到前台变化时才重新查询。`,
    },
    {
      title: 'perf(ax-tree): AX 属性名称字符串（CFString）在每次树遍历时重复分配',
      body: `## 问题

\`crates/tday-nativecore/src/platform/macos/ax.rs\` L507, L514–515

\`ax_children\`、\`get_string\`、\`get_bool\`、\`get_ax_value\` 等辅助函数每次调用都动态分配一个 \`CFString\`：

\`\`\`rust
unsafe fn get_string(el: AXUIElementRef, attr_name: &str) -> Option<String> {
    let attr = CFString::new(attr_name); // ← 每次调用都分配
    ...
}
\`\`\`

10,000 节点的 AX 树快照，每个节点调用 5–8 次 \`get_string\`/\`get_bool\`，累计约 50,000–80,000 次 CFString 堆分配。

## 优化方向

将常用属性名（\`AXRole\`、\`AXTitle\`、\`AXValue\`、\`AXDescription\`、\`AXEnabled\`、\`AXFocused\`、\`AXChildren\`、\`AXPosition\`、\`AXSize\`）声明为全局 \`lazy_static\` 或 \`once_cell::sync::Lazy<CFString>\`，在进程生命周期内复用。`,
    },
    {
      title: 'perf(history-scanner): readFileSync 读取完整会话文件，但只需要前 150 行',
      body: `## 问题

\`apps/desktop/src/main/agent-history/scanners.ts\` 及 \`apps/desktop/src/main/usage/session-readers/\` 各文件

所有 scanner 都读取完整的 JSONL 文件后再截断：

\`\`\`typescript
const content = readFileSync(filePath, 'utf8'); // 可能几 MB
// ...
for (const line of content.split('\\n')) {
    if (lineIdx++ > MAX_TITLE_SCAN_LINES) break; // 只取前 150 行
}
\`\`\`

Claude-code / Codex 会话文件包含大量工具调用结果和代码内容，单文件可达数 MB。拥有数百个会话的安装，每次历史刷新会将 GB 级数据读入内存再丢弃。

## 优化方向

使用 \`readline.createInterface({ input: fs.createReadStream(filePath) })\` 逐行读取，到达 150 行后调用 \`rl.close()\` 停止，可减少 I/O 量超过 90%。`,
    },
    {
      title: 'perf(session-cache): 脏检测后再次调用 collectFiles()，重复 stat 系统调用',
      body: `## 问题

\`apps/desktop/src/main/usage/session-cache.ts\` L211–218 和 L317–319

\`isAgentDirty\` 已经调用了一次 \`watcher.collectFiles()\` 来获取文件列表，但在 dirty 分支中重新扫描后，又调用了一次来更新水印：

\`\`\`typescript
// L211-218 - 第一次
function isAgentDirty(watcher, index) {
  const files = watcher.collectFiles(); // stat 所有文件
  ...
}

// L317-319 - 第二次（相同文件）
const files = watcher.collectFiles(); // ← 重复 stat
const { fileCount, maxMtime } = statFiles(files);
\`\`\`

对于有数百个会话文件的代理（如 codex），每次刷新会对同一组文件做两遍 stat 遍历。

## 优化方向

将 \`isAgentDirty\` 改为返回 \`{ dirty: boolean; files: FileWithMtime[] }\`，在 dirty 分支中直接复用已 stat 的文件列表。`,
    },
    {
      title: 'perf(usage-store): computeUsageSummary 每次调用都从磁盘重新读取 pricing.json',
      body: `## 问题

\`apps/desktop/src/main/usage/store.ts\` L38–40, L67–68

\`\`\`typescript
function mergedPricing(): Record<string, ModelPricing> {
  return { ...BUILTIN_PRICING, ...loadUserPricing() }; // 每次都读磁盘
}

export function computeUsageSummary(records: UsageRecord[]): UsageSummary {
  const pricing = mergedPricing(); // ← 触发 readFileSync
  ...
}
\`\`\`

\`queryUsage\`（IPC handler）在每次查询时调用 \`computeUsageSummary\`，每次都通过 \`readFileSync\` 读取 \`~/.tday/pricing.json\`。

## 优化方向

用模块级变量缓存 merged pricing，并监听文件变化（\`fs.watch\`）或在 \`setSetting\` 时失效，避免每次查询都读磁盘。`,
    },
    {
      title: 'perf(usage-store): Math.max(...tsValues) spread 在大记录集下会溢出 V8 函数参数栈',
      body: `## 问题

\`apps/desktop/src/main/usage/store.ts\` L153–154

\`\`\`typescript
const tsValues = records.map((r) => r.ts); // 中间数组
const spanMs = tsValues.length > 1
  ? Math.max(...tsValues) - Math.min(...tsValues) // ← spread
  : 0;
\`\`\`

\`Math.max(...array)\` 通过 spread 将数组元素作为函数参数传入。V8 的函数调用参数上限约为 65,536。当 \`records\` 超过此数量时，会抛出 \`RangeError: Maximum call stack size exceeded\`。

## 优化方向

用 \`reduce\` 或 \`for\` 循环替代 spread：

\`\`\`typescript
let minTs = Infinity, maxTs = -Infinity;
for (const r of records) {
  if (r.ts < minTs) minTs = r.ts;
  if (r.ts > maxTs) maxTs = r.ts;
}
\`\`\`

同时消除中间 \`tsValues\` 数组分配，节省一次 O(n) 遍历。`,
    },
    {
      title: 'perf(usage-store): loadUsageRecords 将完整 usage.jsonl 文件读入内存再过滤',
      body: `## 问题

\`apps/desktop/src/main/usage/store.ts\` L176–193

\`\`\`typescript
const lines = readFileSync(USAGE_FILE, 'utf8').split('\\n').filter(Boolean);
// 然后 for 循环应用 fromTs/toTs/agentId 过滤
\`\`\`

\`usage.jsonl\` 随时间增长（注释说 10,000 次请求 ≈ 1–2 MB），但每次查询都把整个文件读入内存、解析所有行、再丢弃大部分。对于时间范围过滤（如「今天的用量」），绝大多数记录都被丢弃。

## 优化方向

维护一个按时间戳排序的内存索引（行偏移量 → ts），利用二分查找快速定位 fromTs 范围起点，仅读取和解析相关行段。或者对大文件改用流式读取。`,
    },
    {
      title: 'perf(input): stripReasoningContent 对整个输入数组调用 JSON.stringify 来检查字段是否存在',
      body: `## 问题

\`apps/desktop/src/main/gateway/bridge/input.ts\` L236–246

\`\`\`typescript
export function stripReasoningContent(input: unknown): unknown {
  if (!Array.isArray(input)) return input;
  const str = JSON.stringify(input);                       // ← 序列化整个对话历史
  if (!str.includes('reasoning_content')) return input;   // 只是检查字段是否存在
  return input.map((item) => { ... });
}
\`\`\`

对话历史可能包含数十轮消息和大段代码/工具输出，但这里只是想检查是否有 \`reasoning_content\` 字段。序列化整个数组只是为了一个字符串包含检查。

## 优化方向

\`\`\`typescript
if (!Array.isArray(input) || !input.some(
  (item) => item && typeof item === 'object' && 'reasoning_content' in item
)) return input;
\`\`\`

完全消除 \`JSON.stringify\`，直接对象属性检查，早退性能更好。`,
    },
    {
      title: 'perf(thinking-state): ThinkingState.prune() 使用 O(n) 的 Array.shift()，每次驱逐开销为线性',
      body: `## 问题

\`apps/desktop/src/main/gateway/deepseek/state.ts\` L114–123

\`\`\`typescript
private prune(): void {
  while (this.recordOrder.length > this.limit) {
    const id = this.recordOrder.shift()!; // O(n) 数组左移
    this.records.delete(id);
  }
  while (this.textOrder.length > this.limit) {
    const key = this.textOrder.shift()!;  // O(n)
    this.textRecords.delete(key);
  }
}
\`\`\`

\`Array.shift()\` 是 O(n) 操作，每次插入新条目时都要移动整个数组。默认 limit 为 1024，在频繁工具调用场景下频繁触发。

## 优化方向

用循环索引（ring buffer）或 \`index: number\` 指针替代 \`shift()\`，将 prune 降为 O(1)。或使用双端队列（如 \`denque\` 包）。`,
    },
    {
      title: 'perf(adapter): CodexDeepSeekAnthropicAdapter.conversations Map 无限增长，缺少 LRU 驱逐',
      body: `## 问题

\`apps/desktop/src/main/gateway/adapter.ts\` L64–65

\`\`\`typescript
export class CodexDeepSeekAnthropicAdapter implements GatewayAdapter {
  private readonly conversations = new Map<string, AMessage[]>(); // 永不清理
  private readonly thinkingStates = new Map<string, ThinkingState>();
}
\`\`\`

每次新请求的 \`responseId\` 都被存入 \`conversations\`，但从不驱逐。长时间运行的 Codex 会话（数百轮）会将每个 \`previous_response_id\` 的完整消息历史都保留在内存中，导致 Node.js 进程内存持续增长。\`thinkingStates\` 同理。

## 优化方向

对两个 Map 都加上 LRU 驱逐（例如 limit=500 条）。可使用 Map 的插入顺序特性自行实现，或引入 \`lru-cache\` 包。`,
    },
    {
      title: 'perf(agent-history): isDirty 中使用 Math.max(...files.map(...)) spread，大量会话时可能栈溢出',
      body: `## 问题

\`apps/desktop/src/main/agent-history/index.ts\` L120

\`\`\`typescript
const maxMtime = files.length > 0
  ? Math.max(...files.map((f) => f.mtime)) // ← spread of potentially large array
  : 0;
\`\`\`

与 \`usage/store.ts\` 的同类问题一致：\`Math.max(...array)\` 通过 spread 传参，当 files 数组超过 ~65,536 时（大型 Codex 安装）会抛出 \`RangeError\`。

## 优化方向

\`\`\`typescript
const maxMtime = files.reduce((m, f) => f.mtime > m ? f.mtime : m, 0);
\`\`\`

同时消除中间 \`map\` 数组分配。同一模式在 \`session-cache.ts\` L318 中也存在，应一并修复。`,
    },
    {
      title: 'perf(history-store): saveStore 使用 JSON.stringify 带 2 空格缩进，导致文件体积翻倍',
      body: `## 问题

\`apps/desktop/src/main/agent-history/store.ts\` L78

\`\`\`typescript
export function saveStore(store: HistoryStore): void {
  writeFileSync(INDEX_TMP, JSON.stringify(store, null, 2), 'utf8'); // pretty-print
  ...
}
\`\`\`

每次历史刷新完成后都将整个历史索引以带 2 空格缩进的格式序列化后写盘。对于数百条历史条目，pretty-print 会导致文件体积增大 30–50%，写盘时间增加（更多字节）且内存中持有更大的字符串。

## 优化方向

改为 \`JSON.stringify(store)\`（无缩进）。历史索引是机器读取的，人类可读性不重要。\`settings-store.ts\` 相关的写盘如果也有 \`null, 2\`，也应一并优化。`,
    },
  ];

  for (const issue of issues) {
    await createIssue(issue.title, issue.body);
  }
  console.log('Done.');
};
