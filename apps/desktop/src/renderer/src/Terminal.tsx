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
  /**
   * If set, this text is sent to the PTY automatically ~1.5 s after the
   * agent spawns (giving the agent time to print its initial UI).
   * A carriage-return is appended so the agent processes the command.
   */
  initialPrompt?: string;
  /** True when opened by the cron scheduler — agents use batch/non-interactive mode. */
  isCronJob?: boolean;
  /** CoWorker id to apply — system prompt is prepended to initialPrompt at spawn. */
  coworkerId?: string;
  /** Provider profile id override — overrides the agent's default binding for this tab. */
  providerId?: string;
  /** Per-tab model override — overrides the provider profile's default model. */
  modelId?: string;
}

// Agents that support native session resume.
const RESUME_CAPABLE: AgentId[] = ['claude-code', 'codex', 'opencode', 'deepseek-tui'];

export function Terminal({ tabId, agentId, cwd, active, agentSessionId, onAgentSessionId, initialPrompt, isCronJob, coworkerId, providerId, modelId }: Props) {
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
      // Skip when container is hidden (display:none). FitAddon.fit() is a no-op
      // for zero-width elements, so term.cols retains stale dims — sending
      // resize would fire a spurious SIGWINCH with wrong dimensions.
      if (!containerRef.current || containerRef.current.offsetWidth === 0) return;
      fit.fit();
      void window.tday.resize(tabId, term.cols, term.rows);
    };
    const ro = new ResizeObserver(onResize);
    ro.observe(containerRef.current);

    // Async init: render history (if resuming) then spawn.
    const init = async () => {
      // Wait one animation frame so xterm.js's canvas renderer can compute
      // font metrics. Without this, FitAddon.fit() may be a no-op (returning
      // undefined because actualCellWidth === 0), leaving term.cols at the
      // default 80. Claude-code (Ink) reads process.stdout.columns at startup
      // from the PTY window size — if we spawn with cols=80 it wraps there.
      await new Promise<void>((res) => requestAnimationFrame(() => { fit.fit(); res(); }));

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

      const spawnCols = term.cols;
      const spawnRows = term.rows;
      const isWindows = window.tday.platform === 'win32';
      await window.tday
        .spawn({
          tabId,
          agentId,
          cwd,
          cols: spawnCols,
          rows: spawnRows,
          agentSessionId,
          // Pass the initial prompt to the main process so it can either
          // supply it as a CLI argument (for agents that support positional
          // task args) or write it directly to the PTY after a grace period.
          // Either way the write happens entirely in the main process, which
          // runs independently of the renderer's visibility state, making it
          // reliable even when the screen is locked.
          initialPrompt: initialPrompt || undefined,
          isCronJob: isCronJob || undefined,
          coworkerId: coworkerId || undefined,
          providerId: providerId || undefined,
          modelId: modelId || undefined,
        })
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          term.writeln(`\x1b[31mfailed to spawn:\x1b[0m ${msg}`);
          term.writeln(
            `\x1b[2mset ~/.tday/agents.json → { "agents": { "${agentId}": { "bin": "/absolute/path/to/${agentId === 'claude-code' ? 'claude' : agentId === 'copilot' ? 'copilot' : agentId}" } } }\x1b[0m`,
          );
          if (isWindows) {
            term.writeln(
              `\x1b[33m\u2139\uFE0F Windows tip:\x1b[0m \x1b[2mMake sure the agent binary is on your PATH.` +
              ` If installed via npm, try running \`npm install -g ${agentId}\` in a terminal,` +
              ` then restart Tday.  See the README for Windows PATH setup.\x1b[0m`,
            );
          }
        });

      // Re-sync only if the terminal was resized while waiting for spawn.
      // Avoid sending an unnecessary SIGWINCH (which can disrupt claude-code's
      // session initialization) when cols/rows haven't actually changed.
      fit.fit();
      if (term.cols !== spawnCols || term.rows !== spawnRows) {
        void window.tday.resize(tabId, term.cols, term.rows);
      }
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

  // Whenever the tab becomes active, steal focus.
  // Resize is intentionally omitted here: the ResizeObserver on containerRef
  // already fires when display:none → display:block, which covers tab switches.
  // Sending resize here as well would deliver a duplicate SIGWINCH to the PTY
  // (e.g. claude-code / Ink) right during session initialisation, causing it
  // to re-render its startup UI and appear to start a new session.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    if (!term) return;
    const raf = requestAnimationFrame(() => {
      try {
        term.focus();
      } catch {
        // ignore — element may have unmounted
      }
    });
    return () => cancelAnimationFrame(raf);
  }, [active, tabId]);

  return <div ref={containerRef} className="h-full w-full" />;
}
