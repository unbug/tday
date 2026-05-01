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
