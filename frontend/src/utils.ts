import { format, formatDistanceToNowStrict, isValid, parseISO } from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import type { EventRecord } from "./types";

export function eventInputValue(utcValue: string | null, timezone: string): string {
  if (!utcValue) return "";
  const local = toZonedTime(parseISO(utcValue), timezone);
  return format(local, "yyyy-MM-dd'T'HH:mm");
}

export function localInputToUtc(value: string, timezone: string): string {
  const localDate = new Date(value);
  if (!isValid(localDate)) throw new Error("Enter a valid local date and time.");
  return fromZonedTime(localDate, timezone).toISOString();
}

export function localDateKey(value: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(value));
}

export function todayKey(timezone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function displayDate(value: string, timezone: string, options?: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
    ...options,
  }).format(new Date(value));
}

export function displayClock(value: string, timezone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(new Date(value));
}

export function countdown(value: string, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((new Date(value).getTime() - now) / 60_000));
  if (minutes === 0) return "Starting now";
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const remainingMinutes = minutes % 60;
  if (days > 0) return `in ${days}d ${hours}h`;
  if (hours > 0) return `in ${hours} hrs ${remainingMinutes} min`;
  return `in ${remainingMinutes} min`;
}

export function relativeDate(value: string): string {
  return formatDistanceToNowStrict(new Date(value), { addSuffix: true });
}

export function calendarDayNumber(key: string): number {
  const [year, month, day] = key.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / 86_400_000;
}

export function classifyEvents(events: EventRecord[], timezone: string) {
  const today = todayKey(timezone);
  const todayNumber = calendarDayNumber(today);
  const todayEvents: EventRecord[] = [];
  const upcomingWeek: EventRecord[] = [];
  const later: EventRecord[] = [];
  const past: EventRecord[] = [];
  for (const event of events) {
    const key = localDateKey(event.start_utc, timezone);
    const day = calendarDayNumber(key);
    if (key === today) todayEvents.push(event);
    else if (day > todayNumber && day <= todayNumber + 7) {
      upcomingWeek.push(event);
    } else if (day > todayNumber + 7) later.push(event);
    else past.push(event);
  }
  return { todayEvents, upcomingWeek, later, past };
}
