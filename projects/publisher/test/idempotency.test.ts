import { describe, expect, it } from 'vitest';
import { assessPublishState } from '../src/domain/idempotency.js';
import { parseCalendarDate } from '../src/domain/date.js';
import { AppError, ExitCode } from '../src/infra/errors.js';

const today = parseCalendarDate('2026-09-03');

describe('idempotency decision', () => {
  it('skips when the exact expected article is already published today', () => {
    const result = assessPublishState(
      {
        listingRecognized: true,
        dateEvidenceComplete: true,
        articles: [{ title: 'Day 03 - Topic', url: 'https://example.test/3', publishedDate: today }],
      },
      'Day 03 - Topic',
      today,
    );
    expect(result.kind).toBe('already-published');
  });

  it('refuses to publish when another article exists today', () => {
    try {
      assessPublishState(
        {
          listingRecognized: true,
          dateEvidenceComplete: true,
          articles: [{ title: 'Unexpected article', url: 'https://example.test/other', publishedDate: today }],
        },
        'Day 03 - Topic',
        today,
      );
      throw new Error('Expected assessPublishState to fail');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).exitCode).toBe(ExitCode.SafetyConflict);
    }
  });

  it('refuses to publish when public date evidence is incomplete', () => {
    try {
      assessPublishState(
        {
          listingRecognized: true,
          dateEvidenceComplete: false,
          articles: [{ title: 'Older article', url: 'https://example.test/older' }],
        },
        'Day 03 - Topic',
        today,
      );
      throw new Error('Expected assessPublishState to fail');
    } catch (error: unknown) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).exitCode).toBe(ExitCode.SafetyConflict);
    }
  });

  it('allows selection only when an empty public listing is explicitly recognized', () => {
    expect(
      assessPublishState(
        { listingRecognized: true, dateEvidenceComplete: true, articles: [] },
        'Day 03 - Topic',
        today,
      ),
    ).toEqual({ kind: 'not-published' });
  });
});
