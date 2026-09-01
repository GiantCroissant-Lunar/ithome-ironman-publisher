import { resolve } from 'node:path';
import { loadProjectEnvironment } from '../config/environment.js';
import { loadAllArticles } from '../content/article.js';
import { AppError, errorDetails, ExitCode, exitCodeFor } from '../infra/errors.js';
import { createLogger } from '../infra/logger.js';
import { publicationReceiptPath, readPublicationReceipt } from '../publication/publication-receipt.js';

loadProjectEnvironment();

async function main(): Promise<void> {
  const articlesDirectory = resolve(process.cwd(), process.env.ARTICLES_DIR ?? '../../articles');
  const logger = createLogger(process.env.LOG_LEVEL ?? 'info');
  const articles = await loadAllArticles(articlesDirectory);
  const articleSummaries = await Promise.all(
    articles.map(async (article) => {
      const receiptPath = publicationReceiptPath(articlesDirectory, article.dayNumber);
      const receipt = await readPublicationReceipt(receiptPath);
      if (receipt && receipt.dayNumber !== article.dayNumber) {
        throw new AppError('Publication receipt day does not match its article directory', ExitCode.InvalidConfiguration, {
          receiptPath,
          directoryDayNumber: article.dayNumber,
          receiptDayNumber: receipt.dayNumber,
        });
      }
      return {
        dayNumber: article.dayNumber,
        title: article.title,
        timestamp: article.timestamp,
        images: article.images.length,
        sourceHash: article.sourceHash,
        ...(receipt
          ? {
              publication: {
                articleId: receipt.articleId,
                articleUrl: receipt.articleUrl,
                publishedAt: receipt.publishedAt,
                sourceMatchesReceipt: receipt.sourceHash === article.sourceHash,
                titleMatchesReceipt: receipt.title === article.title,
              },
            }
          : {}),
      };
    }),
  );
  logger.info(
    {
      articlesDirectory,
      count: articles.length,
      articles: articleSummaries,
    },
    'All local articles are valid',
  );
}

main().catch((error: unknown) => {
  process.stderr.write(`${JSON.stringify({ level: 'error', ...errorDetails(error) })}\n`);
  process.exitCode = exitCodeFor(error);
});
