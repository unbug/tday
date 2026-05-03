import { useEffect, useState } from 'react';
import {
  type SchedState,
  type SchedMode,
  type IntervalUnit,
  type AtRepeat,
} from './types';
import { parseCronSchedule, buildCronExpr, describeCronExpr, WEEKDAY_LABEL } from './cron-helpers';

interface Props {
  value: string;
  onChange: (expr: string) => void;
}

export function ScheduleWidget({ value, onChange }: Props) {
  const [s, setS] = useState<SchedState>(() => parseCronSchedule(value));

  // Re-parse when the editor opens a different job.
  useEffect(() => {
    setS(parseCronSchedule(value));
  }, [value]);

  const update = (patch: Partial<SchedState>) => {
    const next = { ...s, ...patch };
    setS(next);
    onChange(buildCronExpr(next));
  };

  const modeBtn = (m: SchedMode, label: string) => (
    <button
      key={m}
      onClick={() => update({ mode: m })}
      className={`rounded px-2.5 py-1 text-[11px] transition-colors ${
        s.mode === m
          ? 'bg-fuchsia-500/25 text-fuchsia-200'
          : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-2">
      {/* Mode tabs */}
      <div className="flex gap-1">
        {modeBtn('interval', 'Interval')}
        {modeBtn('at', 'At time')}
        {modeBtn('cron', 'Custom')}
      </div>

      {s.mode === 'interval' && (
        <div className="flex items-center gap-2">
          <span className="text-zinc-500">Every</span>
          <input
            type="number"
            min={1}
            className="input w-16 text-center"
            value={s.intervalVal}
            onChange={(e) =>
              update({ intervalVal: Math.max(1, parseInt(e.target.value, 10) || 1) })
            }
          />
          <select
            className="input w-24"
            value={s.intervalUnit}
            onChange={(e) => update({ intervalUnit: e.target.value as IntervalUnit })}
          >
            <option value="min">minutes</option>
            <option value="hour">hours</option>
            <option value="day">days</option>
          </select>
        </div>
      )}

      {s.mode === 'at' && (
        <div className="space-y-1.5">
          <div className="flex items-center gap-2">
            <span className="text-zinc-500">Time</span>
            <input
              type="number"
              min={0}
              max={23}
              className="input w-14 text-center"
              value={s.atHour}
              onChange={(e) =>
                update({ atHour: Math.min(23, Math.max(0, parseInt(e.target.value, 10) || 0)) })
              }
            />
            <span className="text-zinc-600">:</span>
            <input
              type="number"
              min={0}
              max={59}
              className="input w-14 text-center"
              value={s.atMin}
              onChange={(e) =>
                update({ atMin: Math.min(59, Math.max(0, parseInt(e.target.value, 10) || 0)) })
              }
            />
          </div>
          <div className="flex flex-wrap gap-1">
            {(['daily', 'weekdays', 'weekly', 'monthly'] as AtRepeat[]).map((r) => (
              <button
                key={r}
                onClick={() => update({ atRepeat: r })}
                className={`rounded px-2 py-0.5 text-[10px] transition-colors ${
                  s.atRepeat === r
                    ? 'bg-fuchsia-500/25 text-fuchsia-200'
                    : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                }`}
              >
                {r === 'daily'
                  ? 'Daily'
                  : r === 'weekdays'
                  ? 'Weekdays'
                  : r === 'weekly'
                  ? 'Weekly'
                  : 'Monthly'}
              </button>
            ))}
          </div>
          {s.atRepeat === 'weekly' && (
            <div className="flex gap-1">
              {WEEKDAY_LABEL.map((label, i) => (
                <button
                  key={i}
                  onClick={() => update({ atWeekday: i })}
                  className={`rounded px-1.5 py-0.5 text-[10px] transition-colors ${
                    s.atWeekday === i
                      ? 'bg-fuchsia-500/25 text-fuchsia-200'
                      : 'bg-zinc-800 text-zinc-400 hover:bg-zinc-700'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          )}
          {s.atRepeat === 'monthly' && (
            <div className="flex items-center gap-2">
              <span className="text-zinc-500">Day</span>
              <input
                type="number"
                min={1}
                max={31}
                className="input w-14 text-center"
                value={s.atMonthDay}
                onChange={(e) =>
                  update({
                    atMonthDay: Math.min(31, Math.max(1, parseInt(e.target.value, 10) || 1)),
                  })
                }
              />
              <span className="text-zinc-500">of the month</span>
            </div>
          )}
        </div>
      )}

      {s.mode === 'cron' && (
        <div className="space-y-2">
          <div>
            <label className="mb-1 block text-[10px] text-zinc-500">
              Pick a date &amp; time (auto-fills expression)
            </label>
            <input
              type="datetime-local"
              className="input-date w-full"
              onChange={(e) => {
                if (!e.target.value) return;
                const d = new Date(e.target.value);
                const expr = `${d.getMinutes()} ${d.getHours()} ${d.getDate()} ${d.getMonth() + 1} *`;
                update({ customExpr: expr });
              }}
            />
          </div>
          <div>
            <label className="mb-1 block text-[10px] text-zinc-500">
              Or type a cron expression directly
            </label>
            <input
              className="input w-full font-mono"
              placeholder="0 9 * * 1-5"
              value={s.customExpr}
              onChange={(e) => update({ customExpr: e.target.value })}
            />
            <p className="mt-1 text-[10px] text-zinc-600">
              Format: <code>min hour dom month dow</code> — e.g.{' '}
              <code>0 9 * * 1-5</code> = weekdays at 9am
            </p>
          </div>
        </div>
      )}

      {/* Preview */}
      <p className="text-[10px] text-zinc-500">
        Schedule:{' '}
        <span className="text-zinc-300">{describeCronExpr(buildCronExpr(s))}</span>
        <span className="ml-2 font-mono text-zinc-600">{buildCronExpr(s)}</span>
      </p>
    </div>
  );
}
