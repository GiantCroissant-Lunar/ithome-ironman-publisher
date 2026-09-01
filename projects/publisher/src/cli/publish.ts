import { loadProjectEnvironment } from '../config/environment.js';
import { loadConfig } from '../config/schema.js';
import { errorDetails, ExitCode, exitCodeFor, AppError } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { assertGitReadyForPublication } from '../publication/git-publication.js';
import { recordAndSyncPublication } from '../publication/sync-publication.js';
import { PlaywrightPublisherSite } from '../site/playwright-publisher-site.js';
import { acquireProcessLock, PublisherStateRepository } from '../state/publisher-state.js';
import { runPublishWorkflow } from '../workflow/publish-workflow.js';

loadProjectEnvironment();

interface CliOptions {
  publishRequested: boolean;
}

function parseArguments(arguments_: string[]): CliOptions {
  const known = new Set(['--publish', '--dry-run']);
  const unknown = arguments_.filter((argument) => !known.has(argument));
  if (unknown.length > 0) {
    throw new AppError('Unknown command-line arguments', ExitCode.InvalidConfiguration, { unknown });
  }
  if (arguments_.includes('--publish') && arguments_.includes('--dry-run')) {
    throw new AppError('Use either --publish or --dry-run, not both', ExitCode.InvalidConfiguration);
  }
  return { publishRequested: arguments_.includes('--publish') };
}

async function main(): Promise<void> {
  const cli = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const dryRun = config.publishDryRun || !cli.publishRequested;

  if (cli.publishRequested && config.publishDryRun) {
    logger.warn('Publish was requested, but PUBLISH_DRY_RUN=true is an active safety lock; continuing as dry-run');
  }

  let site: PlaywrightPublisherSite | undefined;
  let failed = false;
  let cleanupError: unknown;
  let releaseLock: (() => Promise<void>) | undefined;
  try {
    releaseLock = await acquireProcessLock(config.lockPath, config.lockStaleMs);
    const stateRepository = new PublisherStateRepository(config.statePath, config.profileUrl);
    const runtimeState = await stateRepository.load();
    if (!dryRun) {
      if (!config.seriesTitle || !config.seriesCategory) {
        throw new AppError(
          'IRONMAN_SERIES_TITLE and IRONMAN_CATEGORY are required for a publication receipt',
          ExitCode.InvalidConfiguration,
        );
      }
      await assertGitReadyForPublication(config.repositoryRoot);
    }
    site = await PlaywrightPublisherSite.create(config, logger, runtimeState);
    const result = await runPublishWorkflow(
      {
        timeZone: config.timeZone,
        startDate: config.startDate,
        maximumDay: config.maximumDay,
        articlesDir: config.articlesDir,
        dryRun,
        publishedUpdatePolicy: config.publishedUpdatePolicy,
        verificationAttempts: config.verificationAttempts,
        verificationDelayMs: config.verificationDelayMs,
      },
      { site, logger, runtimeState, persistRuntimeState: (state) => stateRepository.save(state) },
    );
    if (!dryRun && (result.status === 'published' || result.status === 'already-published')) {
      try {
        const publicationSync = await recordAndSyncPublication(
          config,
          runtimeState,
          result.dayNumber,
          result.articleUrl,
        );
        logger.info({ publicationSync }, 'Publication ID recorded, committed, and pushed');
      } catch (error: unknown) {
        throw new AppError(
          'The article is public, but its publication receipt could not be committed and pushed',
          ExitCode.GitSynchronizationFailed,
          {
            articleUrl: result.articleUrl,
            articleMayAlreadyBePublic: true,
            synchronizationError: errorDetails(error),
          },
        );
      }
    }
    logger.info({ result }, 'Publish command completed');
  } catch (error: unknown) {
    failed = true;
    if (site) {
      await site.captureDiagnostics(error).catch(() => undefined);
    }
    logger.error(errorDetails(error), 'Publish command failed');
    process.exitCode = exitCodeFor(error);
  } finally {
    if (site) {
      try {
        await site.close(failed);
      } catch (closeError: unknown) {
        logger.error(errorDetails(closeError), 'Browser cleanup failed');
        if (!failed) {
          cleanupError = closeError;
        }
      }
    }
    if (releaseLock) {
      await releaseLock().catch((error: unknown) => {
        logger.error(errorDetails(error), 'Runtime lock cleanup failed');
      });
    }
  }

  if (cleanupError) {
    throw cleanupError instanceof Error ? cleanupError : new Error(JSON.stringify(errorDetails(cleanupError)));
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
