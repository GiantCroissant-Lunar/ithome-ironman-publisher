import type { AppConfig } from '../config/schema.js';
import { loadArticleForDay } from '../content/article.js';
import { AppError, ExitCode } from '../infra/errors.js';
import type { PublisherRuntimeState } from '../state/publisher-state.js';
import { syncPublicationReceiptToGit, type GitSyncResult } from './git-publication.js';
import {
  canonicalIthomeArticleUrl,
  extractIthomeArticleId,
  readPublicationReceipt,
  publicationReceiptPath,
  writePublicationReceipt,
  type PublicationReceipt,
} from './publication-receipt.js';

export interface PublicationSyncResult {
  receipt: PublicationReceipt;
  receiptChanged: boolean;
  git: GitSyncResult;
}

export async function recordAndSyncPublication(
  config: AppConfig,
  runtimeState: PublisherRuntimeState,
  dayNumber: number,
  articleUrl: string,
): Promise<PublicationSyncResult> {
  if (!config.seriesTitle || !config.seriesCategory) {
    throw new AppError(
      'Series title and category are required before recording a publication receipt',
      ExitCode.InvalidConfiguration,
      { seriesTitle: config.seriesTitle, seriesCategory: config.seriesCategory },
    );
  }
  const article = await loadArticleForDay(config.articlesDir, dayNumber);
  const dayKey = `day-${String(dayNumber).padStart(3, '0')}`;
  const articleState = runtimeState.articles[dayKey];
  const path = publicationReceiptPath(config.articlesDir, dayNumber);
  const existing = await readPublicationReceipt(path);
  const articleId = extractIthomeArticleId(articleUrl, config.profileUrl);
  const canonicalArticleUrl = canonicalIthomeArticleUrl(articleUrl, config.profileUrl);
  const publishedAt = existing?.publishedAt ?? articleState?.lastPublishedAt ?? new Date().toISOString();
  const receiptInput: PublicationReceipt = {
    version: 1,
    dayNumber,
    articleId,
    articleUrl: canonicalArticleUrl,
    ...(runtimeState.seriesUrl || config.seriesUrl ? { seriesUrl: runtimeState.seriesUrl ?? config.seriesUrl } : {}),
    ironmanYear: config.ironmanYear,
    seriesTitle: config.seriesTitle,
    category: config.seriesCategory,
    title: article.title,
    publishedAt,
    sourceHash: articleState?.sourceHash ?? article.sourceHash,
    ...(articleState?.renderedHash ? { renderedHash: articleState.renderedHash } : {}),
  };
  const receipt = await writePublicationReceipt(config.articlesDir, receiptInput);
  const git = await syncPublicationReceiptToGit(
    config.repositoryRoot,
    receipt.path,
    receipt.receipt.dayNumber,
    receipt.receipt.articleId,
  );
  return { receipt: receipt.receipt, receiptChanged: receipt.changed, git };
}
