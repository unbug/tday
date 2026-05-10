/**
 * Tday Computer Use — pi extension bridge
 *
 * Loaded by pi via `--extension /path/to/this/file.ts` when Computer Use is
 * enabled.  Connects to the tday-nativecore MCP server, negotiates the MCP
 * handshake, lists all available tools, and registers each one with pi.
 *
 * Two transport modes (tried in order):
 *   1. HTTP  — TDAY_DEVTOOLS_URL is set → connects to the shared persistent
 *              nativecore HTTP server (all agents share one global RwLock).
 *   2. Stdio — TDAY_DEVTOOLS_BIN is set → spawns a private nativecore process
 *              over stdin/stdout (legacy fallback; each pi session is isolated).
 *
 * Environment variables (set by tday Electron main before spawning pi):
 *   TDAY_DEVTOOLS_URL  — http://127.0.0.1:<port>/mcp  (HTTP mode, preferred)
 *   TDAY_DEVTOOLS_BIN  — absolute path to tday-nativecore binary (stdio fallback)
 */

// `import type` is erased by jiti at load time — no runtime module required.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// ── Shared types ──────────────────────────────────────────────────────────────

interface McpContent {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

interface McpTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

/** Minimal MCP client interface: request (expects a reply) + notify (fire-and-forget). */
interface McpClient {
  rpc(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params: unknown): void;
  dispose(): void;
}

// ── HTTP transport ────────────────────────────────────────────────────────────

/**
 * MCP client that speaks the MCP Streamable-HTTP protocol (POST + SSE).
 * Connects to an already-running nativecore HTTP server.
 * All tool calls from ALL agents and ALL pi sessions funnel through the shared
 * server's RwLock, eliminating AX/CoreGraphics race conditions.
 */
function createHttpClient(url: string): McpClient {
  let reqId = 1;
  // MCP Streamable HTTP is stateful: the server issues a Mcp-Session-Id on the
  // initialize response; all subsequent requests must echo it back so the server
  // routes them to the correct session.  Without this header the server rejects
  // non-initialize requests with HTTP 422 "Unexpected message, expect initialize".
  let sessionId: string | null = null;

  function buildHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      // MCP Streamable HTTP requires both content types in Accept so the server
      // knows we handle both direct JSON and SSE streaming responses.
      "Accept": "application/json, text/event-stream",
    };
    if (sessionId) h["Mcp-Session-Id"] = sessionId;
    return h;
  }

  async function rpc(method: string, params: unknown): Promise<unknown> {
    const id = reqId++;
    const res = await fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    });

    // Capture the session ID from a successful initialize response (headers are
    // always available before the body is consumed).
    if (method === "initialize" && res.ok) {
      const sid = res.headers.get("Mcp-Session-Id");
      if (sid) {
        sessionId = sid;
        console.error(`[tday-pi-bridge/http] session established: ${sid}`);
      }
    }

    if (!res.ok) {
      const body = await res.text().catch(() => "(no body)");
      throw new Error(`[tday-pi-bridge/http] HTTP ${res.status}: ${body}`);
    }

    const contentType = res.headers.get("Content-Type") ?? "";

    if (contentType.includes("text/event-stream")) {
      // SSE response: collect all data lines, find the one with our request id.
      const text = await res.text();
      for (const line of text.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        let msg: { id?: number; result?: unknown; error?: { message?: string } };
        try {
          msg = JSON.parse(line.slice(6)) as typeof msg;
        } catch {
          continue; // malformed SSE data line — skip
        }
        if (msg.id === id) {
          if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
          return msg.result;
        }
      }
      throw new Error(`[tday-pi-bridge/http] No matching response in SSE stream for id=${id}`);
    } else {
      // Direct JSON response
      const msg = await res.json() as { result?: unknown; error?: { message?: string } };
      if (msg.error) throw new Error(msg.error.message ?? JSON.stringify(msg.error));
      return msg.result;
    }
  }

  function notify(method: string, params: unknown): void {
    // Fire-and-forget; errors are silently swallowed since notifications have
    // no reply and a failure here should not abort the session.
    fetch(url, {
      method: "POST",
      headers: buildHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    }).catch((e) => {
      console.warn("[tday-pi-bridge/http] notification send failed:", e);
    });
  }

  // HTTP mode: no persistent resource to dispose — NativecoreService manages
  // the shared process lifecycle from the Electron main process side.
  function dispose(): void { /* no-op */ }

  return { rpc, notify, dispose };
}

// ── Stdio transport ───────────────────────────────────────────────────────────

/**
 * MCP client that spawns a private tday-nativecore stdio process.
 * Legacy fallback when the shared HTTP server is not available.
 */
function createStdioClient(binary: string): McpClient {
  const proc = spawn(binary, [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });

  proc.on("error", (err: Error) => {
    console.error("[tday-pi-bridge/stdio] failed to start tday-nativecore:", err.message);
  });

  let reqId = 1;
  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();

  const rl = createInterface({ input: proc.stdout! });
  rl.on("line", (line: string) => {
    if (!line.trim()) return;
    try {
      const msg = JSON.parse(line) as { id?: number; result?: unknown; error?: { message?: string } };
      if (msg.id != null) {
        const handler = pending.get(msg.id);
        if (handler) {
          pending.delete(msg.id);
          if (msg.error) handler.reject(new Error(msg.error.message ?? JSON.stringify(msg.error)));
          else handler.resolve(msg.result);
        }
      }
    } catch {
      // Non-JSON lines (e.g. server log lines) — ignore.
    }
  });

  function rpc(method: string, params: unknown): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = reqId++;
      pending.set(id, { resolve, reject });
      proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  function notify(method: string, params: unknown): void {
    proc.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  function dispose(): void {
    try { proc.kill("SIGTERM"); } catch { /* already dead */ }
  }

  return { rpc, notify, dispose };
}

// ── Map MCP content → pi content ──────────────────────────────────────────────

function mapMcpContent(content: McpContent[]): Array<{ type: "text"; text: string }> {
  return content.map((c) => {
    if (c.type === "text") {
      return { type: "text" as const, text: c.text ?? "" };
    }
    if (c.type === "image" && c.data && c.mimeType) {
      // pi accepts Anthropic-style base64 image blocks in tool results.
      return {
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: c.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp",
          data: c.data,
        },
      } as unknown as { type: "text"; text: string };
    }
    return { type: "text" as const, text: c.text ?? "(binary content)" };
  });
}

// ── Entry point ───────────────────────────────────────────────────────────────

export default async function (pi: ExtensionAPI) {
  // ── Choose transport ────────────────────────────────────────────────────────
  const httpUrl  = process.env["TDAY_DEVTOOLS_URL"];
  const stdioBin = process.env["TDAY_DEVTOOLS_BIN"];

  let client: McpClient;

  if (httpUrl) {
    console.error(`[tday-pi-bridge] HTTP mode → ${httpUrl}`);
    client = createHttpClient(httpUrl);
  } else if (stdioBin) {
    console.error(`[tday-pi-bridge] stdio mode → ${stdioBin}`);
    client = createStdioClient(stdioBin);
  } else {
    console.error("[tday-pi-bridge] Neither TDAY_DEVTOOLS_URL nor TDAY_DEVTOOLS_BIN is set — Computer Use disabled");
    return;
  }

  // ── MCP handshake ───────────────────────────────────────────────────────────
  try {
    await client.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tday-pi-bridge", version: "1.0.0" },
    });
    client.notify("notifications/initialized", {});
  } catch (err) {
    console.error("[tday-pi-bridge] MCP initialize failed:", err);
    client.dispose();
    return;
  }

  // ── List tools ──────────────────────────────────────────────────────────────
  let mcpTools: McpTool[] = [];
  try {
    const result = await client.rpc("tools/list", {}) as { tools?: McpTool[] };
    mcpTools = result.tools ?? [];
  } catch (err) {
    console.error("[tday-pi-bridge] tools/list failed:", err);
    client.dispose();
    return;
  }

  // ── Register tools with pi ─────────────────────────────────────────────────
  for (const tool of mcpTools) {
    const toolName = tool.name;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = (tool.inputSchema ?? { type: "object", properties: {} }) as any;

    pi.registerTool({
      name: toolName,
      label: toolName,
      description: tool.description ?? toolName,
      parameters: schema,
      async execute(_toolCallId, params) {
        const result = await client.rpc("tools/call", { name: toolName, arguments: params }) as {
          content?: McpContent[];
          isError?: boolean;
        };
        const content = result.content ?? [{ type: "text", text: "(no output)" }];
        return { content: mapMcpContent(content), details: {} };
      },
    });
  }

  // ── Cleanup on process exit (stdio mode only; HTTP is managed externally) ──
  process.on("exit", () => client.dispose());
}
