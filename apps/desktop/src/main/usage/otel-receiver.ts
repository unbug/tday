/**
 * Minimal OTLP/HTTP/JSON log receiver for claude-code telemetry.
 *
 * claude-code supports OpenTelemetry (OTel) natively. When we inject:
 *   CLAUDE_CODE_ENABLE_TELEMETRY=1
 *   OTEL_LOGS_EXPORTER=otlp
 *   OTEL_EXPORTER_OTLP_PROTOCOL=http/json
 *   OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:<port>
 *
 * claude-code will POST `claude_code.api_request` log events to
 * /v1/logs after each API call, containing model + token counts.
 *
 * This is the official, zero-proxy, zero-overhead way to track usage
 * for claude-code — works for ANY provider it talks to (Anthropic,
 * Bedrock, Vertex, local ollama, etc.).
 *
 * Reference: https://code.claude.com/docs/en/monitoring-usage
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

// ─── OTLP/HTTP/JSON payload types (minimal subset we need) ───────────────────

interface OtelAttrValue {
  stringValue?: string;
  /** int64 is serialized as a string in protobuf JSON, but some SDKs send a number */
  intValue?: string | number;
  doubleValue?: number;
}

interface OtelAttr {
  key: string;
  value: OtelAttrValue;
}

interface OtelLogRecord {
  attributes?: OtelAttr[];
}

interface OtelExportLogsRequest {
  resourceLogs?: Array<{
    scopeLogs?: Array<{
      logRecords?: OtelLogRecord[];
    }>;
  }>;
}

// ─── Public API ───────────────────────────────────────────────────────────────

export interface OtelApiRequestEvent {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
}

export interface OtelReceiverHandle {
  /** The port the server is listening on (random ephemeral port on 127.0.0.1) */
  port: number;
  /** Stop the server */
  close(): void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function strAttr(attrs: OtelAttr[] | undefined, key: string): string | undefined {
  return attrs?.find(a => a.key === key)?.value?.stringValue;
}

function numAttr(attrs: OtelAttr[] | undefined, key: string): number {
  const v = attrs?.find(a => a.key === key)?.value;
  if (!v) return 0;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return Math.round(v.doubleValue);
  return 0;
}

// ─── Receiver factory ─────────────────────────────────────────────────────────

/**
 * Start a local OTLP/HTTP/JSON receiver on a random ephemeral port.
 * Calls `onApiRequest` for each `claude_code.api_request` log event received.
 */
export function createOtelReceiver(
  onApiRequest: (event: OtelApiRequestEvent) => void,
): Promise<OtelReceiverHandle> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      // Only accept POST (the OTel SDK always POSTs)
      if (req.method !== 'POST') {
        res.writeHead(405).end();
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const payload = JSON.parse(
            Buffer.concat(chunks).toString('utf8'),
          ) as OtelExportLogsRequest;

          for (const rl of payload.resourceLogs ?? []) {
            for (const sl of rl.scopeLogs ?? []) {
              for (const lr of sl.logRecords ?? []) {
                if (strAttr(lr.attributes, 'event.name') === 'claude_code.api_request') {
                  const inputTokens = numAttr(lr.attributes, 'input_tokens');
                  const outputTokens = numAttr(lr.attributes, 'output_tokens');
                  // Only emit if there's actual usage data
                  if (inputTokens > 0 || outputTokens > 0) {
                    onApiRequest({
                      model: strAttr(lr.attributes, 'model') ?? '',
                      inputTokens,
                      outputTokens,
                      cacheReadTokens: numAttr(lr.attributes, 'cache_read_tokens'),
                      cacheCreationTokens: numAttr(lr.attributes, 'cache_creation_tokens'),
                    });
                  }
                }
              }
            }
          }
        } catch {
          // Ignore malformed payloads — never crash the main process
        }

        // Always respond 200 so the OTel SDK doesn't retry
        res.writeHead(200, { 'Content-Type': 'application/json' }).end('{}');
      });
    });

    server.on('error', reject);

    // Listen on a random port on loopback only
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        reject(new Error('[tday] OTel receiver: failed to get bound address'));
        return;
      }
      resolve({
        port: addr.port,
        close() {
          server.close();
        },
      });
    });
  });
}
