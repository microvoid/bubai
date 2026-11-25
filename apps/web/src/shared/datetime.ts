/**
 * Relative date labels for messages and day groups, ported directly from
 * references/buzz-app/src/shared/datetime.ts.
 */
import { clockHourCycle, clockPreference } from './clock-preference';

let defaultsChecked = false;
let formats:
  | {
      locale: string;
      timeZone: string;
      hourCycle: string | undefined;
      seconds: boolean;
      weekday: Intl.DateTimeFormat;
      weekdayMonthDay: Intl.DateTimeFormat;
      monthDayYear: Intl.DateTimeFormat;
      shortWeekdayMonthDay: Intl.DateTimeFormat;
      shortMonthDayYear: Intl.DateTimeFormat;
      time: Intl.DateTimeFormat;
      full: Intl.DateTimeFormat;
    }
  | undefined;

/** Normalize Unix ms (used by our server) or Unix seconds (used by Buzz) into Unix seconds. */
export function toUnixSeconds(timestamp: number): number {
  return timestamp > 1e12 ? Math.floor(timestamp / 1000) : Math.floor(timestamp);
}

function dateFormats() {
  const hourCycle = clockHourCycle();
  const { seconds } = clockPreference();
  if (
    defaultsChecked &&
    formats &&
    formats.hourCycle === hourCycle &&
    formats.seconds === seconds
  )
    return formats;
  const { locale, timeZone } = new Intl.DateTimeFormat().resolvedOptions();
  if (
    formats?.locale !== locale ||
    formats.timeZone !== timeZone ||
    formats.hourCycle !== hourCycle ||
    formats.seconds !== seconds
  ) {
    const format = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(undefined, options);
    const clock = hourCycle ? { hourCycle } : {};
    formats = {
      locale,
      timeZone,
      hourCycle,
      seconds,
      weekday: format({ weekday: 'long' }),
      weekdayMonthDay: format({
        weekday: 'long',
        month: 'long',
        day: 'numeric',
      }),
      monthDayYear: format({ month: 'long', day: 'numeric', year: 'numeric' }),
      shortWeekdayMonthDay: format({
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }),
      shortMonthDayYear: format({
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      }),
      time: format({
        hour: 'numeric',
        minute: '2-digit',
        ...(seconds ? { second: '2-digit' } : {}),
        ...clock,
      }),
      full: format({ dateStyle: 'full', timeStyle: 'long', ...clock }),
    };
  }
  defaultsChecked = true;
  queueMicrotask(() => {
    defaultsChecked = false;
  });
  return formats;
}

const days = new Map<number, string>();
let daysZone: string | undefined;

export function calendarDay(createdAt: number) {
  const { timeZone } = dateFormats();
  if (timeZone !== daysZone) {
    daysZone = timeZone;
    days.clear();
  }
  let day = days.get(createdAt);
  if (day === undefined) {
    if (days.size >= 8192) days.clear();
    day = new Date(createdAt * 1000).toDateString();
    days.set(createdAt, day);
  }
  return day;
}

const WEEKDAY_BAND_DAYS = 7;

export function formatDayGroupLabel(
  unixSeconds: number,
  nowSeconds = Date.now() / 1_000,
): string {
  const date = new Date(unixSeconds * 1_000);
  const now = new Date(nowSeconds * 1_000);
  const dayDiff = calendarDaysBetween(now, date);
  const f = dateFormats();
  if (dayDiff === 0) return 'Today';
  if (dayDiff === 1) return 'Yesterday';
  if (dayDiff > 1 && dayDiff < WEEKDAY_BAND_DAYS) return f.weekday.format(date);
  return date.getFullYear() === now.getFullYear()
    ? f.weekdayMonthDay.format(date)
    : f.monthDayYear.format(date);
}

export function formatItemTimestamp(
  unixSeconds: number,
  {
    withTime = false,
    nowSeconds = Date.now() / 1_000,
  }: { withTime?: boolean; nowSeconds?: number } = {},
): string {
  const date = new Date(unixSeconds * 1_000);
  const now = new Date(nowSeconds * 1_000);
  const dayDiff = calendarDaysBetween(now, date);
  const f = dateFormats();
  const time = f.time.format(date);
  if (dayDiff === 0) return time;
  const dayLabel =
    dayDiff === 1
      ? 'Yesterday'
      : dayDiff > 1 && dayDiff < WEEKDAY_BAND_DAYS
        ? f.weekday.format(date)
        : date.getFullYear() === now.getFullYear()
          ? f.shortWeekdayMonthDay.format(date)
          : f.shortMonthDayYear.format(date);
  return withTime ? `${dayLabel} at ${time}` : dayLabel;
}

export function formatFullTimestamp(unixSeconds: number): string {
  return dateFormats().full.format(new Date(unixSeconds * 1_000));
}

export function formatTime(unixSeconds: number): string {
  return dateFormats().time.format(new Date(unixSeconds * 1_000));
}

export function formatCompactTime(unixSeconds: number): string {
  return dateFormats()
    .time.formatToParts(unixSeconds * 1_000)
    .filter((part) => part.type !== 'dayPeriod')
    .map((part) => part.value)
    .join('')
    .trim();
}

function startOfLocalDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function calendarDaysBetween(now: Date, date: Date): number {
  return Math.round(
    (startOfLocalDay(now).getTime() - startOfLocalDay(date).getTime()) /
      86_400_000,
  );
}
