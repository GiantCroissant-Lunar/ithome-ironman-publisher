import { AppError, ExitCode } from '../infra/errors.js';

export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

const DATE_PATTERN = /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})$/u;

export function parseCalendarDate(value: string): CalendarDate {
  const match = DATE_PATTERN.exec(value);
  if (!match?.groups) {
    throw new AppError(`Invalid calendar date: ${value}`, ExitCode.InvalidConfiguration);
  }

  const date = {
    year: Number(match.groups.year),
    month: Number(match.groups.month),
    day: Number(match.groups.day),
  };

  const roundTrip = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    roundTrip.getUTCFullYear() !== date.year ||
    roundTrip.getUTCMonth() + 1 !== date.month ||
    roundTrip.getUTCDate() !== date.day
  ) {
    throw new AppError(`Invalid calendar date: ${value}`, ExitCode.InvalidConfiguration);
  }

  return date;
}

export function calendarDateInTimeZone(now: Date, timeZone: string): CalendarDate {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);

  const get = (type: Intl.DateTimeFormatPartTypes): number => {
    const value = parts.find((part) => part.type === type)?.value;
    if (!value) {
      throw new AppError(`Could not calculate date in ${timeZone}`, ExitCode.InvalidConfiguration);
    }
    return Number(value);
  };

  return { year: get('year'), month: get('month'), day: get('day') };
}

export function formatCalendarDate(date: CalendarDate): string {
  return `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;
}

export function sameCalendarDate(left: CalendarDate, right: CalendarDate): boolean {
  return left.year === right.year && left.month === right.month && left.day === right.day;
}

export function calculateDayNumber(
  startDate: CalendarDate,
  today: CalendarDate,
  maximumDay: number,
): number {
  const start = Date.UTC(startDate.year, startDate.month - 1, startDate.day);
  const current = Date.UTC(today.year, today.month - 1, today.day);
  const dayNumber = Math.floor((current - start) / 86_400_000) + 1;

  if (dayNumber < 1 || dayNumber > maximumDay) {
    throw new AppError('Today is outside the configured Ironman publishing window', ExitCode.DayOutOfRange, {
      dayNumber,
      maximumDay,
      startDate: formatCalendarDate(startDate),
      today: formatCalendarDate(today),
    });
  }

  return dayNumber;
}

export function parsePublicationDate(text: string, today: CalendarDate): CalendarDate | undefined {
  if (/(?:今天|今日|today)/iu.test(text)) {
    return today;
  }

  const full = /(?<year>20\d{2})\s*(?:年|[-/.])\s*(?<month>\d{1,2})\s*(?:月|[-/.])\s*(?<day>\d{1,2})\s*日?/u.exec(
    text,
  );
  if (full?.groups) {
    return safeDate(Number(full.groups.year), Number(full.groups.month), Number(full.groups.day));
  }

  const short = /(?:^|\D)(?<month>\d{1,2})\s*[-/.]\s*(?<day>\d{1,2})(?:\D|$)/u.exec(text);
  if (short?.groups) {
    return safeDate(today.year, Number(short.groups.month), Number(short.groups.day));
  }

  return undefined;
}

function safeDate(year: number, month: number, day: number): CalendarDate | undefined {
  const candidate = new Date(Date.UTC(year, month - 1, day));
  if (
    candidate.getUTCFullYear() !== year ||
    candidate.getUTCMonth() + 1 !== month ||
    candidate.getUTCDate() !== day
  ) {
    return undefined;
  }
  return { year, month, day };
}
