import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { loadProjectEnvironment } from '../config/environment.js';
import { loadArticleForDay } from '../content/article.js';
import { AppError, errorDetails, ExitCode, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { loadLeonardoConfig } from '../leonardo/config.js';
import { loadGenerationRequest } from '../leonardo/generation-request.js';
import { runGenerationWorkflow } from '../leonardo/generation-workflow.js';
import { PlaywrightLeonardoSite } from '../leonardo/playwright-leonardo-site.js';

loadProjectEnvironment();

interface GenerateArguments {
  requestPath: string;
  live: boolean;
}

function parseArguments(arguments_: string[]): GenerateArguments {
  const rawPath = arguments_.find((argument) => !argument.startsWith('--'));
  const unknown = arguments_.filter((argument) => argument !== '--generate' && argument !== rawPath);
  if (!rawPath || unknown.length > 0) {
    throw new AppError(
      'Usage: npm run leonardo:generate -- <generation-request.json> [--generate]',
      ExitCode.InvalidConfiguration,
      { unknown },
    );
  }
  return { requestPath: resolveRepositoryInput(rawPath), live: arguments_.includes('--generate') };
}

function resolveRepositoryInput(value: string): string {
  if (isAbsolute(value)) return value;
  const fromWorkingDirectory = resolve(process.cwd(), value);
  if (existsSync(fromWorkingDirectory)) return fromWorkingDirectory;
  return resolve(process.cwd(), '../..', value);
}

async function main(): Promise<void> {
  const cli = parseArguments(process.argv.slice(2));
  const config = loadLeonardoConfig();
  const logger = createLogger(config.logLevel);
  const request = await loadGenerationRequest(cli.requestPath);
  const articlesDirectory = resolve(process.cwd(), process.env.ARTICLES_DIR ?? '../../articles');
  const article = await loadArticleForDay(articlesDirectory, request.dayNumber);
  let site: PlaywrightLeonardoSite | undefined;
  let failed = false;

  try {
    const result = await runGenerationWorkflow(request, cli.live, async () => {
      site = await PlaywrightLeonardoSite.create(config, logger);
      return site;
    });
    if (result.mode === 'preview') {
      logger.info(
        {
          requestPath: cli.requestPath,
          dayNumber: request.dayNumber,
          title: article.title,
          assetName: request.assetName,
          aspectRatio: request.aspectRatio,
          style: request.style,
          model: request.model,
          maxCandidates: request.maxCandidates,
        },
        'Leonardo generation preview completed; browser was not opened and no tokens were consumed',
      );
      return;
    }
    const run = result.run;
    if (!run) throw new AppError('Leonardo generation did not return a run record', ExitCode.UnexpectedFailure);
    const runPath = join(
      config.outputDirectory,
      `day-${String(request.dayNumber).padStart(3, '0')}`,
      run.runId,
      'run.json',
    );
    logger.info(
      { runPath, candidateFiles: run.candidates.map((candidate) => candidate.fileName) },
      'Leonardo generation completed; review candidates before promotion',
    );
  } catch (error: unknown) {
    failed = true;
    if (site) await site.captureDiagnostics(error).catch(() => undefined);
    throw error;
  } finally {
    if (site) await site.close(failed);
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
