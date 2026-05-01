/**
 * Anthropic HTTP client + SSE parser.
 */

import type { ARequest, AStreamEvent } from './types.js';

/** POST a request to the Anthropic Messages API. */
export async function callAnthropic(
  url: string,
  apiKey: string,
  version: string,
  body: ARequest,
): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': version || '2023-06-01',
    },
    body: JSON.stringify(body),
  });
}

/**
 * Parse a raw Anthropic SSE stream (collected as a string) into structured events.
 * Anthropic's wire format: `event: <type>\ndata: <json>\n\n`
 */
export function parseAnthropicSseEvents(text: string): AStreamEvent[] {
  const events: AStreamEvent[] = [];
  const lines = text.split('\n');
  let eventType = '';
  let dataLines: string[] = [];

  const flush = () => {
    if (!dataLines.length) return;
    const json = dataLines.join('\n');
    dataLines = [];
    try {
      const e = JSON.parse(json) as AStreamEvent;
      // Some events carry their type only in the `event:` line
      if (!e.type && eventType) e.type = eventType;
      events.push(e);
    } catch {
      // Malformed data line — ignore
    }
    eventType = '';
  };

  for (const line of lines) {
    if (line === '') { flush(); continue; }
    if (line.startsWith('event:')) { eventType = line.slice(6).trim(); continue; }
    if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
  }
  flush(); // handle any trailing block without trailing empty line
  return events;
}

/**
 * Incremental SSE parser for real-time streaming.
 * Feed raw text chunks via `push()`; each call returns any complete events
 * that could be parsed from the data received so far.
 * Call `end()` when the stream closes to flush any remaining buffered data.
 */
export class SseParser {
  private buf = '';
  private eventType = '';
  private dataLines: string[] = [];

  push(chunk: string): AStreamEvent[] {
    this.buf += chunk;
    const events: AStreamEvent[] = [];
    const lines = this.buf.split('\n');
    // The last element may be an incomplete line — keep it in the buffer.
    this.buf = lines.pop() ?? '';
    for (const line of lines) {
      if (line === '') {
        const ev = this.flushBlock();
        if (ev) events.push(ev);
        continue;
      }
      if (line.startsWith('event:')) { this.eventType = line.slice(6).trim(); continue; }
      if (line.startsWith('data:')) this.dataLines.push(line.slice(5).trim());
    }
    return events;
  }

  /** Flush any data remaining after the stream has closed. */
  end(): AStreamEvent[] {
    const events: AStreamEvent[] = [];
    if (this.buf) {
      const line = this.buf;
      this.buf = '';
      if (line.startsWith('data:')) this.dataLines.push(line.slice(5).trim());
    }
    const ev = this.flushBlock();
    if (ev) events.push(ev);
    return events;
  }

  private flushBlock(): AStreamEvent | null {
    if (!this.dataLines.length) { this.eventType = ''; return null; }
    const json = this.dataLines.join('\n');
    this.dataLines = [];
    const eventType = this.eventType;
    this.eventType = '';
    try {
      const e = JSON.parse(json) as AStreamEvent;
      if (!e.type && eventType) e.type = eventType;
      return e;
    } catch {
      return null;
    }
  }
}
