import { loadProjectEnvironment } from '../config/environment.js';
import { loadConfig } from '../config/schema.js';
import { AppError, errorDetails, ExitCode, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { recordAndSyncPublication } from '../publication/sync-publication.js';
import { PublisherStateRepository } from '../state/publisher-state.js';

loadProjectEnvironment();

interface CliArguments {
  dayNumber: number;
  articleUrl?: string;
}

function parseArguments(arguments_: string[]): CliArguments {
  const dayIndex = arguments_.indexOf('--day');
  const articleUrlIndex = arguments_.indexOf('--article-url');
  const rawDay = dayIndex >= 0 ? arguments_[dayIndex + 1] : undefined;
  const dayNumber = Number(rawDay);
  const knownIndexes = new Set<number>([
    ...(dayIndex >= 0 ? [dayIndex, dayIndex + 1] : []),
    ...(articleUrlIndex >= 0 ? [articleUrlIndex, articleUrlIndex + 1] : []),
  ]);
  const unknown = arguments_.filter((_argument, index) => !knownIndexes.has(index));
  if (!rawDay || !Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 999 || unknown.length > 0) {
    throw new AppError(
      'Usage: npm run publication:sync -- --day N [--article-url https://ithelp.ithome.com.tw/articles/ID]',
      ExitCode.InvalidConfiguration,
      { unknown },
    );
  }
  const articleUrl = articleUrlIndex >= 0 ? arguments_[articleUrlIndex + 1] : undefined;
  if (articleUrlIndex >= 0 && !articleUrl) {
    throw new AppError('--article-url requires a value', ExitCode.InvalidConfiguration);
  }
  return { dayNumber, ...(articleUrl ? { articleUrl } : {}) };
}

async function main(): Promise<void> {
  const cli = parseArguments(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const stateRepository = new PublisherStateRepository(config.statePath, config.profileUrl);
  const runtimeState = await stateRepository.load();
  const dayKey = `day-${String(cli.dayNumber).padStart(3, '0')}`;
  const articleUrl = cli.articleUrl ?? runtimeState.articles[dayKey]?.articleUrl;
  if (!articleUrl) {
    throw new AppError(
      'No published article URL is available in runtime state; provide --article-url for recovery',
      ExitCode.InvalidConfiguration,
      { dayNumber: cli.dayNumber },
    );
  }
  const result = await recordAndSyncPublication(config, runtimeState, cli.dayNumber, articleUrl);
  logger.info({ result }, 'Publication receipt committed and pushed without republishing');
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
