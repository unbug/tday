import { memo, useMemo } from 'react';
import { marked } from 'marked';

marked.setOptions({ breaks: true });

export function MiniMarkdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => marked.parse(text) as string, [text]);
  return (
    <div
      className={`prose-mini ${className ?? ''}`}
      // eslint-disable-next-line react/no-danger
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

export function SectionTab({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-t px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${
        active
          ? 'bg-zinc-800 text-zinc-100'
          : 'text-zinc-500 hover:text-zinc-300'
      }`}
    >
      {children}
    </button>
  );
}

export const StyleToggle = memo(function StyleToggle({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex-1 rounded-md border px-3 py-1.5 text-[11px] transition-colors ${
        active
          ? 'border-fuchsia-500/60 bg-fuchsia-500/15 text-fuchsia-200'
          : 'border-zinc-800 bg-zinc-900/40 text-zinc-400 hover:border-zinc-700 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  );
});

export const Field = memo(function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="mb-1 block text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </span>
      {children}
    </label>
  );
});

export function fmtNum(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return String(n);
}

export function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="rounded-md border border-zinc-800/60 bg-zinc-900/60 p-3 text-center">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="mt-1 text-lg font-semibold text-zinc-100">{value}</div>
      {sub ? <div className="mt-0.5 text-[10px] text-zinc-500">{sub}</div> : null}
    </div>
  );
}

export function DailyBarChart({
  data,
}: {
  data: Array<{ date: string; inputTokens: number; outputTokens: number }>;
}) {
  const maxTokens = Math.max(...data.map((d) => d.inputTokens + d.outputTokens), 1);
  const barW = Math.max(4, Math.floor(720 / data.length) - 2);
  const chartH = 60;
  return (
    <div className="overflow-x-auto">
      <svg
        width={data.length * (barW + 2)}
        height={chartH + 18}
        className="block"
        style={{ minWidth: '100%' }}
      >
        {data.map((d, i) => {
          const total = d.inputTokens + d.outputTokens;
          const totalH = Math.round((total / maxTokens) * chartH);
          const inputH = Math.round((d.inputTokens / maxTokens) * chartH);
          const outputH = totalH - inputH;
          const x = i * (barW + 2);
          return (
            <g key={d.date}>
              {outputH > 0 && (
                <rect
                  x={x}
                  y={chartH - totalH}
                  width={barW}
                  height={outputH}
                  fill="#a78bfa"
                  opacity={0.7}
                />
              )}
              {inputH > 0 && (
                <rect
                  x={x}
                  y={chartH - inputH}
                  width={barW}
                  height={inputH}
                  fill="#c084fc"
                  opacity={0.9}
                />
              )}
              {i % Math.ceil(data.length / 8) === 0 ? (
                <text
                  x={x + barW / 2}
                  y={chartH + 13}
                  fontSize={8}
                  fill="#71717a"
                  textAnchor="middle"
                >
                  {d.date.slice(5)}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex items-center gap-3 text-[10px] text-zinc-500">
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-fuchsia-400/90" />
          Input
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-sm bg-violet-400/70" />
          Output
        </span>
      </div>
    </div>
  );
}
