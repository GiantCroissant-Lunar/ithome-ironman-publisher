import { describe, expect, it } from 'vitest';
import {
  calculateDayNumber,
  calendarDateInTimeZone,
  parseCalendarDate,
  parsePublicationDate,
} from '../src/domain/date.js';
import { AppError, ExitCode } from '../src/infra/errors.js';

describe('calendar/date logic', () => {
  it('uses the Asia/Taipei calendar day at the UTC boundary', () => {
    expect(calendarDateInTimeZone(new Date('2026-08-31T16:00:00.000Z'), 'Asia/Taipei')).toEqual({
      year: 2026,
      month: 9,
      day: 1,
    });
  });

  it('calculates one-based Day N across month boundaries', () => {
    expect(calculateDayNumber(parseCalendarDate('2026-09-28'), parseCalendarDate('2026-10-02'), 30)).toBe(5);
  });

  it('rejects dates outside the configured competition window', () => {
    try {
      calculateDayNumber(parseCalendarDate('2026-09-01'), parseCalendarDate('2026-08-31'), 30);
      throw new Error('Expected calculateDayNumber to fail');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).exitCode).toBe(ExitCode.DayOutOfRange);
    }
  });

  it('parses common full, short, and relative publication dates', () => {
    const today = parseCalendarDate('2026-09-07');
    expect(parsePublicationDate('2026 年 9 月 7 日', today)).toEqual(today);
    expect(parsePublicationDate('09/07 10:17', today)).toEqual(today);
    expect(parsePublicationDate('今天 10:17', today)).toEqual(today);
  });
});
