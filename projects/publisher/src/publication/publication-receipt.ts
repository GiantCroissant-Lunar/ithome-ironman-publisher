import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { dayDirectoryName } from '../content/article.js';
import { AppError, ExitCode } from '../infra/errors.js';

const sha256Schema = z.string().regex(/^[a-f\d]{64}$/u);

export const publicationReceiptSchema = z
  .object({
    version: z.literal(1),
    dayNumber: z.number().int().min(1).max(999),
    articleId: z.string().regex(/^\d+$/u),
    articleUrl: z.url(),
    seriesUrl: z.url().optional(),
    ironmanYear: z.number().int().min(2008).max(2100),
    seriesTitle: z.string().trim().min(1),
    category: z.string().trim().min(1),
    title: z.string().trim().min(1),
    publishedAt: z.iso.datetime(),
    sourceHash: sha256Schema,
    renderedHash: sha256Schema.optional(),
  })
  .strict()
  .superRefine((receipt, context) => {
    const article = new URL(receipt.articleUrl);
    if (article.pathname !== `/articles/${receipt.articleId}` || article.search || article.hash) {
      context.addIssue({
        code: 'custom',
        path: ['articleUrl'],
        message: 'articleUrl must be the canonical /articles/<articleId> URL',
      });
    }
  });

export type PublicationReceipt = z.infer<typeof publicationReceiptSchema>;

export interface PublicationReceiptWriteResult {
  path: string;
  receipt: PublicationReceipt;
  changed: boolean;
}

export function extractIthomeArticleId(articleUrl: string, profileUrl: string): string {
  const article = new URL(articleUrl);
  const profile = new URL(profileUrl);
  if (article.origin !== profile.origin) {
    throw new AppError('Published article URL origin does not match the configured iT profile', ExitCode.SafetyConflict, {
      articleUrl,
      expectedOrigin: profile.origin,
    });
  }
  const match = /^\/articles\/(?<articleId>\d+)\/?$/u.exec(article.pathname);
  if (!match?.groups?.articleId) {
    throw new AppError('Published article URL does not contain a recognizable iT article ID', ExitCode.VerificationFailed, {
      articleUrl,
    });
  }
  return match.groups.articleId;
}

export function canonicalIthomeArticleUrl(articleUrl: string, profileUrl: string): string {
  const articleId = extractIthomeArticleId(articleUrl, profileUrl);
  return new URL(`/articles/${articleId}`, profileUrl).toString();
}

export function publicationReceiptPath(articlesDirectory: string, dayNumber: number): string {
  return join(articlesDirectory, dayDirectoryName(dayNumber), 'publication.json');
}

export async function readPublicationReceipt(path: string): Promise<PublicationReceipt | undefined> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === 'ENOENT') return undefined;
    throw new AppError('Publication receipt could not be read', ExitCode.InvalidConfiguration, { path });
  }
  let json: unknown;
  try {
    json = JSON.parse(source);
  } catch {
    throw new AppError('Publication receipt is not valid JSON', ExitCode.InvalidConfiguration, { path });
  }
  const parsed = publicationReceiptSchema.safeParse(json);
  if (!parsed.success) {
    throw new AppError('Publication receipt validation failed', ExitCode.InvalidConfiguration, {
      path,
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

export async function writePublicationReceipt(
  articlesDirectory: string,
  receiptInput: PublicationReceipt,
): Promise<PublicationReceiptWriteResult> {
  const parsed = publicationReceiptSchema.safeParse(receiptInput);
  if (!parsed.success) {
    throw new AppError('Refusing to write an invalid publication receipt', ExitCode.InvalidConfiguration, {
      issues: parsed.error.issues,
    });
  }
  const path = publicationReceiptPath(articlesDirectory, parsed.data.dayNumber);
  const existing = await readPublicationReceipt(path);
  if (existing) {
    if (existing.articleId !== parsed.data.articleId || existing.articleUrl !== parsed.data.articleUrl) {
      throw new AppError('Publication receipt conflicts with a different public article', ExitCode.SafetyConflict, {
        path,
        existingArticleId: existing.articleId,
        newArticleId: parsed.data.articleId,
      });
    }
    return { path, receipt: existing, changed: false };
  }

  await mkdir(join(articlesDirectory, dayDirectoryName(parsed.data.dayNumber)), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
  return { path, receipt: parsed.data, changed: true };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error;
}
