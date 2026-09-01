import { loadConfig } from '../config/schema.js';
import { loadProjectEnvironment } from '../config/environment.js';
import { loadArticleForDay } from '../content/article.js';
import { titlesMatch } from '../domain/title.js';
import { AppError, errorDetails, ExitCode, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { PlaywrightPublisherSite } from '../site/playwright-publisher-site.js';
import { acquireProcessLock, PublisherStateRepository } from '../state/publisher-state.js';

loadProjectEnvironment();

interface SyncArguments {
  dayNumber: number;
  write: boolean;
}

function parseArguments(arguments_: string[]): SyncArguments {
  const dayIndex = arguments_.indexOf('--day');
  const rawDay = dayIndex >= 0 ? arguments_[dayIndex + 1] : undefined;
  const dayNumber = Number(rawDay);
  const knownIndexes = new Set<number>(dayIndex >= 0 ? [dayIndex, dayIndex + 1] : []);
  const unknown = arguments_.filter((argument, index) => argument !== '--write' && !knownIndexes.has(index));
  if (!rawDay || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 999 || unknown.length > 0) {
    throw new AppError('Usage: npm run draft:sync -- --day N [--write]', ExitCode.InvalidConfiguration, { unknown });
  }
  return { dayNumber, write: arguments_.includes('--write') };
}

async function main(): Promise<void> {
  const cli = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const article = await loadArticleForDay(config.articlesDir, cli.dayNumber);
  let site: PlaywrightPublisherSite | undefined;
  let failed = false;
  let releaseLock: (() => Promise<void>) | undefined;

  try {
    releaseLock = await acquireProcessLock(config.lockPath, config.lockStaleMs);
    const stateRepository = new PublisherStateRepository(config.statePath, config.profileUrl);
    const runtimeState = await stateRepository.load();
    const dayKey = `day-${String(article.dayNumber).padStart(3, '0')}`;
    site = await PlaywrightPublisherSite.create(config, logger, runtimeState);
    await site.assertAuthenticated();
    const previousState = runtimeState.articles[dayKey];
    const knownDraft = previousState?.draftUrl ? { title: article.title, url: previousState.draftUrl } : undefined;
    const matchingDrafts = knownDraft
      ? [knownDraft]
      : (await site.listDrafts()).filter((draft) => titlesMatch(draft.title, article.title));
    if (matchingDrafts.length > 1) {
      throw new AppError('Multiple drafts exactly match the local article title', ExitCode.DraftSelectionFailed, {
        title: article.title,
        draftUrls: matchingDrafts.map((draft) => draft.url),
      });
    }
    const existingDraft = matchingDrafts[0];
    const discovered = site.getDiscoveredState();
    if (discovered.seriesUrl) runtimeState.seriesUrl = discovered.seriesUrl;
    if (discovered.draftsUrl) runtimeState.draftsUrl = discovered.draftsUrl;
    if (discovered.newArticleUrl) runtimeState.newArticleUrl = discovered.newArticleUrl;
    await stateRepository.save(runtimeState);

    if (!cli.write) {
      logger.info(
        {
          dayNumber: article.dayNumber,
          title: article.title,
          sourceHash: article.sourceHash,
          images: article.images.length,
          draftAction: existingDraft ? 'would-update' : 'would-create',
        },
        'Draft sync preview completed; no site data was changed',
      );
      return;
    }

    const result = await site.syncDraft(article, existingDraft, previousState);
    runtimeState.articles[dayKey] = {
      ...previousState,
      draftUrl: result.draft.url,
      sourceHash: result.sourceHash,
      renderedHash: result.renderedHash,
      lastSyncedAt: new Date().toISOString(),
      assets: result.assets,
    };
    await stateRepository.save(runtimeState);
    logger.info({ dayNumber: article.dayNumber, title: article.title, sourceHash: article.sourceHash, result }, 'Draft synchronized');
  } catch (error: unknown) {
    failed = true;
    if (site) {
      await site.captureDiagnostics(error).catch(() => undefined);
    }
    logger.error(errorDetails(error), 'Draft sync failed');
    process.exitCode = exitCodeFor(error);
  } finally {
    if (site) {
      await site.close(failed).catch((error: unknown) => {
        logger.error(errorDetails(error), 'Browser cleanup failed');
      });
    }
    if (releaseLock) {
      await releaseLock().catch((error: unknown) => {
        logger.error(errorDetails(error), 'Runtime lock cleanup failed');
      });
    }
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
