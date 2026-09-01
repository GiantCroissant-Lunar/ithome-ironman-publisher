import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { loadArticleForDay, renderArticleWithAssets } from '../src/content/article.js';
import { AppError, ExitCode } from '../src/infra/errors.js';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createArticle(markdown: string, image = true): Promise<string> {
  const articlesDirectory = await mkdtemp(join(tmpdir(), 'ironman-content-'));
  temporaryDirectories.push(articlesDirectory);
  const dayDirectory = join(articlesDirectory, 'day-001');
  await mkdir(dayDirectory);
  await writeFile(join(dayDirectory, 'index.md'), markdown, 'utf8');
  if (image) {
    await writeFile(join(dayDirectory, 'ref-image-001.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  }
  return articlesDirectory;
}

const validMarkdown = `---
title: Test article
timestamp: "2026-09-01T10:17:00+08:00"
tags:
  - Playwright
---

# Test

![Reference](./ref-image-001.png)
`;

describe('local article content', () => {
  it('loads strict frontmatter and resolves a colocated image', async () => {
    const articlesDirectory = await createArticle(validMarkdown);
    const article = await loadArticleForDay(articlesDirectory, 1);
    expect(article).toMatchObject({
      dayNumber: 1,
      title: 'Test article',
      timestamp: '2026-09-01T10:17:00+08:00',
      tags: ['Playwright'],
    });
    expect(article.images).toHaveLength(1);
    expect(article.images[0]?.markdownReference).toBe('./ref-image-001.png');
    expect(article.sourceHash).toMatch(/^[a-f\d]{64}$/u);
    const rendered = renderArticleWithAssets(article, {
      './ref-image-001.png': {
        sha256: article.images[0]?.sha256 ?? '',
        remoteUrl: 'https://example.test/ref-image-001.png',
      },
    });
    expect(rendered.markdown).toContain('https://example.test/ref-image-001.png');
    expect(rendered.renderedHash).toMatch(/^[a-f\d]{64}$/u);
  });

  it('requires timestamp to include seconds and an explicit timezone', async () => {
    const invalid = validMarkdown.replace('"2026-09-01T10:17:00+08:00"', '"2026-09-01 10:17"');
    const articlesDirectory = await createArticle(invalid);
    const error = await loadArticleForDay(articlesDirectory, 1).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.InvalidConfiguration);
  });

  it('fails when a referenced local image is missing', async () => {
    const articlesDirectory = await createArticle(validMarkdown, false);
    const error = await loadArticleForDay(articlesDirectory, 1).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.InvalidConfiguration);
  });

  it('rejects image references that escape the day directory', async () => {
    const invalid = validMarkdown.replace('./ref-image-001.png', '../secret.png');
    const articlesDirectory = await createArticle(invalid);
    const error = await loadArticleForDay(articlesDirectory, 1).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(AppError);
    expect((error as AppError).exitCode).toBe(ExitCode.InvalidConfiguration);
  });
});
