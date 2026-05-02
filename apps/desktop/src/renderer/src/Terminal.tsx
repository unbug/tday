import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { AgentId } from '@tday/shared';

interface Props {
  tabId: string;
  agentId: AgentId;
  cwd?: string;
  /** Whether this tab is currently visible. */
  active?: boolean;
  /** Agent-native session ID — passed as --resume / --session on spawn to resume prior conversation. */
  agentSessionId?: string;
  /**
   * Called after the agent process exits with the discovered session ID for
   * this cwd, so App.tsx can store it on the Tab for future restores.
   */
  onAgentSessionId?: (id: string | null) => void;
}

// Agents that support native session resume.
const RESUME_CAPABLE: AgentId[] = ['claude-code', 'codex', 'opencode'];

export function Terminal({ tabId, agentId, cwd, active, agentSessionId, onAgentSessionId }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const spawnedRef = useRef(false);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  // Keep latest callbacks in refs so cleanup can read without re-running effects.
  const sessionIdRef = useRef(onAgentSessionId);
  sessionIdRef.current = onAgentSessionId;

  useEffect(() => {
    if (!containerRef.current || spawnedRef.current) return;
    spawnedRef.current = true;

    const term = new XTerm({
      fontFamily:
        'ui-monospace, SFMono-Regular, Menlo, Monaco, "Cascadia Mono", "Roboto Mono", monospace',
      fontSize: 13,
      theme: {
        background: '#000000',
        foreground: '#e4e4e7',
        cursor: '#a78bfa',
      },
      cursorBlink: true,
      allowProposedApi: true,
      scrollback: 10_000,
    });
    const fit = new FitAddon();
    const serialize = new SerializeAddon();
    term.loadAddon(fit);
    term.loadAddon(serialize);
    term.loadAddon(new WebLinksAddon());
    term.open(containerRef.current);
    fit.fit();
    term.focus();
    termRef.current = term;
    fitRef.current = fit;

    const off1 = window.tday.onData((e) => {
      if (e.tabId === tabId) term.write(e.data);
    });
    const off2 = window.tday.onExit((e) => {
      if (e.tabId === tabId) {
        term.writeln(`\r\n\x1b[2m[process exited code=${e.exitCode ?? '?'}]\x1b[0m`);
        // After the agent exits, discover its latest native session ID so we
        // can resume the conversation on next open.
        if (RESUME_CAPABLE.includes(agentId) && cwd) {
          void window.tday.latestAgentSession(agentId, cwd).then((id) => {
            sessionIdRef.current?.(id);
          });
        }
      }
    });

    const dataDisp = term.onData((data) => {
      void window.tday.write(tabId, data);
    });

    const onResize = () => {
      fit.fit();
      void window.tday.resize(tabId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    // Async init: render history (if resuming) then spawn.
    const init = async () => {
      // If we have a session ID, load and render the conversation history
      // so the user sees it immediately before the agent starts.
      if (agentSessionId && RESUME_CAPABLE.includes(agentId) && cwd) {
        try {
          const msgs = await window.tday.readAgentSession(agentId, agentSessionId, cwd);
          if (msgs.length > 0) {
            const bar = '\x1b[2m' + '─'.repeat(56) + '\x1b[0m';
            term.writeln(bar);
            term.writeln(`\x1b[2m  conversation history · ${msgs.length} turns\x1b[0m`);
            term.writeln(bar);
            for (const msg of msgs) {
              const prefix =
                msg.role === 'user'
                  ? '\x1b[36;1m  You: \x1b[0m'
                  : '\x1b[32;1m  AI:  \x1b[0m';
              // Truncate very long messages, wrap newlines.
              const body = msg.text.length > 500 ? msg.text.slice(0, 497) + '…' : msg.text;
              const lines = body.split('\n');
              term.writeln(prefix + (lines[0] ?? ''));
              for (const ln of lines.slice(1)) {
                if (ln.trim()) term.writeln('        ' + ln);
              }
            }
            term.writeln(bar + '\r\n');
          }
        } catch {
          // History rendering is best-effort; don't block spawn.
        }
      }

      await window.tday
        .spawn({
          tabId,
          agentId,
          cwd,
          cols: term.cols,
          rows: term.rows,
          agentSessionId,
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          term.writeln(`\x1b[31mfailed to spawn:\x1b[0m ${msg}`);
          term.writeln(
            `\x1b[2mset ~/.tday/agents.json → { "agents": { "${agentId}": { "bin": "/absolute/path/to/${agentId === 'claude-code' ? 'claude' : agentId === 'copilot' ? 'copilot' : agentId}" } } }\x1b[0m`,
          );
        });
    };

    void init();

    return () => {
      ro.disconnect();
      dataDisp.dispose();
      off1();
      off2();
      void window.tday.kill(tabId);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whenever the tab becomes active, refit and steal focus.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    const raf = requestAnimationFrame(() => {
      try {
        fit?.fit();
        void window.tday.resize(tabId, term.cols, term.rows);
      } catch {
        // ignore — element may have unmounted
      }
      term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [active, tabId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
