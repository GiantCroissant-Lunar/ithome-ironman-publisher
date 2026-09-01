import { resolve } from 'node:path';
import { loadProjectEnvironment } from '../config/environment.js';
import { loadArticleForDay } from '../content/article.js';
import { validateGeneratedImages } from '../content/generated-images.js';
import { loadArticleVisualPlan, validateSelectedVisualPlacement } from '../content/visual-plan.js';
import { AppError, errorDetails, ExitCode, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';

loadProjectEnvironment();

function parseDay(arguments_: string[]): number {
  if (arguments_.length !== 2 || arguments_[0] !== '--day') {
    throw new AppError('Usage: npm run images:check -- --day N', ExitCode.InvalidConfiguration);
  }
  const dayNumber = Number(arguments_[1]);
  if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 999) {
    throw new AppError('Generated image check day must be between 1 and 999', ExitCode.InvalidConfiguration, {
      day: arguments_[1],
    });
  }
  return dayNumber;
}

async function main(): Promise<void> {
  const dayNumber = parseDay(process.argv.slice(2));
  const articlesDirectory = resolve(process.cwd(), process.env.ARTICLES_DIR ?? '../../articles');
  const article = await loadArticleForDay(articlesDirectory, dayNumber);
  const manifest = await validateGeneratedImages(article);
  const visualPlan = await loadArticleVisualPlan(article);
  const visualStatus = validateSelectedVisualPlacement(article, visualPlan, manifest);
  createLogger(process.env.LOG_LEVEL ?? 'info').info(
    {
      dayNumber,
      title: article.title,
      provider: manifest?.provider,
      generatedImages: manifest?.assets.length ?? 0,
      visualPlan: visualStatus,
    },
    'Selected generated images are valid',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
