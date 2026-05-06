/**
 * Tday Computer Use — pi extension bridge
 *
 * Loaded by pi via `--extension /path/to/this/file.ts` when Computer Use is
 * enabled. Spawns the bundled `tday-devtools` MCP server, negotiates the MCP
 * handshake, lists all available tools, and registers each one with pi.
 *
 * Environment variables (set by tday before spawning pi):
 *   TDAY_DEVTOOLS_BIN  — absolute path to the tday-devtools binary
 */

// `import type` is erased by jiti at load time — no runtime module required.
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

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

export default async function (pi: ExtensionAPI) {
  const binary = process.env["TDAY_DEVTOOLS_BIN"];
  if (!binary) {
    console.error("[tday-pi-bridge] TDAY_DEVTOOLS_BIN not set — Computer Use disabled");
    return;
  }

  // ── Spawn MCP server ────────────────────────────────────────────────────────
  const proc = spawn(binary, [], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env },
  });

  proc.on("error", (err) => {
    console.error("[tday-pi-bridge] failed to start tday-devtools:", err.message);
  });

  // ── JSON-RPC over stdio ─────────────────────────────────────────────────────
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

  // ── MCP handshake ───────────────────────────────────────────────────────────
  try {
    await rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "tday-pi-bridge", version: "1.0.0" },
    });
    notify("notifications/initialized", {});
  } catch (err) {
    console.error("[tday-pi-bridge] MCP initialize failed:", err);
    proc.kill();
    return;
  }

  // ── List and register tools ─────────────────────────────────────────────────
  let mcpTools: McpTool[] = [];
  try {
    const result = await rpc("tools/list", {}) as { tools?: McpTool[] };
    mcpTools = result.tools ?? [];
  } catch (err) {
    console.error("[tday-pi-bridge] tools/list failed:", err);
    proc.kill();
    return;
  }

  for (const tool of mcpTools) {
    const toolName = tool.name;
    // Pass raw JSON Schema as parameters — pi/typebox accepts it at runtime.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schema = (tool.inputSchema ?? { type: "object", properties: {} }) as any;

    pi.registerTool({
      name: toolName,
      label: toolName,
      description: tool.description ?? toolName,
      parameters: schema,
      async execute(_toolCallId, params) {
        const result = await rpc("tools/call", { name: toolName, arguments: params }) as {
          content?: McpContent[];
          isError?: boolean;
        };
        const content: McpContent[] = result.content ?? [{ type: "text", text: "(no output)" }];

        // Map MCP content blocks to pi content blocks.
        // pi accepts text and image (base64) blocks in tool results.
        const piContent = content.map((c) => {
          if (c.type === "text") {
            return { type: "text" as const, text: c.text ?? "" };
          }
          if (c.type === "image" && c.data && c.mimeType) {
            // Anthropic/OpenAI-style base64 image in tool result
            return {
              type: "image" as const,
              source: { type: "base64" as const, media_type: c.mimeType as "image/jpeg" | "image/png" | "image/gif" | "image/webp", data: c.data },
            } as unknown as { type: "text"; text: string };
          }
          return { type: "text" as const, text: c.text ?? "(binary content)" };
        });

        return { content: piContent, details: {} };
      },
    });
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────────
  process.on("exit", () => {
    try { proc.kill("SIGTERM"); } catch { /* already dead */ }
  });
}
