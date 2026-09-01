import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, win32 } from 'node:path';
import matter from 'gray-matter';
import { z } from 'zod';
import { AppError, ExitCode } from '../infra/errors.js';
import type { ArticleAssetState } from '../state/publisher-state.js';

const DAY_DIRECTORY_PATTERN = /^day-(?<day>\d{3})$/u;
const RFC3339_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u;
const MARKDOWN_IMAGE_PATTERN = /!\[[^\]]*\]\((?<target><[^>]+>|[^\s)]+)(?:\s+["'][^"']*["'])?\)/gu;
const ARTICLE_HASH_VERSION = 'ithome-ironman-publisher:article:v1';

const timestampSchema = z.preprocess(
  (value) => (value instanceof Date ? value.toISOString() : value),
  z.string().refine(
    (value) => RFC3339_WITH_ZONE.test(value) && Number.isFinite(Date.parse(value)),
    'timestamp must be RFC 3339 with seconds and an explicit offset, for example 2026-09-01T10:17:00+08:00',
  ),
);

const frontmatterSchema = z
  .object({
    title: z.string().trim().min(1),
    timestamp: timestampSchema,
    tags: z.array(z.string().trim().min(1)).min(1).max(10),
  })
  .strict();

const supportedImages: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
};

export interface ArticleImageAsset {
  markdownReference: string;
  absolutePath: string;
  mimeType: string;
  sha256: string;
}

export interface LocalArticle {
  dayNumber: number;
  directoryPath: string;
  sourcePath: string;
  title: string;
  timestamp: string;
  scheduledAt: Date;
  tags: string[];
  markdown: string;
  images: ArticleImageAsset[];
  sourceHash: string;
}

export interface RenderedArticle {
  markdown: string;
  renderedHash: string;
}

export function dayDirectoryName(dayNumber: number): string {
  if (!Number.isInteger(dayNumber) || dayNumber < 1 || dayNumber > 999) {
    throw new AppError('Article day number must be between 1 and 999', ExitCode.InvalidConfiguration, { dayNumber });
  }
  return `day-${String(dayNumber).padStart(3, '0')}`;
}

export async function loadArticleForDay(articlesDirectory: string, dayNumber: number): Promise<LocalArticle> {
  const directoryPath = resolve(articlesDirectory, dayDirectoryName(dayNumber));
  const sourcePath = resolve(directoryPath, 'index.md');
  let source: string;
  try {
    source = await readFile(sourcePath, 'utf8');
  } catch {
    throw new AppError('Article index.md could not be read', ExitCode.InvalidConfiguration, {
      dayNumber,
      sourcePath,
    });
  }

  const parsed = matter(source);
  const frontmatter = frontmatterSchema.safeParse(parsed.data);
  if (!frontmatter.success) {
    throw new AppError('Article frontmatter validation failed', ExitCode.InvalidConfiguration, {
      dayNumber,
      sourcePath,
      issues: frontmatter.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
    });
  }

  const markdown = normalizeMarkdown(parsed.content);
  if (!markdown) {
    throw new AppError('Article Markdown body is empty', ExitCode.InvalidConfiguration, { dayNumber, sourcePath });
  }

  const images = await collectLocalImages(markdown, directoryPath, sourcePath);
  const sourceHash = hashArticle(
    frontmatter.data.title,
    frontmatter.data.timestamp,
    frontmatter.data.tags,
    markdown,
    images.map((image) => [image.markdownReference, image.sha256]),
  );

  return {
    dayNumber,
    directoryPath,
    sourcePath,
    title: frontmatter.data.title,
    timestamp: frontmatter.data.timestamp,
    scheduledAt: new Date(frontmatter.data.timestamp),
    tags: frontmatter.data.tags,
    markdown,
    images,
    sourceHash,
  };
}

export function renderArticleWithAssets(
  article: LocalArticle,
  assets: Readonly<Record<string, ArticleAssetState>>,
): RenderedArticle {
  let renderedMarkdown = article.markdown;
  for (const image of article.images) {
    const asset = assets[image.markdownReference];
    if (!asset || asset.sha256 !== image.sha256) {
      throw new AppError('A current hosted URL is missing for a local image', ExitCode.VerificationFailed, {
        dayNumber: article.dayNumber,
        markdownReference: image.markdownReference,
      });
    }
    renderedMarkdown = renderedMarkdown.replaceAll(image.markdownReference, asset.remoteUrl);
  }
  const markdown = normalizeMarkdown(renderedMarkdown);
  return {
    markdown,
    renderedHash: hashArticle(article.title, article.timestamp, article.tags, markdown, []),
  };
}

export async function loadAllArticles(articlesDirectory: string): Promise<LocalArticle[]> {
  let entries;
  try {
    entries = await readdir(articlesDirectory, { withFileTypes: true });
  } catch {
    throw new AppError('Articles directory could not be read', ExitCode.InvalidConfiguration, { articlesDirectory });
  }

  const dayNumbers: number[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith('day-')) {
      continue;
    }
    const match = DAY_DIRECTORY_PATTERN.exec(entry.name);
    if (!match?.groups) {
      throw new AppError('Article directory must use day-NNN naming', ExitCode.InvalidConfiguration, {
        directoryName: entry.name,
      });
    }
    const dayNumber = Number(match.groups.day);
    if (dayNumber < 1) {
      throw new AppError('Article day number must start at 001', ExitCode.InvalidConfiguration, {
        directoryName: entry.name,
      });
    }
    dayNumbers.push(dayNumber);
  }

  if (new Set(dayNumbers).size !== dayNumbers.length) {
    throw new AppError('Duplicate article day directories were found', ExitCode.InvalidConfiguration);
  }

  return Promise.all(dayNumbers.sort((left, right) => left - right).map((dayNumber) => loadArticleForDay(articlesDirectory, dayNumber)));
}

async function collectLocalImages(
  markdown: string,
  directoryPath: string,
  sourcePath: string,
): Promise<ArticleImageAsset[]> {
  const references = new Set<string>();
  for (const match of markdown.matchAll(MARKDOWN_IMAGE_PATTERN)) {
    const rawTarget = match.groups?.target;
    if (!rawTarget) {
      continue;
    }
    const target = rawTarget.startsWith('<') && rawTarget.endsWith('>') ? rawTarget.slice(1, -1) : rawTarget;
    if (/^(?:https?:|data:|\/\/)/iu.test(target)) {
      continue;
    }
    references.add(target);
  }

  const assets: ArticleImageAsset[] = [];
  for (const markdownReference of references) {
    let decodedReference: string;
    try {
      decodedReference = decodeURIComponent(markdownReference);
    } catch {
      throw new AppError('Markdown image path is not valid URI encoding', ExitCode.InvalidConfiguration, {
        sourcePath,
        markdownReference,
      });
    }

    if (isAbsolute(decodedReference) || win32.isAbsolute(decodedReference)) {
      throw new AppError('Local Markdown images must use a relative path', ExitCode.InvalidConfiguration, {
        sourcePath,
        markdownReference,
      });
    }
    const absolutePath = resolve(directoryPath, decodedReference);
    const relativePath = relative(directoryPath, absolutePath);
    if (relativePath.startsWith('..') || isAbsolute(relativePath)) {
      throw new AppError('Markdown image path must stay inside its day-NNN directory', ExitCode.InvalidConfiguration, {
        sourcePath,
        markdownReference,
      });
    }

    const mimeType = supportedImages[extname(absolutePath).toLowerCase()];
    if (!mimeType) {
      throw new AppError('Markdown image uses an unsupported file extension', ExitCode.InvalidConfiguration, {
        sourcePath,
        markdownReference,
      });
    }

    let bytes: Buffer;
    try {
      const file = await stat(absolutePath);
      if (!file.isFile()) {
        throw new Error('Not a regular file');
      }
      bytes = await readFile(absolutePath);
    } catch {
      throw new AppError('Referenced Markdown image could not be read', ExitCode.InvalidConfiguration, {
        sourcePath,
        markdownReference,
        absolutePath,
      });
    }

    assets.push({
      markdownReference,
      absolutePath,
      mimeType,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  }
  return assets;
}

function normalizeMarkdown(value: string): string {
  return `${value.replace(/^\uFEFF/u, '').replaceAll('\r\n', '\n').normalize('NFC').trim()}\n`;
}

function hashArticle(
  title: string,
  timestamp: string,
  tags: string[],
  markdown: string,
  assets: Array<[string, string]>,
): string {
  const canonical = {
    version: ARTICLE_HASH_VERSION,
    title: title.normalize('NFC'),
    timestamp,
    tags: [...tags].map((tag) => tag.normalize('NFC')).sort(),
    markdown: normalizeMarkdown(markdown),
    assets: [...assets]
      .map(([path, sha256]) => ({ path: path.replaceAll('\\', '/').normalize('NFC'), sha256 }))
      .sort((left, right) => left.path.localeCompare(right.path)),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
