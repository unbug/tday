interface InstallOverlayProps {
  installPct: number;
  installStatus: string;
  installLog: string;
}

export function InstallOverlay({ installPct, installStatus, installLog }: InstallOverlayProps) {
  return (
    <div className="no-drag border-b border-zinc-800/60 bg-zinc-950/90 px-4 py-2 text-xs text-zinc-300">
      <div className="flex items-center gap-3">
        <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-fuchsia-400" />
        <span>installing @mariozechner/pi-coding-agent</span>
        <span className="text-zinc-500">· {installStatus}</span>
        <span className="ml-auto font-mono text-zinc-400">{installPct}%</span>
      </div>
      <div className="mt-2 h-1 overflow-hidden rounded-full bg-zinc-800">
        <div
          className="h-full bg-gradient-to-r from-fuchsia-500 to-sky-400 transition-all duration-300"
          style={{ width: `${Math.max(2, Math.min(100, installPct))}%` }}
        />
      </div>
      {installLog ? (
        <pre className="mt-1 max-h-12 overflow-hidden font-mono text-[10px] text-zinc-600">
          {installLog.split('\n').slice(-3).join('\n')}
        </pre>
      ) : null}
    </div>
  );
}
