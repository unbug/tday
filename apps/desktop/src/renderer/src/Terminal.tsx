import { useEffect, useRef } from 'react';
import { Terminal as XTerm } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { AgentId } from '@tday/shared';

interface Props {
  tabId: string;
  agentId: AgentId;
  cwd?: string;
  /** Whether this tab is currently visible. When toggled true, the terminal
   *  refocuses + refits so users can immediately type without clicking. */
  active?: boolean;
}

export function Terminal({ tabId, agentId, cwd, active }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const spawnedRef = useRef(false);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);

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
    term.loadAddon(fit);
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
      }
    });

    void window.tday
      .spawn({
        tabId,
        agentId,
        cwd,
        cols: term.cols,
        rows: term.rows,
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        term.writeln(`\x1b[31mfailed to spawn:\x1b[0m ${msg}`);
        term.writeln(
          '\x1b[2mset ~/.tday/agents.json → { "agents": { "pi": { "bin": "/path/to/pi" } } }\x1b[0m',
        );
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

  // Whenever the tab becomes active, refit (the size could have changed
  // while it was hidden) and steal focus so the user can type immediately.
  useEffect(() => {
    if (!active) return;
    const term = termRef.current;
    const fit = fitRef.current;
    if (!term) return;
    // Defer to next frame so the display:block transition has settled and
    // the container has its real dimensions.
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
