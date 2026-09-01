import { formatCalendarDate, sameCalendarDate, type CalendarDate } from './date.js';
import { titlesMatch } from './title.js';
import { AppError, ExitCode } from '../infra/errors.js';
import type { PublicArticle, PublicArticleSnapshot } from '../site/publisher-site.js';

export type PublishState =
  | { kind: 'not-published' }
  | { kind: 'already-published'; article: PublicArticle };

export function assessPublishState(
  snapshot: PublicArticleSnapshot,
  expectedTitle: string,
  today: CalendarDate,
): PublishState {
  if (!snapshot.listingRecognized) {
    throw new AppError(
      'The public series article listing could not be recognized; refusing to publish',
      ExitCode.BrowserWorkflowFailed,
    );
  }

  const expectedArticles = snapshot.articles.filter((article) => titlesMatch(article.title, expectedTitle));
  const expectedToday = expectedArticles.find(
    (article) => article.publishedDate && sameCalendarDate(article.publishedDate, today),
  );
  if (expectedToday) {
    return { kind: 'already-published', article: expectedToday };
  }

  if (expectedArticles.length > 0) {
    throw new AppError(
      'The expected article title already exists, but its date is not today; refusing to publish',
      ExitCode.SafetyConflict,
      { expectedTitle, matches: expectedArticles },
    );
  }

  const publishedToday = snapshot.articles.filter(
    (article) => article.publishedDate && sameCalendarDate(article.publishedDate, today),
  );
  if (publishedToday.length > 0) {
    throw new AppError(
      'Another series article is already published today; refusing to publish a second article',
      ExitCode.SafetyConflict,
      {
        expectedTitle,
        today: formatCalendarDate(today),
        publishedToday: publishedToday.map((article) => article.title),
      },
    );
  }

  if (!snapshot.dateEvidenceComplete && snapshot.articles.length > 0) {
    throw new AppError(
      'One or more public articles have no parseable date; idempotency cannot be proven',
      ExitCode.SafetyConflict,
      { undatedTitles: snapshot.articles.filter((article) => !article.publishedDate).map((article) => article.title) },
    );
  }

  return { kind: 'not-published' };
}
