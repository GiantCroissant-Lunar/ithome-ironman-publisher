import { resolve } from 'node:path';
import { loadProjectEnvironment } from '../config/environment.js';
import { loadAllArticles } from '../content/article.js';
import { errorDetails, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';

loadProjectEnvironment();

async function main(): Promise<void> {
  const articlesDirectory = resolve(process.cwd(), process.env.ARTICLES_DIR ?? '../../articles');
  const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
  const articles = await loadAllArticles(articlesDirectory);
  logger.info(
    {
      articlesDirectory,
      count: articles.length,
      articles: articles.map((article) => ({
        dayNumber: article.dayNumber,
        title: article.title,
        timestamp: article.timestamp,
        images: article.images.length,
        sourceHash: article.sourceHash,
      })),
    },
    'All local articles are valid',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
