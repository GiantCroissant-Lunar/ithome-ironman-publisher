import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { loadProjectEnvironment } from '../config/environment.js';
import { AppError, errorDetails, ExitCode, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { loadLeonardoConfig } from '../leonardo/config.js';
import { validateGenerationRunArtifacts } from '../leonardo/generation-run.js';

loadProjectEnvironment();

function parseArguments(arguments_: string[]): { dayNumber: number; minimumRuns: number } {
  const valueFor = (name: string): string | undefined => {
    const index = arguments_.indexOf(name);
    return index >= 0 ? arguments_[index + 1] : undefined;
  };
  const rawDay = valueFor('--day');
  const rawMinimum = valueFor('--minimum-runs') ?? '1';
  const dayNumber = Number(rawDay);
  const minimumRuns = Number(rawMinimum);
  if (
    !Number.isInteger(dayNumber) ||
    dayNumber < 1 ||
    dayNumber > 999 ||
    !Number.isInteger(minimumRuns) ||
    minimumRuns < 1 ||
    minimumRuns > 100
  ) {
    throw new AppError(
      'Usage: npm run leonardo:runs:check -- --day N [--minimum-runs N]',
      ExitCode.InvalidConfiguration,
    );
  }
  return { dayNumber, minimumRuns };
}

async function main(): Promise<void> {
  const cli = parseArguments(process.argv.slice(2));
  const config = loadLeonardoConfig();
  const logger = createLogger(config.logLevel);
  const dayDirectory = join(config.outputDirectory, `day-${String(cli.dayNumber).padStart(3, '0')}`);
  let entries;
  try {
    entries = await readdir(dayDirectory, { withFileTypes: true });
  } catch {
    throw new AppError('No Leonardo generation runs were found for this article', ExitCode.VerificationFailed, {
      dayNumber: cli.dayNumber,
      dayDirectory,
    });
  }
  const runPaths = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(dayDirectory, entry.name, 'run.json'))
    .sort();
  if (runPaths.length < cli.minimumRuns) {
    throw new AppError('Leonardo generation run count is below the requested repeatability threshold', ExitCode.VerificationFailed, {
      dayNumber: cli.dayNumber,
      actualRuns: runPaths.length,
      minimumRuns: cli.minimumRuns,
    });
  }
  const runs = await Promise.all(runPaths.map((path) => validateGenerationRunArtifacts(path)));
  for (const run of runs) {
    if (run.request.dayNumber !== cli.dayNumber) {
      throw new AppError('Leonardo run Day does not match its output directory', ExitCode.VerificationFailed, {
        runId: run.runId,
        requestDayNumber: run.request.dayNumber,
        directoryDayNumber: cli.dayNumber,
      });
    }
  }
  logger.info(
    {
      dayNumber: cli.dayNumber,
      runs: runs.length,
      candidates: runs.reduce((total, run) => total + run.candidates.length, 0),
      runIds: runs.map((run) => run.runId),
    },
    'Leonardo generation runs and candidate SHA-256 values are valid',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
