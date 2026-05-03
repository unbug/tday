export type Section = 'providers' | 'agents' | 'usage' | 'history' | 'cron';
export type UsageDateMode = 'today' | '7d' | '30d' | '90d' | 'custom';

export type SchedMode = 'interval' | 'at' | 'cron';
export type IntervalUnit = 'min' | 'hour' | 'day';
export type AtRepeat = 'daily' | 'weekdays' | 'weekly' | 'monthly';

export interface SchedState {
  mode: SchedMode;
  intervalVal: number;
  intervalUnit: IntervalUnit;
  atHour: number;
  atMin: number;
  atRepeat: AtRepeat;
  atWeekday: number;
  atMonthDay: number;
  customExpr: string;
}

export const DEFAULT_SCHED: SchedState = {
  mode: 'interval',
  intervalVal: 30,
  intervalUnit: 'min',
  atHour: 9,
  atMin: 0,
  atRepeat: 'daily',
  atWeekday: 1,
  atMonthDay: 1,
  customExpr: '0 9 * * *',
};
