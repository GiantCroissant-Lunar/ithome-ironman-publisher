import type { Logger } from 'pino';
import { loadArticleForDay, type LocalArticle } from '../content/article.js';
import {
  calculateDayNumber,
  calendarDateInTimeZone,
  formatCalendarDate,
  parseCalendarDate,
  sameCalendarDate,
} from '../domain/date.js';
import { assessPublishState } from '../domain/idempotency.js';
import { titlesMatch } from '../domain/title.js';
import { AppError, ExitCode } from '../infra/errors.js';
import type { DraftArticle, PublisherSite } from '../site/publisher-site.js';
import type {
  DiscoveredSiteState,
  PublisherRuntimeState,
} from '../state/publisher-state.js';

export interface PublishWorkflowOptions {
  timeZone: string;
  startDate: string;
  maximumDay: number;
  articlesDir: string;
  dryRun: boolean;
  publishedUpdatePolicy: 'report';
  verificationAttempts: number;
  verificationDelayMs: number;
}

export type PublishWorkflowResult =
  | { status: 'already-published'; dayNumber: number; expectedTitle: string; articleUrl: string }
  | { status: 'dry-run'; dayNumber: number; expectedTitle: string; draftAction: 'would-create' }
  | { status: 'dry-run'; dayNumber: number; expectedTitle: string; draftAction: 'would-update'; draftUrl: string }
  | {
      status: 'published';
      dayNumber: number;
      expectedTitle: string;
      articleUrl: string;
      draftAction: 'created' | 'updated';
    };

export interface WorkflowDependencies {
  site: PublisherSite;
  logger: Logger;
  runtimeState?: PublisherRuntimeState;
  persistRuntimeState?: (state: PublisherRuntimeState) => Promise<void>;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  loadArticle?: (articlesDirectory: string, dayNumber: number) => Promise<LocalArticle>;
}

export async function runPublishWorkflow(
  options: PublishWorkflowOptions,
  dependencies: WorkflowDependencies,
): Promise<PublishWorkflowResult> {
  const now = dependencies.now?.() ?? new Date();
  const today = calendarDateInTimeZone(now, options.timeZone);
  const dayNumber = calculateDayNumber(parseCalendarDate(options.startDate), today, options.maximumDay);
  const dayKey = `day-${String(dayNumber).padStart(3, '0')}`;
  const article = await (dependencies.loadArticle ?? loadArticleForDay)(options.articlesDir, dayNumber);
  const expectedTitle = article.title;
  assertArticleIsDue(article, today, now, options.timeZone);
  const context = { dayNumber, expectedTitle, today: formatCalendarDate(today), dryRun: options.dryRun };

  dependencies.logger.info(context, 'Starting publish workflow');
  await dependencies.site.assertAuthenticated();
  await persistDiscoveries(dependencies);

  const before = await dependencies.site.getPublicArticleSnapshot(today);
  const publishState = assessPublishState(before, expectedTitle, today);
  if (publishState.kind === 'already-published') {
    const prior = dependencies.runtimeState?.articles[dayKey];
    if (prior?.sourceHash && prior.sourceHash !== article.sourceHash) {
      dependencies.logger.warn(
        { ...context, previousSourceHash: prior.sourceHash, currentSourceHash: article.sourceHash },
        'Local content changed after publication; published_update_policy=report leaves the public article unchanged',
      );
    }
    await dependencies.site.discoverPublishedContext(publishState.article.url);
    if (dependencies.runtimeState) {
      mergeDiscovered(dependencies.runtimeState, dependencies.site.getDiscoveredState());
      dependencies.runtimeState.articles[dayKey] = {
        ...prior,
        articleUrl: publishState.article.url,
        lastPublishedAt: prior?.lastPublishedAt ?? now.toISOString(),
        assets: prior?.assets ?? {},
      };
      await dependencies.persistRuntimeState?.(dependencies.runtimeState);
    }
    dependencies.logger.info({ ...context, articleUrl: publishState.article.url }, 'Article is already published; no action taken');
    return { status: 'already-published', dayNumber, expectedTitle, articleUrl: publishState.article.url };
  }

  const previousArticleState = dependencies.runtimeState?.articles[dayKey];
  let existingDraft: DraftArticle | undefined;
  if (previousArticleState?.draftUrl) {
    existingDraft = { title: expectedTitle, url: previousArticleState.draftUrl };
  } else {
    const drafts = await dependencies.site.listDrafts();
    existingDraft = requireAtMostOneDraft(
      drafts.filter((draft) => titlesMatch(draft.title, expectedTitle)),
      expectedTitle,
    );
  }

  if (options.dryRun) {
    await persistDiscoveries(dependencies);
    if (existingDraft) {
      dependencies.logger.info({ ...context, draftUrl: existingDraft.url }, 'Dry run would update the existing draft');
      return { status: 'dry-run', dayNumber, expectedTitle, draftAction: 'would-update', draftUrl: existingDraft.url };
    }
    dependencies.logger.info(context, 'Dry run would create a new draft');
    return { status: 'dry-run', dayNumber, expectedTitle, draftAction: 'would-create' };
  }

  const syncResult = await dependencies.site.syncDraft(article, existingDraft, previousArticleState);
  if (dependencies.runtimeState) {
    mergeDiscovered(dependencies.runtimeState, dependencies.site.getDiscoveredState());
    dependencies.runtimeState.articles[dayKey] = {
      ...previousArticleState,
      draftUrl: syncResult.draft.url,
      sourceHash: syncResult.sourceHash,
      renderedHash: syncResult.renderedHash,
      lastSyncedAt: now.toISOString(),
      assets: syncResult.assets,
    };
    await dependencies.persistRuntimeState?.(dependencies.runtimeState);
  }

  dependencies.logger.warn(
    { ...context, draftUrl: syncResult.draft.url, draftAction: syncResult.action, uploadedImages: syncResult.uploadedImages },
    'Publishing synchronized draft',
  );
  await dependencies.site.publishDraft(syncResult.draft);

  const sleep = dependencies.sleep ?? defaultSleep;
  for (let attempt = 1; attempt <= options.verificationAttempts; attempt += 1) {
    const after = await dependencies.site.getPublicArticleSnapshot(today);
    const published = after.articles.find(
      (candidate) =>
        titlesMatch(candidate.title, expectedTitle) &&
        candidate.publishedDate !== undefined &&
        sameCalendarDate(candidate.publishedDate, today),
    );
    if (published) {
      await dependencies.site.discoverPublishedContext(published.url);
      if (dependencies.runtimeState) {
        mergeDiscovered(dependencies.runtimeState, dependencies.site.getDiscoveredState());
        const synced = dependencies.runtimeState.articles[dayKey];
        dependencies.runtimeState.articles[dayKey] = {
          ...synced,
          articleUrl: published.url,
          lastPublishedAt: now.toISOString(),
          assets: synced?.assets ?? {},
        };
        await dependencies.persistRuntimeState?.(dependencies.runtimeState);
      }
      dependencies.logger.info(
        { ...context, articleUrl: published.url, verificationAttempt: attempt },
        'Published article verified on the public page',
      );
      return {
        status: 'published',
        dayNumber,
        expectedTitle,
        articleUrl: published.url,
        draftAction: syncResult.action,
      };
    }
    if (attempt < options.verificationAttempts) {
      dependencies.logger.warn({ ...context, verificationAttempt: attempt }, 'Article not visible yet; verification will retry');
      await sleep(options.verificationDelayMs);
    }
  }

  throw new AppError(
    'Publish action completed, but the expected article was not verified on the public page',
    ExitCode.VerificationFailed,
    context,
  );
}

function requireAtMostOneDraft(drafts: DraftArticle[], expectedTitle: string): DraftArticle | undefined {
  if (drafts.length > 1) {
    throw new AppError('Multiple drafts exactly match the expected title', ExitCode.DraftSelectionFailed, {
      expectedTitle,
      draftUrls: drafts.map((draft) => draft.url),
    });
  }
  return drafts[0];
}

async function persistDiscoveries(dependencies: WorkflowDependencies): Promise<void> {
  if (!dependencies.runtimeState) return;
  mergeDiscovered(dependencies.runtimeState, dependencies.site.getDiscoveredState());
  await dependencies.persistRuntimeState?.(dependencies.runtimeState);
}

function mergeDiscovered(state: PublisherRuntimeState, discovered: DiscoveredSiteState): void {
  if (discovered.seriesUrl) state.seriesUrl = discovered.seriesUrl;
  if (discovered.draftsUrl) state.draftsUrl = discovered.draftsUrl;
  if (discovered.newArticleUrl) state.newArticleUrl = discovered.newArticleUrl;
}

function assertArticleIsDue(
  article: LocalArticle,
  today: ReturnType<typeof calendarDateInTimeZone>,
  now: Date,
  timeZone: string,
): void {
  const scheduledDate = calendarDateInTimeZone(article.scheduledAt, timeZone);
  if (!sameCalendarDate(scheduledDate, today)) {
    throw new AppError('Article timestamp date does not match the expected publishing day', ExitCode.InvalidConfiguration, {
      dayNumber: article.dayNumber,
      timestamp: article.timestamp,
      expectedDate: formatCalendarDate(today),
      timestampDate: formatCalendarDate(scheduledDate),
    });
  }
  if (now.getTime() < article.scheduledAt.getTime()) {
    throw new AppError('Article timestamp has not been reached yet', ExitCode.DayOutOfRange, {
      dayNumber: article.dayNumber,
      timestamp: article.timestamp,
      now: now.toISOString(),
    });
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
